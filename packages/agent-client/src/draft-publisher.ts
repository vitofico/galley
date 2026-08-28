/**
 * The headless draft-publisher client (the galley-side enabler for external
 * document-draft sinks — CI bots, cloud runners, any process that wants to
 * LAND A DRAFT without an editor): join a shared project's room over the sync
 * relay as an AGENT peer and park proposals in the `@galley/collab` mailbox.
 *
 * Three deliberate stances:
 *
 *  - **Reuses the kernel's join/transport core.** The room is joined exactly
 *    the way apps/mcp's session does — `CollabConnection` + `WebSocketTransport`
 *    over the `ws` package against the apps/sync relay. A headless peer needs
 *    ONLY the room capability to join (the sync server's capability-room
 *    carve-out admits Origin-less native ws clients for capability rooms), so
 *    there is no auth machinery here: the room id IS the credential.
 *
 *  - **Every publish is UNSIGNED.** No `ProposalSigner` is ever bound: an
 *    unsigned record gets the browser's mandatory MANUAL in-editor Accept gate
 *    (ADR-0020) and is never auto-accepted (ADR-0023 — the signer is the only
 *    thing that makes a proposal auto-acceptable). That is exactly the draft
 *    contract: a bot proposes, a human lands.
 *
 *  - **Single-shot link + explicit flush.** A short-lived publisher must know
 *    its records actually REACHED the relay before the socket closes — the
 *    transport's outbox is discarded on disconnect, so publish-then-exit would
 *    silently lose data. `flush()` sends a sync step1 probe and waits for its
 *    step2 reply: the relay answers every step1 in arrival order over the same
 *    ordered socket, so the Nth inbound step2 proves the relay has APPLIED our
 *    Nth step1 — and with it every frame we sent before it, the proposal
 *    updates included — into the LIVE room doc. What flush does NOT prove is
 *    persistence: the relay holds no storage and DESTROYS a room's doc on
 *    last-disconnect (apps/sync reaps empty rooms). A flushed record therefore
 *    survives only while the room stays alive — i.e. while another peer (the
 *    editor side, in the A2 topology) holds it open; relay-side durable storage
 *    is a separate roadmap item (S2). Reconnection is DISABLED (one socket, one
 *    accounting epoch — reconnects would break the 1:1 step1/step2 alignment):
 *    if the link drops, pending and future flushes reject and the caller
 *    connects a fresh client and republishes. Republish mints a NEW random
 *    proposal id, so a retry after a lost flush reply lands a DUPLICATE mailbox
 *    record (not an idempotent CRDT merge) — callers that retry should dedupe
 *    by runId.
 */
import { WebSocket as WS } from "ws";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import {
  CollabProject,
  CollabConnection,
  WebSocketTransport,
  registerAuthor,
  publishProposal,
  publishFileProposal,
  getProposal,
  getProposals,
  getFileProposal,
  getFileProposals,
  observeProposals,
  observeFileProposals,
  type Transport,
  type WebSocketLike,
  type ProjectSnapshot,
  type ProposalInput,
  type ProposalRecord,
  type FileProposalInput,
  type FileProposalRecord,
} from "@galley/collab";
import type { Author } from "@galley/shared";

/** Top-level y-protocols message types — identical to CollabConnection's framing. */
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;

/** The default agent identity a draft publisher presents in presence/attribution. */
export const DRAFT_PUBLISHER_RUN_ID = "draft-publisher";

export interface DraftPublisherConfig {
  /** The relay endpoint, e.g. `ws://127.0.0.1:8080` — no trailing room path. */
  syncUrl: string;
  /**
   * The project's share-room CAPABILITY (copied from the browser's Share
   * surface). The client only ever JOINS this room — it never creates, lists,
   * or probes rooms (same posture as the MCP kernel).
   */
  room: string;
}

export interface DraftPublisherOptions {
  /** Injectable socket for tests; defaults to the `ws` package. */
  socketFactory?: (url: string) => WebSocketLike;
  /**
   * The `runId` of the `{ kind: "agent" }` author this client presents in
   * presence + attribution. Always an AGENT identity — a headless bot must
   * never masquerade as a human peer (it would flip a kernel's honest
   * `browserAttached` liveness). Defaults to {@link DRAFT_PUBLISHER_RUN_ID}.
   */
  agentRunId?: string;
}

export interface DraftPublisher {
  /**
   * Resolves once the relay's initial state has been applied (the first sync
   * step2) — i.e. the room's existing content, mailbox included, is live in
   * {@link snapshot}/the read helpers. Rejects on timeout (an unreachable relay
   * or an inactive room capability is a config error the caller must see, not
   * something to publish blind over), and PROMPTLY if the link drops or the
   * client is torn down while the sync is still in flight — a short-lived
   * process never hangs to the timeout on a dead link.
   */
  whenSynced(timeoutMs?: number): Promise<void>;
  /** The replicated project's current files (compute `baseText` for edits here). */
  snapshot(): ProjectSnapshot;
  /**
   * Publish a single-file proposal, UNSIGNED (manual Accept gate only).
   * Resolves to the minted proposal id; rejects with the mailbox's typed
   * size-violation error on an over-cap input ({@link PROPOSAL_LIMITS}) —
   * nothing enters the CRDT. Local until {@link flush}/{@link close} confirms
   * delivery.
   */
  publishProposal(input: ProposalInput): Promise<string>;
  /** Publish a multi-file proposal, UNSIGNED — see {@link publishProposal}. */
  publishFileProposal(input: FileProposalInput): Promise<string>;
  /** One single-file proposal by id (undefined if absent/malformed). */
  getProposal(id: string): ProposalRecord | undefined;
  /** All well-formed single-file proposals, oldest first. */
  getProposals(): ProposalRecord[];
  /** One multi-file proposal by id (undefined if absent/malformed). */
  getFileProposal(id: string): FileProposalRecord | undefined;
  /** All well-formed multi-file proposals, oldest first. */
  getFileProposals(): FileProposalRecord[];
  /**
   * Invoke `cb` whenever the single-file mailbox may have changed — a record
   * arriving or a status flipping (accept/reject reconciliation). Unsubscribe
   * with the returned function.
   */
  observeProposals(cb: () => void): () => void;
  /** Like {@link observeProposals}, for the multi-file mailbox. */
  observeFileProposals(cb: () => void): () => void;
  /**
   * Round-trip delivery barrier: resolves once the relay has APPLIED every
   * frame sent so far into the LIVE room doc (all published records are in the
   * room's mailbox). This confirms delivery to the live room, NOT persistence —
   * the relay has no storage and drops the doc when the room empties, so a
   * flushed record lasts only while some peer keeps the room open. Rejects on
   * timeout, after {@link close}/{@link destroy}, or if the single-shot link
   * dropped — a rejected flush means delivery is NOT confirmed; reconnect a
   * fresh client and republish.
   */
  flush(timeoutMs?: number): Promise<void>;
  /**
   * Explicit flush-then-disconnect: awaits the flush round-trip so a
   * short-lived publish is APPLIED to the live room BEFORE the socket closes
   * (the transport's outbox is discarded on disconnect), then tears the client
   * down. Delivery, not persistence — the record survives only while the room
   * stays open (see {@link flush}). A synchronous closing barrier makes any
   * later {@link publishProposal}/{@link publishFileProposal}/{@link flush}
   * reject rather than race the teardown and be silently dropped. Rethrows the
   * flush error (after tearing down) when delivery could not be confirmed.
   */
  close(timeoutMs?: number): Promise<void>;
  /** Tear down WITHOUT flushing (abandon): pending flushes reject. Idempotent. */
  destroy(): void;
}

/**
 * Count the sync step1/step2 messages in one wire frame (a frame may batch
 * several top-level messages — same drain loop as CollabConnection). Unknown
 * message types end the scan (their length is unknowable); a malformed frame
 * keeps the counts scanned so far — honest relays/clients never produce one,
 * and the sync layer itself drops such frames.
 */
function countSyncFrames(frame: Uint8Array): { step1: number; step2: number } {
  const counts = { step1: 0, step2: 0 };
  try {
    const decoder = decoding.createDecoder(frame);
    while (decoding.hasContent(decoder)) {
      const type = decoding.readVarUint(decoder);
      if (type === MESSAGE_SYNC) {
        const syncType = decoding.readVarUint(decoder);
        decoding.readVarUint8Array(decoder); // step1's state vector / step2's or an update's payload
        if (syncType === syncProtocol.messageYjsSyncStep1) counts.step1 += 1;
        else if (syncType === syncProtocol.messageYjsSyncStep2)
          counts.step2 += 1;
      } else if (type === MESSAGE_AWARENESS) {
        decoding.readVarUint8Array(decoder);
      } else if (type === MESSAGE_QUERY_AWARENESS) {
        // no body
      } else {
        break;
      }
    }
  } catch {
    // truncated/over-running body — keep what was scanned
  }
  return counts;
}

/**
 * Connect to `{syncUrl, room}` and return the joined draft-publisher handle.
 * Connection is lazy/synchronous (frames buffer until the socket opens); await
 * {@link DraftPublisher.whenSynced} before reading, and ALWAYS finish a publish
 * run with {@link DraftPublisher.close} so the last records reach the live room
 * before the socket closes (delivery, not persistence — see
 * {@link DraftPublisher.flush}).
 */
export function connectDraftPublisher(
  config: DraftPublisherConfig,
  opts: DraftPublisherOptions = {},
): DraftPublisher {
  const author: Author = {
    kind: "agent",
    runId: opts.agentRunId ?? DRAFT_PUBLISHER_RUN_ID,
  };
  // The room id is a CAPABILITY — the ONLY credential to join — so it must never
  // leak into an error string or a log line. `redact` scrubs the room (plain +
  // URL-encoded) and the room-bearing URL out of any socket message text.
  const url = `${config.syncUrl}/${encodeURIComponent(config.room)}`;
  const redact = (raw: string): string =>
    raw
      .split(url)
      .join("<room-url>")
      .split(config.room)
      .join("<room>")
      .split(encodeURIComponent(config.room))
      .join("<room>");

  // Validate the endpoint shape HERE, before anything is allocated. A malformed
  // syncUrl would otherwise reach the ws constructor and throw with the
  // room-bearing URL embedded in its message; fail instead with a message that
  // names NEITHER the URL nor the room.
  if (!URL.canParse(url)) {
    throw new Error(
      "agent-client: invalid sync URL — expected a ws:// or wss:// relay endpoint",
    );
  }

  const project = new CollabProject();

  const makeSocket =
    opts.socketFactory ??
    ((u: string) => {
      const socket = new WS(u);
      // One stderr line per ASYNC socket failure (without a listener `ws`
      // escalates the error event to an uncaught exception), room + URL scrubbed
      // (mirrors apps/mcp session.ts).
      socket.addEventListener("error", (event) => {
        const raw =
          (event as { message?: string }).message ?? "connection error";
        console.error(`galley agent-client: room socket error: ${redact(raw)}`);
      });
      return socket as unknown as WebSocketLike;
    });

  // Single-shot link (see the module doc): no reconnect, so the step1/step2
  // accounting below stays 1:1 for the socket's whole life. Wrap the factory so
  // a SYNCHRONOUS construction/factory throw (a bad URL, or a socket library
  // that rejects the endpoint) is re-thrown with the room + URL redacted — the
  // raw message could embed the room-bearing URL.
  const inner = new WebSocketTransport(
    () => {
      try {
        return makeSocket(url);
      } catch (err) {
        throw new Error(
          `agent-client: could not open the room socket: ${redact(
            err instanceof Error ? err.message : String(err),
          )}`,
        );
      }
    },
    { reconnect: { enabled: false } },
  );

  // --- flush accounting -----------------------------------------------------
  // The relay replies exactly one step2 to each of our step1s, in arrival
  // order (readSyncMessage always writes a step2 for a step1, even an empty
  // one). Both directions ride ONE ordered socket, so once we have seen as
  // many inbound step2s as we had sent step1s when the probe went out, the
  // relay has processed the probe — and every frame that preceded it.
  let outboundStep1 = 0;
  let inboundStep2 = 0;
  let linkDown = false;
  let destroyed = false;
  // Set SYNCHRONOUSLY at the top of close() so a publish/flush racing in during
  // the flush round-trip is rejected rather than silently dropped on teardown.
  let closing = false;
  interface FlushWaiter {
    target: number;
    settle: (err?: Error) => void;
  }
  const waiters = new Set<FlushWaiter>();
  const failWaiters = (err: Error): void => {
    for (const w of [...waiters]) {
      waiters.delete(w);
      w.settle(err);
    }
  };

  // Sync waiters mirror flush waiters: a pending whenSynced() must be REJECTED —
  // not left to hang to its timeout — on any terminal path (teardown or a link
  // drop), so a short-lived process exits promptly instead of stalling on a dead
  // link.
  interface SyncWaiter {
    settle: (err?: Error) => void;
  }
  const syncWaiters = new Set<SyncWaiter>();
  const failSyncWaiters = (err: Error): void => {
    for (const w of [...syncWaiters]) {
      syncWaiters.delete(w);
      w.settle(err);
    }
  };

  // Count every frame the connection (or our probe) sends via this tee; the
  // outbox preserves order across the pre-open buffer, so send-time counting
  // matches delivery order.
  const transport: Transport = {
    send(data) {
      outboundStep1 += countSyncFrames(data).step1;
      inner.send(data);
    },
    onMessage: (handler) => inner.onMessage(handler),
    connect: () => inner.connect(),
    disconnect: () => inner.disconnect(),
    onStatus: (handler) => inner.onStatus(handler),
    retryNow: () => inner.retryNow(),
  };

  const offInbound = inner.onMessage((data) => {
    const n = countSyncFrames(data).step2;
    if (n === 0) return;
    inboundStep2 += n;
    for (const w of [...waiters]) {
      if (inboundStep2 >= w.target) {
        waiters.delete(w);
        w.settle();
      }
    }
  });
  const offStatus = inner.onStatus((status) => {
    if (status !== "closed") return;
    // The single-shot link died (or never opened): delivery can no longer be
    // confirmed on this handle — fail pending flushes AND a pending initial-sync
    // wait loud, never hang.
    linkDown = true;
    failWaiters(
      new Error(
        "agent-client: the relay link dropped before the flush round-trip completed — " +
          "publishes may not have reached the room; connect a fresh client and republish",
      ),
    );
    failSyncWaiters(
      new Error(
        "agent-client: the relay link dropped before the initial room sync completed — " +
          "check the sync URL and that the project's share room is active",
      ),
    );
  });

  const connection = new CollabConnection(project, transport, { author });
  try {
    // connect() invokes the socket factory SYNCHRONOUSLY: a factory throw
    // (already redacted by the wrap above) propagates to the caller — release
    // what was allocated first, since no handle ever escapes to destroy() it.
    connection.connect();
  } catch (err) {
    offInbound();
    offStatus();
    connection.destroy();
    project.destroy();
    throw err;
  }
  // Record this peer's clientID → agent identity in the doc-global authors map
  // (write-once; the publisher joins empty, so there is no seed to suppress).
  registerAuthor(project, author);

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    failWaiters(
      new Error(
        "agent-client: disconnected before the flush round-trip completed",
      ),
    );
    failSyncWaiters(
      new Error(
        "agent-client: disconnected before the initial room sync completed",
      ),
    );
    offInbound();
    offStatus();
    connection.destroy();
    project.destroy();
  };

  // The flush round-trip itself. close() drives this DIRECTLY (past the closing
  // barrier the public flush guards on), so its own terminal flush is not
  // rejected by the barrier it just set.
  const flushCore = (timeoutMs = 15_000): Promise<void> => {
    if (destroyed) {
      return Promise.reject(
        new Error("agent-client: flush() after disconnect"),
      );
    }
    if (linkDown) {
      return Promise.reject(
        new Error(
          "agent-client: the relay link is down — publishes may not have reached the room; " +
            "connect a fresh client and republish",
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      // The probe: a plain sync step1 (state-vector request). Sent through the
      // counting tee so the reply target below includes it.
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, project.doc);
      transport.send(encoding.toUint8Array(encoder));

      const waiter: FlushWaiter = {
        target: outboundStep1,
        settle: (err) => {
          clearTimeout(timer);
          waiters.delete(waiter);
          if (err !== undefined) reject(err);
          else resolve();
        },
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(
          new Error(
            `agent-client: flush timed out after ${timeoutMs} ms — the relay never ` +
              "acknowledged the probe; publishes may not have reached the room",
          ),
        );
      }, timeoutMs);
      waiters.add(waiter);
    });
  };

  // Public flush: refuse once close() has begun. A publish/flush racing in after
  // the closing barrier would resolve against a probe already in flight yet be
  // discarded when close() tears the socket down — reject it instead of lying.
  const flush = (timeoutMs?: number): Promise<void> => {
    if (closing) {
      return Promise.reject(new Error("agent-client: flush() after close()"));
    }
    return flushCore(timeoutMs);
  };

  return {
    whenSynced(timeoutMs = 15_000): Promise<void> {
      if (destroyed) {
        return Promise.reject(
          new Error("agent-client: whenSynced() after disconnect"),
        );
      }
      if (linkDown) {
        return Promise.reject(
          new Error(
            "agent-client: the relay link is down — check the sync URL and that the " +
              "project's share room is active",
          ),
        );
      }
      if (connection.synced) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        // Tracked in `syncWaiters` so destroy()/a link drop rejects it promptly
        // rather than letting it hang to the timeout below.
        let off: (() => void) | undefined;
        const waiter: SyncWaiter = {
          settle: (err) => {
            clearTimeout(timer);
            off?.();
            syncWaiters.delete(waiter);
            // Never embed the room id — it is a capability (see `redact`).
            if (err !== undefined) reject(err);
            else resolve();
          },
        };
        const timer = setTimeout(() => {
          waiter.settle(
            new Error(
              "agent-client: timed out waiting for the initial room sync — check the " +
                "sync URL and that the project's share room is active",
            ),
          );
        }, timeoutMs);
        syncWaiters.add(waiter);
        off = connection.onSynced(() => waiter.settle());
      });
    },

    snapshot: () => project.snapshot(),

    publishProposal(input): Promise<string> {
      if (destroyed) {
        return Promise.reject(
          new Error("agent-client: publish after disconnect"),
        );
      }
      if (closing) {
        return Promise.reject(new Error("agent-client: publish after close()"));
      }
      // UNSIGNED by design — no signer parameter exists on this surface.
      return publishProposal(project, input, author);
    },

    publishFileProposal(input): Promise<string> {
      if (destroyed) {
        return Promise.reject(
          new Error("agent-client: publish after disconnect"),
        );
      }
      if (closing) {
        return Promise.reject(new Error("agent-client: publish after close()"));
      }
      return publishFileProposal(project, input, author);
    },

    getProposal: (id) => getProposal(project, id),
    getProposals: () => getProposals(project),
    getFileProposal: (id) => getFileProposal(project, id),
    getFileProposals: () => getFileProposals(project),
    observeProposals: (cb) => observeProposals(project, cb),
    observeFileProposals: (cb) => observeFileProposals(project, cb),

    flush,

    async close(timeoutMs?: number): Promise<void> {
      if (destroyed || closing) return;
      // Raise the closing barrier SYNCHRONOUSLY, before the first await, so any
      // publish/flush that races in during the round-trip below is rejected
      // (see `publishProposal`/`flush`) rather than dropped on the teardown.
      closing = true;
      try {
        await flushCore(timeoutMs);
      } finally {
        // Tear down either way; a flush failure still propagates so the caller
        // KNOWS delivery to the live room was not confirmed.
        destroy();
      }
    },

    destroy,
  };
}
