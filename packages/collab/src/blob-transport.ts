/**
 * `BlobTransport` — the client end of the `galley-blob-v1` byte channel
 * (Phase 1 byte-transport epic; hardened in the Security/Code-Review rework). It
 * mirrors {@link WebSocketTransport}'s injection + reconnect discipline (a
 * factory-supplied {@link WebSocketLike}, capped exponential backoff) but speaks
 * the blob FRAME protocol (`blob-protocol.ts`).
 *
 * HONEST COMPLETION (rework §A). A push resolves ONLY on a terminal COMPLETE frame
 * — emitted by the receiver exclusively after full reassembly + verifyBlob
 * (size + sha256) + store all succeed. A bare data-ACK NEVER resolves a push; ACK
 * is flow-control only (cumulative, contiguous-prefix). So a resolved `putBlob`
 * means the peer genuinely holds the verified bytes. Every push settles EXACTLY
 * once (resolve on COMPLETE, XOR reject on ABORT / idle-timeout / final
 * disconnect) and is guarded so it can never hang.
 *
 * ACCEPTANCE GATING (rework §E13). A receiver stores/buffers a blob ONLY when its
 * {hash,size} matches a registered {@link BlobTransport.expect}. An unexpected
 * inbound transfer is ABORTED and never reaches the store — this turns PUSH into
 * a handshake-gated flow and kills unsolicited-blob spam. A receiver byte quota
 * (rework §E15) bounds total outstanding expected bytes.
 *
 * It never trusts a peer: every header is cap-checked, every reassembly is
 * verified, every buffer is bounded, and live-transferId reuse is treated as a
 * protocol conflict (abort) rather than a silent clobber.
 *
 * Dependency-free: like WebSocketTransport it references only the structural
 * `WebSocketLike`, so `@galley/collab` stays network-library-free.
 */

import type { WebSocketLike, SchedulerLike } from "./websocket-transport.js";
import {
  encodeFrame,
  decodeFrame,
  verifyBlob,
  concatChunks,
  planTransfer,
  isValidHash,
  isValidMime,
  isValidTransferId,
  expectedChunks,
  deriveBlobTerminalKey,
  signBlobTerminal,
  verifyBlobTerminal,
  type BlobFrame,
  type HeaderFrame,
  type AbortFrame,
  type CompleteFrame,
  type BlobTerminalKind,
  type BlobTerminalScope,
  BLOB_ACK_WINDOW,
  BLOB_MAX_INFLIGHT_TRANSFERS,
  BLOB_MAX_TRANSFER_BYTES,
  BLOB_IDLE_TRANSFER_MS,
} from "./blob-protocol.js";

const OPEN = 1; // WebSocket.OPEN

/** A verified, reassembled blob delivered to the consumer. */
export interface ReceivedBlob {
  bytes: Uint8Array;
  hash: string;
  size: number;
  mime: string;
  /**
   * The transferId the blob arrived under (A1 export channel). Present when the
   * inbound transfer matched a {@link BlobTransport.expectTransfer} reservation
   * (a request-scoped pull keyed by transferId, the hash being unknown until the
   * sender computes it); undefined for the hash-expectation path. A consumer that
   * reserved by transferId reads this to correlate the blob with its RPC.
   */
  transferId?: string;
}

/** A receiver-side expectation: an inbound {hash,size} the consumer will accept. */
export interface BlobExpectation {
  hash: string;
  size: number;
}

/** Handle for an outbound transfer. `done` resolves ONLY on the receiver's COMPLETE. */
export interface BlobSendHandle {
  transferId: string;
  hash: string;
  /** Resolves on verified+stored delivery (COMPLETE); rejects on abort/timeout/disconnect. */
  done: Promise<void>;
}

/**
 * Options for {@link BlobTransport.send} (A1 export channel). `transferId` lets the
 * CALLER supply the per-transfer id instead of having one auto-minted — used when
 * a receiver RESERVED inbound capacity under a kernel-minted id BEFORE the sender
 * computed the hash (the descriptor + bytes travel on different sockets, so the id
 * is the only stable correlator). When absent the transport mints one, exactly as
 * before. A supplied id is bounded the same way an auto-minted one is.
 */
export interface BlobSendOptions {
  transferId?: string;
}

/**
 * Produce a base64url MAC for an outgoing terminal frame (rework rd3 §1). Built
 * from the grant-scoped HKDF key; only a paired peer can produce one the other
 * verifies. Resolves to undefined if signing fails (the frame goes out unsigned —
 * the receiver of an enforcing transport then rejects it, failing closed).
 */
export type BlobTerminalSigner = (
  kind: BlobTerminalKind,
  transferId: string,
  hash: string,
  size: number,
  reason: string | null,
) => Promise<string | undefined>;

/**
 * Authenticate an incoming terminal frame's MAC (rework rd3 §1). Returns true iff
 * the MAC verifies against the grant-scoped key. Total + fail-closed.
 */
export type BlobTerminalVerifier = (
  kind: BlobTerminalKind,
  transferId: string,
  hash: string,
  size: number,
  reason: string | null,
  mac: string | undefined,
) => Promise<boolean>;

/**
 * Build the {signer, verifier} pair from the grant `responseKey` + scope (rework
 * rd3 §1). Both peers (kernel + browser) derive the SAME scoped HKDF key, so each
 * can sign its outgoing terminals AND verify the other's. The key is derived ONCE
 * (memoized) — every terminal frame reuses it. Pass the result's `terminalSigner`
 * + `terminalVerifier` into a {@link BlobTransport} (or session) to ENABLE
 * enforced, authenticated completion.
 */
export function buildBlobTerminalAuth(
  responseKey: Uint8Array,
  scope: BlobTerminalScope,
): { terminalSigner: BlobTerminalSigner; terminalVerifier: BlobTerminalVerifier } {
  let keyP: ReturnType<typeof deriveBlobTerminalKey> | undefined;
  const key = (): ReturnType<typeof deriveBlobTerminalKey> => {
    if (keyP === undefined) keyP = deriveBlobTerminalKey(responseKey, scope);
    return keyP;
  };
  return {
    terminalSigner: async (kind, transferId, hash, size, reason) => {
      try {
        return await signBlobTerminal(await key(), scope, kind, transferId, hash, size, reason);
      } catch {
        return undefined; // signing failure → unsigned (an enforcing peer rejects)
      }
    },
    terminalVerifier: (kind, transferId, hash, size, reason, mac) =>
      key().then((k) => verifyBlobTerminal(k, scope, kind, transferId, hash, size, reason, mac)),
  };
}

export interface BlobTransportOptions {
  /** Called with each VERIFIED + EXPECTED inbound blob. Must not throw (wrapped). */
  onBlob?: (blob: ReceivedBlob) => void | Promise<void>;
  /** Reconnect on an unexpected drop. Default true. */
  reconnect?: boolean;
  baseDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  /** Idle-transfer expiry (ms). Default {@link BLOB_IDLE_TRANSFER_MS}. */
  idleTransferMs?: number;
  /** Max concurrent inbound transfers. Default {@link BLOB_MAX_INFLIGHT_TRANSFERS}. */
  maxInflightReceives?: number;
  /**
   * Receiver byte quota (rework §E15): the max total bytes across LIVE
   * expectations + in-flight inbound reassembly this transport will hold. A
   * registration or inbound transfer that would exceed it is refused. Default
   * 2× BLOB_MAX_TRANSFER_BYTES (room for one max transfer + headroom).
   */
  maxExpectedBytes?: number;
  /**
   * Require an `expect()` registration before accepting any inbound transfer
   * (rework §E13). Default true — the secure posture. A test/diagnostic may set
   * false to accept any verified blob (the old permissive behavior).
   */
  requireExpectation?: boolean;
  /**
   * Optional terminal-frame SIGNER (rework rd3 §1): when present, every OUTGOING
   * COMPLETE/ABORT this transport emits as a RECEIVER carries an authenticating
   * MAC. Pair with `terminalVerifier` on the same key.
   */
  terminalSigner?: BlobTerminalSigner;
  /**
   * Optional terminal-frame VERIFIER (rework rd3 §1). ENFORCE-WHEN-PRESENT: when
   * present, this transport (as a SENDER) resolves a push ONLY on a COMPLETE whose
   * MAC verifies, and ignores an unsigned/forged COMPLETE or ABORT — a forged
   * terminal from a 3rd room peer can then cause neither false success nor a
   * spurious failure. ADVISORY-WHEN-ABSENT: without it, completion is advisory and
   * forgeable by any room peer (the un-paired local path only).
   */
  terminalVerifier?: BlobTerminalVerifier;
  /** Timer seam (tests). Defaults to globalThis timers. */
  scheduler?: SchedulerLike;
  /** Monotonic clock (tests). Defaults to Date.now. */
  now?: () => number;
  /** Mint a transfer id. Defaults to a random token; injectable for tests. */
  mintTransferId?: () => string;
}

interface ResolvedOpts {
  reconnect: boolean;
  baseDelayMs: number;
  maxDelayMs: number;
  factor: number;
  idleTransferMs: number;
  maxInflightReceives: number;
  maxExpectedBytes: number;
  requireExpectation: boolean;
}
const DEFAULTS: ResolvedOpts = {
  reconnect: true,
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  factor: 2,
  idleTransferMs: BLOB_IDLE_TRANSFER_MS,
  maxInflightReceives: BLOB_MAX_INFLIGHT_TRANSFERS,
  maxExpectedBytes: BLOB_MAX_TRANSFER_BYTES * 2,
  requireExpectation: true,
};

const defaultScheduler: SchedulerLike = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

function asBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  return undefined;
}

function randomToken(): string {
  const g = globalThis.crypto;
  if (g?.getRandomValues) {
    const a = new Uint8Array(16);
    g.getRandomValues(a);
    let s = "";
    for (const b of a) s += b.toString(16).padStart(2, "0");
    return s;
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Inbound reassembly state for one transfer. Bounded by the header's caps. */
interface Inbound {
  header: HeaderFrame;
  chunks: (Uint8Array | undefined)[];
  received: number;
  bytesSoFar: number;
  /** Highest CONTIGUOUS index received so far (-1 = none) — the ACK cursor. */
  contiguous: number;
  lastActivity: number;
  /**
   * Whether THIS transfer charged the byte-quota counter itself (rework rd3 §2).
   * The reservation for an EXPECTED transfer is owned by its `expect()` entry, so
   * the transfer does NOT charge (and the expectation releases on consume); only
   * an UNEXPECTED-but-accepted transfer (requireExpectation off) charges + releases
   * its own bytes. Tracking this prevents the double-release quota bug — each
   * reservation is released EXACTLY once.
   */
  charged: boolean;
  /**
   * The transferId reservation (A1 export channel) this inbound CANDIDATE is bound
   * to, or undefined for the hash-expectation / unexpected paths. When set, the
   * PERSISTENT reservation owns the quota charge (maxBytes reserved up front), so
   * the candidate itself does NOT charge (`charged` is false). The reservation
   * STAYS OPEN across discarded candidates (rd-A1 §2) — released ONLY by
   * `unexpectTransfer` / `disconnect`, never by a candidate's delivery/abort. The
   * delivered blob carries this id so the kernel can correlate + promote it.
   */
  reservedTransferId?: string;
}

/** Outbound transfer state: the chunk queue + the contiguous-ACK window cursor. */
interface Outbound {
  header: HeaderFrame;
  data: { index: number; bytes: Uint8Array }[];
  /** Next chunk index to send. */
  nextToSend: number;
  /** Highest CONTIGUOUS index the receiver has ACKed (-1 = none). */
  acked: number;
  /** Whether the receiver has confirmed (ACKed/COMPLETEd) our HEADER yet. */
  headerConfirmed: boolean;
  lastActivity: number;
  resolve: () => void;
  reject: (err: Error) => void;
  settled: boolean;
}

export class BlobTransport {
  private socket: WebSocketLike | undefined;
  private bound:
    | { open: (e: unknown) => void; message: (e: unknown) => void; drop: (e: unknown) => void }
    | undefined;
  private wantConnected = false;
  private reconnectTimer: unknown;
  private attempt = 0;
  private sweepTimer: unknown;

  private readonly inbound = new Map<string, Inbound>();
  private readonly outbound = new Map<string, Outbound>();
  /** Live receiver-side expectations keyed by `hash:size`. */
  private readonly expectations = new Map<string, BlobExpectation>();
  /**
   * Live receiver-side transferId RESERVATIONS (A1 export channel), keyed by
   * transferId → the reserved maxBytes. The hash is unknown when a reservation is
   * made (the sender computes it later), so this gates the inbound by transferId
   * instead of by {hash,size}. The reserved maxBytes is charged against the byte
   * quota up front (exactly like an `expect()` reservation) and released — once —
   * on delivery / unexpectTransfer / abort / disconnect.
   */
  private readonly transferReservations = new Map<string, number>();
  /** Running total of bytes across live expectations + reservations + in-flight reassembly. */
  private expectedBytesOutstanding = 0;
  private readonly opts: ResolvedOpts;
  private readonly scheduler: SchedulerLike;
  private readonly now: () => number;
  private readonly mintTransferId: () => string;
  private readonly onBlob: ((blob: ReceivedBlob) => void | Promise<void>) | undefined;
  private readonly terminalSigner: BlobTerminalSigner | undefined;
  private readonly terminalVerifier: BlobTerminalVerifier | undefined;

  constructor(
    private readonly factory: () => WebSocketLike,
    options: BlobTransportOptions = {},
  ) {
    this.opts = {
      reconnect: options.reconnect ?? DEFAULTS.reconnect,
      baseDelayMs: options.baseDelayMs ?? DEFAULTS.baseDelayMs,
      maxDelayMs: options.maxDelayMs ?? DEFAULTS.maxDelayMs,
      factor: options.factor ?? DEFAULTS.factor,
      idleTransferMs: options.idleTransferMs ?? DEFAULTS.idleTransferMs,
      maxInflightReceives: options.maxInflightReceives ?? DEFAULTS.maxInflightReceives,
      maxExpectedBytes: options.maxExpectedBytes ?? DEFAULTS.maxExpectedBytes,
      requireExpectation: options.requireExpectation ?? DEFAULTS.requireExpectation,
    };
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.now = options.now ?? Date.now;
    this.mintTransferId = options.mintTransferId ?? randomToken;
    this.onBlob = options.onBlob;
    this.terminalSigner = options.terminalSigner;
    this.terminalVerifier = options.terminalVerifier;
  }

  private expKey(hash: string, size: number): string {
    return `${hash}:${size}`;
  }

  // --- Acceptance gating (rework §E13/E15) -----------------------------------

  /**
   * Register that an inbound blob with `{hash,size}` is EXPECTED. Returns false
   * (and registers nothing) if it would exceed the receiver byte quota or the
   * args are invalid. Idempotent for a {hash,size} already expected. A later
   * verified inbound transfer matching a live expectation is accepted exactly
   * once; the expectation is consumed on successful delivery.
   */
  expect(hash: string, size: number): boolean {
    if (!isValidHash(hash)) return false;
    if (!Number.isInteger(size) || size < 0 || size > BLOB_MAX_TRANSFER_BYTES) return false;
    const key = this.expKey(hash, size);
    if (this.expectations.has(key)) return true; // already expected (idempotent)
    if (this.expectedBytesOutstanding + size > this.opts.maxExpectedBytes) return false;
    this.expectations.set(key, { hash, size });
    this.expectedBytesOutstanding += size;
    return true;
  }

  /** Drop a previously-registered expectation (e.g. the consumer gave up). */
  unexpect(hash: string, size: number): void {
    const key = this.expKey(hash, size);
    if (this.expectations.delete(key)) this.expectedBytesOutstanding -= size;
  }

  /** Whether `{hash,size}` is currently expected. */
  isExpected(hash: string, size: number): boolean {
    return this.expectations.has(this.expKey(hash, size));
  }

  /**
   * Reserve inbound capacity for a transfer arriving under `transferId` whose
   * HASH IS NOT YET KNOWN (A1 export channel): the receiver mints the id, reserves
   * `maxBytes` of byte quota up front, and sends the request; the sender computes
   * the bytes + hash and pushes them under the SAME id. The first inbound HEADER
   * whose transferId matches a live reservation BINDS it (its `header.size` must be
   * `<= maxBytes`, else the transfer is aborted). Returns false (reserving nothing)
   * if the args are invalid or the reservation would exceed the receiver byte
   * quota. Idempotent for an id already reserved with the SAME maxBytes; a confl
   * icting re-reservation (same id, different maxBytes) is refused.
   */
  expectTransfer(transferId: string, maxBytes: number): boolean {
    if (!isValidTransferId(transferId)) return false;
    // maxBytes must be a POSITIVE integer within the transfer cap (rd-A1 §6): a
    // zero/negative reservation reserves no usable capacity — refuse it.
    if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > BLOB_MAX_TRANSFER_BYTES) return false;
    const existing = this.transferReservations.get(transferId);
    if (existing !== undefined) return existing === maxBytes; // idempotent iff same cap
    // A reservation must not collide with a live inbound transfer already bound to
    // this id (a sender that pushed before we reserved) — fail closed rather than
    // double-charge / clobber.
    if (this.inbound.has(transferId)) return false;
    if (this.expectedBytesOutstanding + maxBytes > this.opts.maxExpectedBytes) return false;
    this.transferReservations.set(transferId, maxBytes);
    this.expectedBytesOutstanding += maxBytes;
    return true;
  }

  /**
   * Release a transferId reservation made by {@link expectTransfer} (rd-A1 §4) —
   * the consumer gave up / the handshake deadline passed / a candidate promoted.
   * Frees the reserved quota EXACTLY once AND aborts any in-flight CANDIDATE bound
   * to this reservation, so a late delivery after withdrawal can never pin bytes
   * without accounting. A no-op when the id is unknown. Returns true iff a
   * reservation was released here.
   */
  unexpectTransfer(transferId: string): boolean {
    const reserved = this.transferReservations.get(transferId);
    if (reserved === undefined) return false;
    // Abort any in-flight candidate bound to this reservation FIRST. A
    // reservation-bound candidate carries no quota of its own (the reservation
    // owns the maxBytes), so this only drops its reassembly buffer + emits ABORT —
    // it never double-frees the reservation (that happens just below).
    const inb = this.inbound.get(transferId);
    if (inb !== undefined && inb.reservedTransferId === transferId) {
      this.inbound.delete(transferId);
      void this.emitTerminal("abort", transferId, inb.header.hash, inb.header.size, "withdrawn");
    }
    this.transferReservations.delete(transferId);
    this.expectedBytesOutstanding -= reserved;
    return true;
  }

  /** Whether a transferId reservation is currently live (tests/observability). */
  isTransferExpected(transferId: string): boolean {
    return this.transferReservations.has(transferId);
  }

  // --- Lifecycle -------------------------------------------------------------

  connect(): void {
    if (this.socket !== undefined) return;
    this.wantConnected = true;
    this.attempt = 0;
    this.openSocket();
    this.startSweep();
  }

  private openSocket(): void {
    const socket = this.factory();
    socket.binaryType = "arraybuffer";
    const open = (): void => {
      this.attempt = 0;
      // Resume outbound transfers that were mid-flight before a (re)connect. A
      // send-before-open or a drop before the first ACK could otherwise strand
      // the receiver: re-send the HEADER if it isn't confirmed, then re-prime the
      // window from the last contiguous ACK (rework §B5).
      for (const out of this.outbound.values()) {
        if (out.settled) continue;
        if (!out.headerConfirmed) this.send_(out.header);
        out.nextToSend = out.acked + 1;
        this.pump(out);
      }
    };
    const message = (event: unknown): void => {
      const data = asBytes((event as { data?: unknown }).data);
      if (data !== undefined) this.onFrameBytes(data);
    };
    const drop = (): void => this.handleDrop(socket);
    socket.addEventListener("open", open);
    socket.addEventListener("message", message);
    socket.addEventListener("close", drop);
    socket.addEventListener("error", drop);
    this.bound = { open, message, drop };
    this.socket = socket;
  }

  private handleDrop(socket: WebSocketLike): void {
    if (this.socket !== socket) return;
    this.unbind(socket);
    this.socket = undefined;
    // Inbound reassembly cannot survive a socket loss (the sender restarts on its
    // own reconnect); drop partial transfers + release their reserved bytes.
    this.clearInbound();
    if (!this.wantConnected || !this.opts.reconnect) {
      // No reconnect coming: fail outstanding sends so callers don't hang.
      this.failAllOutbound(new Error("blob channel disconnected"));
      return;
    }
    const delay = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * this.opts.factor ** this.attempt);
    this.attempt += 1;
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.wantConnected && this.socket === undefined) this.openSocket();
    }, delay);
  }

  private unbind(socket: WebSocketLike): void {
    if (this.bound !== undefined) {
      socket.removeEventListener("open", this.bound.open);
      socket.removeEventListener("message", this.bound.message);
      socket.removeEventListener("close", this.bound.drop);
      socket.removeEventListener("error", this.bound.drop);
    }
    this.bound = undefined;
  }

  disconnect(): void {
    this.wantConnected = false;
    if (this.reconnectTimer !== undefined) {
      this.scheduler.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.sweepTimer !== undefined) {
      this.scheduler.clearTimeout(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    this.clearInbound();
    this.failAllOutbound(new Error("blob channel closed"));
    // Release all expectations + reservations + their reserved quota (leak-free).
    this.expectations.clear();
    this.transferReservations.clear();
    this.expectedBytesOutstanding = 0;
    const socket = this.socket;
    if (socket !== undefined) {
      this.unbind(socket);
      this.socket = undefined;
      try {
        socket.close();
      } catch {
        /* closing a closing socket is fine */
      }
    }
  }

  /**
   * Remove ONE inbound transfer and release its quota charge EXACTLY once (rework
   * rd3 §2). Releases only if the transfer charged its own reservation (an
   * expected transfer's reservation belongs to the expectation, freed separately).
   * Returns the removed entry (or undefined if absent — a double call is a no-op).
   */
  private releaseInbound(transferId: string): Inbound | undefined {
    const inb = this.inbound.get(transferId);
    if (inb === undefined) return undefined;
    this.inbound.delete(transferId);
    if (inb.charged) this.expectedBytesOutstanding -= inb.header.size;
    // A1 export channel (rd-A1 §2): a reservation-bound candidate carries NO quota
    // of its own — the persistent reservation owns the maxBytes and is released ONLY
    // by `unexpectTransfer` / `disconnect` (the reservation stays OPEN across
    // discarded candidates so the real browser's transfer can still arrive +
    // promote). So this never touches `transferReservations`.
    return inb;
  }

  /**
   * Drop all in-flight inbound reassembly + release the bytes a SELF-CHARGED
   * transfer reserved. Transfer RESERVATIONS persist (rd-A1 §2): a socket drop kills
   * partial reassembly, but the kernel's export reservation must survive a reconnect
   * so the transfer can resume — only `disconnect`/`unexpectTransfer` release it.
   */
  private clearInbound(): void {
    for (const inb of this.inbound.values()) {
      if (inb.charged) this.expectedBytesOutstanding -= inb.header.size;
    }
    this.inbound.clear();
  }

  private send_(frame: BlobFrame): boolean {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== OPEN) return false;
    try {
      socket.send(encodeFrame(frame));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Emit a RECEIVER-side terminal frame (COMPLETE or ABORT), signing it when a
   * terminalSigner is configured (rework rd3 §1). hash+size bind the MAC to the
   * specific transfer's content. A signing failure emits the frame UNSIGNED — an
   * enforcing sender then rejects it, failing closed.
   */
  private async emitTerminal(
    kind: BlobTerminalKind,
    transferId: string,
    hash: string,
    size: number,
    reason: string | null,
  ): Promise<void> {
    let mac: string | undefined;
    if (this.terminalSigner !== undefined) {
      try {
        mac = await this.terminalSigner(kind, transferId, hash, size, reason);
      } catch {
        mac = undefined;
      }
    }
    if (kind === "complete") {
      const frame: CompleteFrame = { kind: "complete", transferId, hash, size, ...(mac ? { mac } : {}) };
      this.send_(frame);
    } else {
      const frame: AbortFrame = { kind: "abort", transferId, reason: reason ?? "abort", ...(mac ? { mac } : {}) };
      this.send_(frame);
    }
  }

  // --- Sender ----------------------------------------------------------------

  /**
   * Push a blob to the room's other peers. `done` resolves ONLY when the receiver
   * sends COMPLETE (verified + stored); it rejects on abort/timeout/disconnect.
   * Caller-side validation errors REJECT immediately (rework §C10) rather than
   * opening state that times out.
   */
  send(bytes: Uint8Array, hash: string, mime: string, opts: BlobSendOptions = {}): BlobSendHandle {
    // §C10: validate BEFORE storing outbound state — bad args fail fast.
    if (!isValidHash(hash)) {
      return { transferId: "", hash, done: Promise.reject(new Error("blob send: hash must be 64 lowercase hex")) };
    }
    if (!isValidMime(mime)) {
      return { transferId: "", hash, done: Promise.reject(new Error("blob send: mime too long")) };
    }
    if (bytes.length > BLOB_MAX_TRANSFER_BYTES) {
      return {
        transferId: "",
        hash,
        done: Promise.reject(new Error(`blob exceeds BLOB_MAX_TRANSFER_BYTES (${bytes.length})`)),
      };
    }
    // A1 export channel: honor a CALLER-SUPPLIED transferId (the receiver minted it
    // to RESERVE inbound capacity before we computed the hash). Validate it like an
    // auto-minted one; a bad id fails fast. A live id collision (an already-open
    // outbound under the same id) is refused rather than clobbered.
    if (opts.transferId !== undefined) {
      if (!isValidTransferId(opts.transferId)) {
        return { transferId: "", hash, done: Promise.reject(new Error("blob send: transferId invalid")) };
      }
      if (this.outbound.has(opts.transferId)) {
        return { transferId: opts.transferId, hash, done: Promise.reject(new Error("blob send: transferId already in flight")) };
      }
    }
    const transferId = opts.transferId ?? this.mintTransferId();
    // Defensive copy: the caller's buffer may be reused before chunks flush.
    const copy = bytes.slice();
    const { header, data } = planTransfer(transferId, copy, hash, mime);
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const done = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const out: Outbound = {
      header,
      data: data.map((d) => ({ index: d.index, bytes: d.bytes })),
      nextToSend: 0,
      acked: -1,
      headerConfirmed: false,
      lastActivity: this.now(),
      resolve,
      reject,
      settled: false,
    };
    this.outbound.set(transferId, out);
    // HEADER first, then pump the windowed DATA frames. We DO NOT self-resolve
    // here — not even an empty (zero-chunk) blob: the sender waits for the
    // receiver's terminal COMPLETE (rework §A3). The idle sweep guards against a
    // peer that never answers, so `done` always settles.
    this.send_(header);
    this.pump(out);
    return { transferId, hash, done };
  }

  /** Send up to the ACK window's worth of un-sent chunks for one transfer. */
  private pump(out: Outbound): void {
    if (out.settled) return;
    const windowEnd = out.acked + BLOB_ACK_WINDOW;
    while (out.nextToSend < out.data.length && out.nextToSend <= windowEnd) {
      const chunk = out.data[out.nextToSend];
      if (chunk === undefined) break; // bounds-guarded by the loop condition
      const ok = this.send_({ kind: "data", transferId: out.header.transferId, index: chunk.index, bytes: chunk.bytes });
      if (!ok) return; // socket not open; resume on reconnect
      out.nextToSend += 1;
      out.lastActivity = this.now();
    }
  }

  private settleOutbound(out: Outbound, success: boolean, err?: Error): void {
    if (out.settled) return;
    out.settled = true;
    this.outbound.delete(out.header.transferId);
    if (success) out.resolve();
    else out.reject(err ?? new Error("transfer aborted"));
  }

  private failAllOutbound(err: Error): void {
    for (const out of [...this.outbound.values()]) this.settleOutbound(out, false, err);
  }

  // --- Receiver --------------------------------------------------------------

  private onFrameBytes(bytes: Uint8Array): void {
    let frame: BlobFrame;
    try {
      frame = decodeFrame(bytes);
    } catch {
      // Malformed/over-cap frame: drop it (a hostile peer can't crash us). The
      // relay's rate limit bounds a flood; an honest peer never sends these.
      return;
    }
    switch (frame.kind) {
      case "header":
        this.onHeader(frame);
        break;
      case "data":
        this.onData(frame);
        break;
      case "ack":
        this.onAck(frame);
        break;
      case "abort":
        this.onAbort(frame);
        break;
      case "complete":
        this.onComplete(frame);
        break;
    }
  }

  /**
   * Receiver-side ABORT of an in-flight inbound transfer: frees the charge once
   * and emits a (signed, when a signer is configured) ABORT bound to the
   * transfer's hash+size so the sender can authenticate it. `hint` supplies
   * hash/size when the inbound entry is already gone or never existed.
   */
  private abortInbound(transferId: string, reason: string, hint?: { hash: string; size: number }): void {
    const inb = this.releaseInbound(transferId); // frees the charge exactly once
    const hash = inb?.header.hash ?? hint?.hash ?? "0".repeat(64);
    const size = inb?.header.size ?? hint?.size ?? 0;
    void this.emitTerminal("abort", transferId, hash, size, reason);
  }

  private onHeader(header: HeaderFrame): void {
    const existing = this.inbound.get(header.transferId);
    if (existing !== undefined) {
      // A duplicate HEADER that EXACTLY matches the live transfer is a harmless
      // (re)connect retransmit — re-ACK our progress so the sender resyncs.
      if (existing.header.hash === header.hash && existing.header.size === header.size) {
        this.send_({ kind: "ack", transferId: header.transferId, index: existing.contiguous });
        return;
      }
      // A1 export channel (rd-A1 §2): a reservation accepts SEQUENTIAL candidates,
      // so a racing duplicate header (different content) while a candidate is still
      // in-flight must NOT clobber the legitimate in-flight candidate. DROP the new
      // header (a forged racer is ignored); the in-flight candidate completes and is
      // delivered for the kernel to promote/discard, and a genuine next candidate
      // starts only AFTER this one finishes.
      if (existing.reservedTransferId === header.transferId) return;
      // Otherwise (the non-reservation path): a duplicate transferId with DIFFERENT
      // contents is a protocol CONFLICT (rework §B6) — never silently clobber the
      // in-flight receive. Abort it.
      this.abortInbound(header.transferId, "transferid-conflict");
      return;
    }
    // A1 export channel: a live transferId RESERVATION accepts this header even
    // when {hash,size} is not separately expected (the receiver minted the id and
    // reserved capacity BEFORE the sender computed the hash). Bind it here.
    const reservedMaxBytes = this.transferReservations.get(header.transferId);
    const reservationBound = reservedMaxBytes !== undefined;
    // §E13 acceptance gating: refuse a transfer that matches NEITHER a hash
    // expectation NOR a transferId reservation (expect-gating preserved).
    if (
      this.opts.requireExpectation &&
      !this.isExpected(header.hash, header.size) &&
      !reservationBound
    ) {
      void this.emitTerminal("abort", header.transferId, header.hash, header.size, "unexpected");
      return;
    }
    // Bound concurrent inbound transfers (DoS): refuse a new one past the cap.
    if (this.inbound.size >= this.opts.maxInflightReceives) {
      void this.emitTerminal("abort", header.transferId, header.hash, header.size, "too-many-inflight");
      return;
    }
    // decodeFrame already enforced size <= cap + exact totalChunks, but re-assert
    // before allocating the chunk array (belt-and-braces).
    if (header.size > BLOB_MAX_TRANSFER_BYTES || header.totalChunks !== expectedChunks(header.size)) {
      void this.emitTerminal("abort", header.transferId, header.hash, header.size, "bad-header");
      return;
    }
    // A reservation caps the inbound at its reserved maxBytes: a header declaring
    // MORE than was reserved is a contract breach — abort (the reservation stays
    // live for a conformant retry; releasing it here would let a hostile oversize
    // header cancel the legitimate transfer).
    if (reservationBound && header.size > reservedMaxBytes!) {
      void this.emitTerminal("abort", header.transferId, header.hash, header.size, "exceeds-reserved");
      return;
    }
    // §E15 byte quota (rework rd3 §2 — release EXACTLY once). The reservation for
    // an EXPECTED transfer is already held by its `expect()` entry, so the
    // transfer does NOT charge again (charged=false) and the expectation's
    // reservation is released when the expectation is consumed/withdrawn. A
    // transferId-RESERVED transfer likewise does NOT charge (the reservation's
    // maxBytes is already counted; released on delivery via releaseInbound). An
    // UNEXPECTED-but-accepted transfer (requireExpectation off) charges its OWN
    // reservation here and releases it itself (charged=true).
    const alreadyReserved = this.isExpected(header.hash, header.size) || reservationBound;
    let charged = false;
    if (!alreadyReserved) {
      if (this.expectedBytesOutstanding + header.size > this.opts.maxExpectedBytes) {
        void this.emitTerminal("abort", header.transferId, header.hash, header.size, "quota-exceeded");
        return;
      }
      this.expectedBytesOutstanding += header.size;
      charged = true;
    }
    this.inbound.set(header.transferId, {
      header,
      chunks: new Array(header.totalChunks),
      received: 0,
      bytesSoFar: 0,
      contiguous: -1,
      lastActivity: this.now(),
      charged,
      ...(reservationBound ? { reservedTransferId: header.transferId } : {}),
    });
    // A zero-chunk (empty) transfer is fully received on its header alone.
    if (header.totalChunks === 0) void this.finishInbound(header.transferId);
  }

  private onData(frame: { transferId: string; index: number; bytes: Uint8Array }): void {
    const inb = this.inbound.get(frame.transferId);
    if (inb === undefined) return; // no header / already finished / aborted
    if (frame.index < 0 || frame.index >= inb.header.totalChunks) {
      this.abortInbound(frame.transferId, "bad-index");
      return;
    }
    if (inb.chunks[frame.index] !== undefined) {
      // Duplicate chunk (a reconnect resend): re-ACK our contiguous prefix so the
      // sender advances, but don't double-count toward completion.
      this.send_({ kind: "ack", transferId: frame.transferId, index: inb.contiguous });
      return;
    }
    // Running byte ceiling: a peer can't exceed its declared size (anti-DoS).
    if (inb.bytesSoFar + frame.bytes.length > inb.header.size) {
      this.abortInbound(frame.transferId, "exceeds-declared-size");
      return;
    }
    inb.chunks[frame.index] = frame.bytes;
    inb.received += 1;
    inb.bytesSoFar += frame.bytes.length;
    inb.lastActivity = this.now();
    // Advance the CONTIGUOUS cursor over any now-filled prefix (rework §A2). ACK
    // carries the highest contiguous index, NOT this arbitrary index — so an
    // out-of-order chunk doesn't falsely advance the sender's window.
    while (inb.contiguous + 1 < inb.header.totalChunks && inb.chunks[inb.contiguous + 1] !== undefined) {
      inb.contiguous += 1;
    }
    this.send_({ kind: "ack", transferId: frame.transferId, index: inb.contiguous });
    if (inb.received === inb.header.totalChunks) void this.finishInbound(frame.transferId);
  }

  private async finishInbound(transferId: string): Promise<void> {
    // Detach before the async verify so a late/duplicate frame can't re-enter.
    // releaseInbound frees the transfer's OWN charge (if any) exactly once; an
    // EXPECTED transfer's reservation is freed below when its expectation is
    // consumed via unexpect — never both (rework rd3 §2).
    const inb = this.releaseInbound(transferId);
    if (inb === undefined) return;
    const ordered: Uint8Array[] = [];
    for (let i = 0; i < inb.header.totalChunks; i++) {
      const c = inb.chunks[i];
      if (c === undefined) {
        // A gap (shouldn't happen once received === totalChunks, but be safe).
        void this.emitTerminal("abort", transferId, inb.header.hash, inb.header.size, "missing-chunk");
        return;
      }
      ordered.push(c);
    }
    const reassembled = concatChunks(ordered);
    // ANTI-POISONING: verify sha256 + size BEFORE exposing/storing. A mismatch
    // discards the WHOLE transfer; content addressing means a peer cannot forge
    // bytes that hash to the declared (already-trusted) hash.
    let ok = false;
    try {
      ok = await verifyBlob(reassembled, inb.header);
    } catch {
      ok = false;
    }
    if (!ok) {
      void this.emitTerminal("abort", transferId, inb.header.hash, inb.header.size, "verify-failed");
      return;
    }
    // §E13 acceptance + rd-A1 §3 (dual-match quota leak fix): the blob is accepted
    // iff it is still expected by EITHER a hash-expectation OR a live transferId
    // reservation. Consume the hash-expectation WHENEVER one exists (independent of
    // the reservation), so a transfer that matched BOTH does not leak the
    // expectation + its quota. The transferId RESERVATION is NOT consumed here — it
    // stays OPEN to keep accepting candidates until the kernel promotes/withdraws it
    // (rd-A1 §2). A reservation-bound transfer with NO hash-expectation is accepted
    // on the reservation alone.
    if (this.opts.requireExpectation) {
      const hashExpected = this.isExpected(inb.header.hash, inb.header.size);
      const stillReserved =
        inb.reservedTransferId !== undefined && this.transferReservations.has(inb.reservedTransferId);
      if (!hashExpected && !stillReserved) {
        void this.emitTerminal("abort", transferId, inb.header.hash, inb.header.size, "unexpected");
        return;
      }
      // Consume the hash-expectation if present (exactly once) — the reservation
      // persists for further candidates.
      if (hashExpected) this.unexpect(inb.header.hash, inb.header.size);
    }
    // STORE FIRST, then signal terminal success. onBlob is the store hook; we
    // only send COMPLETE after it resolves, so the sender's `done` resolving
    // means the peer genuinely persisted the verified bytes (rework §A1). A store
    // failure does NOT send COMPLETE — the sender will idle-timeout/reject. The
    // COMPLETE is SIGNED (when a signer is configured) so a forged COMPLETE from a
    // 3rd room peer cannot cause a false success (rework rd3 §1).
    if (this.onBlob !== undefined) {
      try {
        await this.onBlob({
          bytes: reassembled,
          hash: inb.header.hash,
          size: inb.header.size,
          mime: inb.header.mime,
          ...(inb.reservedTransferId !== undefined ? { transferId: inb.reservedTransferId } : {}),
        });
      } catch {
        void this.emitTerminal("abort", transferId, inb.header.hash, inb.header.size, "store-failed");
        return;
      }
    }
    void this.emitTerminal("complete", transferId, inb.header.hash, inb.header.size, null);
  }

  /**
   * Flow-control ONLY (rework §A2). The receiver ACKs its highest CONTIGUOUS
   * index. We advance the window only on an in-range, monotonically-advancing
   * contiguous ACK and IGNORE anything out of range (e.g. an ACK index >= the
   * chunk count, the 0xffffffff instant-complete attack). An ACK NEVER resolves
   * the push — only COMPLETE does.
   */
  private onAck(frame: { transferId: string; index: number }): void {
    const out = this.outbound.get(frame.transferId);
    if (out === undefined || out.settled) return;
    // Any valid ACK confirms the header reached the receiver.
    out.headerConfirmed = true;
    // Ignore an out-of-range ACK: it must be within [-? , data.length-1]. An ACK
    // of -1 (header-only resync) is allowed and advances nothing.
    if (frame.index < -1 || frame.index >= out.data.length) return;
    if (frame.index > out.acked) out.acked = frame.index;
    out.lastActivity = this.now();
    this.pump(out);
  }

  private onComplete(frame: CompleteFrame): void {
    const out = this.outbound.get(frame.transferId);
    if (out === undefined || out.settled) return;
    // Terminal SUCCESS — the receiver verified + stored. The ONLY path that
    // resolves a push (rework §A1). ENFORCE-WHEN-PRESENT (rework rd3 §1): with a
    // terminalVerifier configured, resolve ONLY if (a) the frame's hash+size match
    // OUR transfer's header (a COMPLETE for different content is bogus) AND (b) the
    // MAC verifies. A forged/unsigned COMPLETE is IGNORED — the push stays
    // unresolved and fails closed via the idle sweep. Without a verifier,
    // completion is ADVISORY (forgeable): resolve as before.
    if (this.terminalVerifier !== undefined) {
      if (frame.hash !== out.header.hash || frame.size !== out.header.size) return;
      const verifier = this.terminalVerifier;
      void verifier("complete", frame.transferId, frame.hash, frame.size, null, frame.mac).then((okay) => {
        const live = this.outbound.get(frame.transferId);
        if (okay && live === out && !out.settled) this.settleOutbound(out, true);
        // An invalid MAC: ignore (do NOT resolve) — fails closed.
      });
      return;
    }
    this.settleOutbound(out, true);
  }

  private onAbort(frame: AbortFrame): void {
    const out = this.outbound.get(frame.transferId);
    if (out !== undefined) {
      // ENFORCE-WHEN-PRESENT (rework rd3 §1): with a verifier, a forged ABORT must
      // not tear down a transfer — verify the MAC against OUR header's hash+size
      // first; an unsigned/invalid ABORT is IGNORED (the transfer continues / fails
      // closed via idle timeout). Without a verifier, an ABORT is advisory and
      // fails the transfer as before.
      if (this.terminalVerifier !== undefined) {
        const verifier = this.terminalVerifier;
        const captured = out;
        void verifier("abort", frame.transferId, captured.header.hash, captured.header.size, frame.reason, frame.mac).then(
          (okay) => {
            const live = this.outbound.get(frame.transferId);
            if (okay && live === captured && !captured.settled) {
              this.settleOutbound(captured, false, new Error(`receiver aborted: ${frame.reason}`));
            }
          },
        );
      } else {
        this.settleOutbound(out, false, new Error(`receiver aborted: ${frame.reason}`));
      }
    }
    // An abort for an INBOUND transfer drops our reassembly state + frees bytes
    // exactly once (rework rd3 §2). This is unconditional — an inbound abort only
    // discards our own partial buffer (no false-success risk), so a forged one is
    // at worst a single-transfer DoS on the receiving side (documented residual).
    this.releaseInbound(frame.transferId);
  }

  // --- Idle sweep ------------------------------------------------------------

  private startSweep(): void {
    if (this.sweepTimer !== undefined) return;
    const tick = (): void => {
      this.sweepTimer = undefined;
      this.sweepIdle();
      if (this.wantConnected) {
        this.sweepTimer = this.scheduler.setTimeout(tick, this.opts.idleTransferMs);
      }
    };
    this.sweepTimer = this.scheduler.setTimeout(tick, this.opts.idleTransferMs);
  }

  /** Drop transfers (in/out) that have made no progress within the idle window. */
  private sweepIdle(): void {
    const cutoff = this.now() - this.opts.idleTransferMs;
    for (const [id, inb] of [...this.inbound]) {
      if (inb.lastActivity < cutoff) this.abortInbound(id, "idle-timeout");
    }
    for (const out of [...this.outbound.values()]) {
      if (out.lastActivity < cutoff && !out.settled) {
        this.send_({ kind: "abort", transferId: out.header.transferId, reason: "idle-timeout" });
        this.settleOutbound(out, false, new Error("transfer idle timeout"));
      }
    }
  }

  // --- Introspection (tests/observability) -----------------------------------

  /** Live inbound (reassembling) transfer count. */
  get inboundCount(): number {
    return this.inbound.size;
  }
  /** Live outbound (un-settled) transfer count. */
  get outboundCount(): number {
    return this.outbound.size;
  }
  /** Live expectation count. */
  get expectationCount(): number {
    return this.expectations.size;
  }
  /** Live transferId-reservation count (A1 export channel; tests/observability). */
  get transferReservationCount(): number {
    return this.transferReservations.size;
  }
  /** Outstanding reserved bytes (expectations + self-charged inbound). Tests assert this. */
  get outstandingBytes(): number {
    return this.expectedBytesOutstanding;
  }
}
