/**
 * Kernel blob-channel session (Phase 1 byte-transport epic).
 *
 * The MCP kernel's end of the `galley-blob-v1` side channel: it joins the SAME
 * shared room as the kernel's sync `CollabConnection` (an unguessable capability),
 * over the SAME relay + auth gate, and carries content-addressed blob BYTES so
 * binary content never enters the Yjs CRDT log.
 *
 * API shape (for later phases A1/A2 to build MCP tools on — this phase wires NO
 * tool):
 *  - {@link KernelBlobSession.putBlob}(bytes, mime) → `{hash, size}`: hash the
 *    bytes (content addressing) and PUSH them to the room's browser peer; resolves
 *    once the receiver ACKs the full transfer. A later `import_image`-style tool
 *    calls this then writes the `{hash,size,mime}` pointer into the CRDT.
 *  - {@link KernelBlobSession.onBlob}(cb): subscribe to VERIFIED inbound blobs
 *    (sha256 + size already checked by the transport) — e.g. a future
 *    `export_image` flow. Inbound blobs also land in a BOUNDED in-memory buffer
 *    ({@link KernelBlobSession.takeBlob} by hash) so a tool can fetch one by hash.
 *
 * Defensive: the inbound buffer is bounded (count + total bytes) and evicts the
 * OLDEST entry past the cap, so a hostile/rapid push can't grow kernel memory
 * without bound. The kernel never trusts a peer — the transport's verify gate
 * runs before anything reaches the buffer.
 */
import { WebSocket as WS } from "ws";
import {
  BlobTransport,
  sha256Hex,
  type WebSocketLike,
  type ReceivedBlob,
  type BlobTerminalSigner,
  type BlobTerminalVerifier,
} from "@galley/collab";

/** The websocket subprotocol that selects the relay's blob channel. */
export const BLOB_SUBPROTOCOL = "galley-blob-v1";

/** Bound the in-memory received-blob buffer (count + aggregate bytes). */
const MAX_BUFFERED_BLOBS = 32;
const MAX_BUFFERED_BYTES = 128 * 1024 * 1024; // 128 MiB aggregate ceiling

export interface KernelBlobSession {
  /**
   * Hash + PUSH `bytes` to the room's other peers (the browser). Returns the
   * content hash + size (the `BinaryAsset` identity a later tool writes into the
   * CRDT). Resolves ONLY when the receiver has verified + stored the bytes and
   * sent a terminal COMPLETE (honest completion); rejects on abort/timeout/
   * disconnect.
   */
  putBlob(bytes: Uint8Array, mime: string): Promise<{ hash: string; size: number }>;
  /**
   * Register that an inbound blob `{hash,size}` is EXPECTED (rework §E13). Only an
   * expected, verified inbound transfer is buffered; an UNEXPECTED inbound push is
   * aborted and never buffered. Returns false if the registration exceeds the
   * receiver byte quota. A1/A2 call this before a browser pushes a blob to the
   * kernel (e.g. an export flow).
   */
  expect(hash: string, size: number): boolean;
  /** Drop a previously-registered expectation. */
  unexpect(hash: string, size: number): void;
  /**
   * Reserve inbound capacity for a transfer arriving under a kernel-minted
   * `transferId` whose HASH IS NOT YET KNOWN (A1 export channel): the kernel mints
   * the id, reserves `maxBytes` of buffer + transport quota up front, then sends
   * the RPC asking the browser to compile + push the PDF under the SAME id. The
   * delivered blob carries that id (see {@link KernelBlobSession.takeBlobByTransfer}).
   * Returns false if the reservation exceeds the buffer or transport byte quota,
   * mirroring {@link expect}. Idempotent for the same id + maxBytes.
   */
  expectTransfer(transferId: string, maxBytes: number): boolean;
  /** Release a transferId reservation made by {@link expectTransfer}. */
  unexpectTransfer(transferId: string): void;
  /**
   * Fetch + REMOVE a buffered inbound blob delivered under `transferId` (A1 export
   * channel), or undefined if none arrived. Like {@link takeBlob} but keyed by the
   * request-scoped transferId rather than the hash — the kernel correlates the
   * pushed bytes with the RPC it issued.
   */
  takeBlobByTransfer(transferId: string): ReceivedBlob | undefined;
  /**
   * Read (WITHOUT removing) the buffered inbound blob delivered under `transferId`
   * (A1), or undefined if none arrived. Lets the export tool VERIFY the artifact's
   * {hash,size} against the signed descriptor while leaving the pinned bytes in the
   * buffer for a follow-up {@link takeBlob} by hash.
   */
  peekBlobByTransfer(transferId: string): ReceivedBlob | undefined;
  /**
   * Wait (up to `timeoutMs`) for a CANDIDATE delivered under `transferId` that
   * SATISFIES `match` — the candidate/promote loop (rd-A1 §2). Successive candidates
   * may arrive under one reservation (a forged early push, then the real one): each
   * is tested against `match`; a MATCH resolves it (left in the transfer buffer for
   * the caller to take); a MISMATCH is DISCARDED (dropped from the buffer) and the
   * wait CONTINUES with the reservation STILL LIVE until the deadline. Resolves the
   * matching {@link ReceivedBlob}, or undefined on timeout (no matching candidate).
   * Total + leak-free: the subscription + timer are always torn down; the reservation
   * is NOT released here (the caller withdraws it on promotion / timeout / failure).
   */
  awaitMatchingCandidate(
    transferId: string,
    match: (blob: ReceivedBlob) => boolean,
    timeoutMs: number,
  ): Promise<ReceivedBlob | undefined>;
  /**
   * Subscribe to VERIFIED + EXPECTED inbound blobs. Returns an unsubscribe fn.
   * Multiple subscribers are supported; a throwing callback is isolated.
   */
  onBlob(cb: (blob: ReceivedBlob) => void): () => void;
  /**
   * Fetch + REMOVE a buffered inbound blob by hash, or undefined if absent/
   * evicted. Removal keeps the buffer from pinning bytes a tool already consumed.
   */
  takeBlob(hash: string): ReceivedBlob | undefined;
  /**
   * PIN an already-verified blob into the hash-keyed buffer keyed by `blob.hash`
   * so a later {@link takeBlob}(hash) can fetch it — used by export_compiled to
   * retain the exported PDF for save_artifact. Returns false if the buffer cannot
   * hold it (count/byte cap). Idempotent for the same hash; pinned, never evicted.
   */
  retainBlob(blob: ReceivedBlob): boolean;
  /** Whether a verified inbound blob with `hash` is currently buffered. */
  hasBlob(hash: string): boolean;
  /** Count of currently buffered inbound blobs (observability/tests). */
  readonly bufferedCount: number;
  /** Whether the channel is currently enabled (a consumer opted in / connected). */
  readonly enabled: boolean;
  /**
   * OPT-IN connect (rework §E14). The kernel does NOT auto-connect the blob
   * channel; a consumer (a future A1/A2 tool) calls this to open the surface only
   * when needed. Idempotent.
   */
  connect(): void;
  /** Close the channel and stop reconnecting. */
  destroy(): void;
}

export interface KernelBlobSessionOptions {
  /** Injectable socket factory (tests); defaults to the `ws` package requesting the blob subprotocol. */
  socketFactory?: (url: string) => WebSocketLike;
  /** Max buffered inbound blobs. Default {@link MAX_BUFFERED_BLOBS}. */
  maxBufferedBlobs?: number;
  /** Max aggregate buffered bytes. Default {@link MAX_BUFFERED_BYTES}. */
  maxBufferedBytes?: number;
  /**
   * Terminal-frame authentication (rework rd3 §1). When BOTH are supplied
   * (built via `buildBlobTerminalAuth(responseKey, scope)` in session.ts), the
   * channel ENFORCES authenticated completion: `putBlob` resolves only on a
   * MAC-verified COMPLETE and outgoing terminals are signed. Absent ⇒ advisory
   * (forgeable) completion — the un-paired local path only.
   */
  terminalSigner?: BlobTerminalSigner;
  terminalVerifier?: BlobTerminalVerifier;
}

/**
 * Create the kernel's blob-channel session for `room`. Mirrors `session.ts`'s
 * sync socket: the SAME `syncUrl`/`room` URL shape + a native `ws` client (no
 * Origin), so the relay's absent-Origin capability carve-out admits it exactly as
 * it admits the kernel's sync connection. Does NOT connect until {@link
 * KernelBlobSession.connect}.
 */
export function createKernelBlobSession(
  syncUrl: string,
  room: string,
  opts: KernelBlobSessionOptions = {},
): KernelBlobSession {
  const url = `${syncUrl}/${encodeURIComponent(room)}`;
  const maxBlobs = opts.maxBufferedBlobs ?? MAX_BUFFERED_BLOBS;
  const maxBytes = opts.maxBufferedBytes ?? MAX_BUFFERED_BYTES;

  const makeSocket =
    opts.socketFactory ??
    ((u: string) => {
      const socket = new WS(u, BLOB_SUBPROTOCOL);
      // Mirror session.ts: a per-socket error listener (without one `ws`
      // escalates 'error' to an uncaught exception), scrubbing the capability
      // room id from any text before it reaches stderr.
      socket.addEventListener("error", (event) => {
        const raw = (event as { message?: string }).message ?? "connection error";
        const scrubbed = raw
          .split(room)
          .join("<project-room>")
          .split(encodeURIComponent(room))
          .join("<project-room>");
        console.error(`galley mcp kernel: blob-channel socket error: ${scrubbed}`);
      });
      return socket as unknown as WebSocketLike;
    });

  // Bounded buffer of verified inbound blobs, keyed by hash for pull-by-hash. A
  // delivered+expected blob is PINNED: it was explicitly requested, so it is never
  // evicted (rework rd3 §5). To make that guarantee hold, `expect()` RESERVES the
  // buffer slot (count + bytes) UP FRONT and FAILS if the buffer can't hold it, so
  // a delivered pinned blob can never be dropped to make room for a younger one.
  const buffer = new Map<string, ReceivedBlob>();
  let bufferedBytes = 0;
  // A1 export channel: transferId RESERVATIONS keyed by transferId → reserved
  // maxBytes (a buffer-slot reservation, sibling of `reserved` below but keyed by
  // id since the hash is unknown when the reservation is made). The reservation
  // PERSISTS across discarded candidates (rd-A1 §2) — released only by
  // unexpectTransfer / destroy.
  const transferReserved = new Map<string, number>();
  let transferReservedBytes = 0;
  // A1 export channel: delivered CANDIDATES keyed by their OWN transferId (rd-A1 §5
  // — NOT by hash, so two concurrent exports of an UNCHANGED project that produce
  // the SAME hash get distinct, independently-owned entries that never delete each
  // other). The latest candidate under a transferId supersedes an earlier one
  // (e.g. a forged candidate discarded, then the real one). A delivered candidate's
  // bytes are covered by the reservation's already-charged maxBytes — no extra
  // quota beyond the reservation.
  const transferBuffer = new Map<string, ReceivedBlob>(); // transferId → candidate
  // Live expectation reservations keyed by `hash:size` → reserved byte size. The
  // reservation lifecycle: expect() reserves; delivery (onBlob) converts it to a
  // buffered blob (still counted, now as actual bytes); takeBlob / unexpect /
  // overflow-on-redeliver releases it.
  const reserved = new Map<string, number>();
  let reservedBytes = 0;
  const pinned = new Set<string>();
  const subscribers = new Set<(blob: ReceivedBlob) => void>();
  let enabled = false;
  const expKey = (hash: string, size: number): string => `${hash}:${size}`;

  // Capacity check INCLUDING the buffered blobs + all live reservations (both the
  // hash-keyed expect() reservations and the transferId reservations).
  const wouldFit = (addCount: number, addBytes: number): boolean =>
    buffer.size + reserved.size + transferReserved.size + addCount <= maxBlobs &&
    bufferedBytes + reservedBytes + transferReservedBytes + addBytes <= maxBytes;

  const transport = new BlobTransport(() => makeSocket(url), {
    ...(opts.terminalSigner ? { terminalSigner: opts.terminalSigner } : {}),
    ...(opts.terminalVerifier ? { terminalVerifier: opts.terminalVerifier } : {}),
    onBlob: (blob: ReceivedBlob) => {
      // The transport already verified sha256 + size AND matched a live
      // expectation/reservation.
      //
      // A1 export channel (rd-A1 §2/§5): a candidate delivered under a LIVE
      // transferId reservation lands in the transferId-keyed `transferBuffer` (NOT
      // the hash-keyed buffer), so same-hash concurrent exports never collide and a
      // discarded candidate never deletes another export's artifact. The reservation
      // STAYS OPEN (its maxBytes quota persists) — the kernel promotes/discards the
      // candidate then withdraws via unexpectTransfer. The candidate supersedes any
      // earlier candidate under the same id (e.g. a forged one already discarded).
      if (blob.transferId !== undefined && transferReserved.has(blob.transferId)) {
        transferBuffer.set(blob.transferId, blob);
        for (const cb of [...subscribers]) {
          try {
            cb(blob);
          } catch {
            /* a subscriber error must not tear down the channel */
          }
        }
        return;
      }
      // The hash-keyed path (import / putBlob): convert a hash-expectation
      // reservation to a buffered+pinned entry (rework rd3 §5 — never evicted).
      const key = expKey(blob.hash, blob.size);
      if (reserved.has(key)) {
        reservedBytes -= reserved.get(key)!;
        reserved.delete(key);
      }
      const prior = buffer.get(blob.hash);
      if (prior) bufferedBytes -= prior.size;
      buffer.set(blob.hash, blob);
      bufferedBytes += blob.size;
      pinned.add(blob.hash);
      for (const cb of [...subscribers]) {
        try {
          cb(blob);
        } catch {
          /* a subscriber error must not tear down the channel */
        }
      }
    },
  });

  return {
    async putBlob(bytes: Uint8Array, mime: string): Promise<{ hash: string; size: number }> {
      const hash = await sha256Hex(bytes);
      const handle = transport.send(bytes, hash, mime);
      await handle.done;
      return { hash, size: bytes.length };
    },
    expect(hash, size) {
      // §rd3-5: RESERVE buffer capacity up front; refuse if the buffer can't hold
      // the blob this expectation will deliver, so a delivered pinned blob is
      // NEVER evicted. Also defer to the transport's own byte-quota gate.
      const key = expKey(hash, size);
      if (reserved.has(key) || buffer.has(hash)) {
        // Already reserved/buffered: idempotent, still mirror to the transport.
        return transport.expect(hash, size);
      }
      if (!wouldFit(1, size)) return false;
      if (!transport.expect(hash, size)) return false;
      reserved.set(key, size);
      reservedBytes += size;
      return true;
    },
    unexpect(hash, size) {
      transport.unexpect(hash, size);
      const key = expKey(hash, size);
      if (reserved.has(key)) {
        reservedBytes -= reserved.get(key)!;
        reserved.delete(key);
      }
    },
    expectTransfer(transferId, maxBytes) {
      // §rd3-5 mirror, keyed by transferId: RESERVE the buffer slot up front so a
      // delivered candidate fits within the already-charged maxBytes, and defer to
      // the transport's own byte-quota gate. Idempotent for the same id + maxBytes.
      const existing = transferReserved.get(transferId);
      if (existing !== undefined) {
        if (existing !== maxBytes) return false; // conflicting re-reservation
        return transport.expectTransfer(transferId, maxBytes);
      }
      if (!wouldFit(1, maxBytes)) return false;
      if (!transport.expectTransfer(transferId, maxBytes)) return false;
      transferReserved.set(transferId, maxBytes);
      transferReservedBytes += maxBytes;
      return true;
    },
    unexpectTransfer(transferId) {
      // Withdraw the reservation (the transport also aborts any bound in-flight
      // candidate) AND drop any delivered-but-unpromoted candidate, so a failure
      // cleanup leaves NO orphan (rd-A1 §4). Free the reserved quota exactly once.
      transport.unexpectTransfer(transferId);
      transferBuffer.delete(transferId);
      const reservedAmt = transferReserved.get(transferId);
      if (reservedAmt !== undefined) {
        transferReservedBytes -= reservedAmt;
        transferReserved.delete(transferId);
      }
    },
    onBlob(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    takeBlob(hash) {
      const blob = buffer.get(hash);
      if (blob) {
        buffer.delete(hash);
        pinned.delete(hash);
        bufferedBytes -= blob.size;
      }
      return blob;
    },
    retainBlob(blob) {
      // PIN an already-verified blob into the hash-keyed buffer (e.g. the export
      // tool retains the exported PDF for a later save_artifact). Does NOT touch
      // transferReserved — the caller still owns the transferId reservation and
      // withdraws it via unexpectTransfer right after this returns, so the account
      // ordering is net-neutral: retain charges one buffer slot, then the transfer
      // reservation (already >= blob.size) is freed. Pinned ⇒ never evicted.
      if (buffer.has(blob.hash)) return true;
      if (!wouldFit(1, blob.size)) return false;
      buffer.set(blob.hash, blob);
      bufferedBytes += blob.size;
      pinned.add(blob.hash);
      return true;
    },
    takeBlobByTransfer(transferId) {
      // rd-A1 §5: the candidate is keyed by its OWN transferId — taking it removes
      // ONLY this export's entry, never another concurrent same-hash export's.
      const blob = transferBuffer.get(transferId);
      if (blob) transferBuffer.delete(transferId);
      return blob;
    },
    peekBlobByTransfer(transferId) {
      return transferBuffer.get(transferId);
    },
    awaitMatchingCandidate(transferId, match, timeoutMs) {
      return new Promise<ReceivedBlob | undefined>((resolve) => {
        let settled = false;
        let off: (() => void) | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (value: ReceivedBlob | undefined): void => {
          if (settled) return;
          settled = true;
          off?.();
          if (timer !== undefined) clearTimeout(timer);
          resolve(value);
        };
        // Test ONE delivered candidate: a MATCH promotes (resolve, leaving it in the
        // buffer for the caller to take); a MISMATCH is DISCARDED (dropped from the
        // buffer so a forged candidate is never left as the export artifact) and the
        // wait continues — the reservation stays live for the next candidate.
        const consider = (blob: ReceivedBlob): void => {
          if (match(blob)) {
            finish(blob);
            return;
          }
          // Discard ONLY if this exact candidate is still the buffered one (a newer
          // candidate may already have superseded it — never drop the newer one).
          if (transferBuffer.get(transferId) === blob) transferBuffer.delete(transferId);
        };
        const sub = (blob: ReceivedBlob): void => {
          if (blob.transferId === transferId) consider(blob);
        };
        subscribers.add(sub);
        off = () => subscribers.delete(sub);
        timer = setTimeout(() => finish(undefined), timeoutMs);
        // Fast path: a candidate may already be buffered (it landed before we
        // subscribed — no delivery event would fire for it).
        const already = transferBuffer.get(transferId);
        if (already !== undefined) consider(already);
      });
    },
    hasBlob(hash) {
      return buffer.has(hash);
    },
    get bufferedCount() {
      return buffer.size;
    },
    get enabled() {
      return enabled;
    },
    connect() {
      enabled = true;
      transport.connect();
    },
    destroy() {
      enabled = false;
      subscribers.clear();
      buffer.clear();
      pinned.clear();
      reserved.clear();
      transferReserved.clear();
      transferBuffer.clear();
      bufferedBytes = 0;
      reservedBytes = 0;
      transferReservedBytes = 0;
      transport.disconnect();
    },
  };
}
