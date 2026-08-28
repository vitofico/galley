/**
 * `CollabConnection` — binds a `CollabDocument` + a Yjs `Awareness` to a
 * `Transport`, speaking the STANDARD `y-protocols` sync + awareness wire format
 * (ADR-0007). The framing is byte-identical to `y-websocket` /
 * `y-codemirror.next` (top-level message type: `0` sync, `1` awareness,
 * `3` query-awareness), so the future real sync server is a thin byte relay and
 * the editor binding reuses the same `Awareness`.
 *
 * Correctness rules (from the Architect + Code-Reviewer passes):
 *  - **Echo suppression by origin, not by Yjs idempotency.** Inbound updates are
 *    applied with `origin = this` (the connection); the outbound handlers send
 *    only when `origin !== this`, so we never re-broadcast what we just received.
 *  - **`origin` is local-only** — standard Yjs updates do not encode it, so
 *    author attribution does NOT cross the wire here. Cross-peer attribution is a
 *    deferred slice; presence carries the live `Author` identity instead.
 *  - **Symmetric handshake.** When a peer asks us for our state (sync step1) we
 *    reply step2 AND ask for theirs once, so two peers that diverged offline
 *    reconcile in BOTH directions on reconnect (guarded against step1 ping-pong).
 *    Full N-peer mesh reconciliation of a late joiner that *also* has offline
 *    edits is still the relay server's job (Phase 2b); the 1:1 case is covered.
 *  - **Deterministic awareness lifecycle.** `disconnect()` clears local awareness
 *    (a real removal message, no 30 s timeout) and drops stale remote presence
 *    locally; `connect()` re-announces the desired presence; a connection with no
 *    presence never advertises a malformed (author-less) peer.
 *  - **Frame-loop.** A single transport frame may carry several top-level
 *    messages (a real server batches); we drain them all.
 */
import type { Doc } from "yjs";
import * as syncProtocol from "y-protocols/sync";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { Author } from "@galley/shared";
import type { Transport } from "./transport.js";

/**
 * Anything backed by one `Y.Doc` — a single-file `CollabDocument` or a multi-file
 * `CollabProject`. The connection syncs the WHOLE doc (all shared types: text,
 * maps, nested), so it doesn't care which; it only needs `.doc`.
 */
export interface DocHost {
  doc: Doc;
}

/** Top-level message types — identical to y-websocket's framing. */
const messageSync = 0;
const messageAwareness = 1;
const messageQueryAwareness = 3;
/**
 * Server→client control frame (B2): the relay REFUSED a growth write because a
 * room storage cap was hit. Sent as its OWN ws frame, at most once per "full
 * episode" per connection. A distinct top-level type so it never collides with
 * y-protocols sync(0) / awareness(1) / queryAwareness(3).
 *
 * WHY THIS MATTERS: y-sync has NO per-update ack — a refused growth update
 * silently stays client-local, so sync LOOKS healthy while our doc diverges from
 * the room. This frame is the ONLY signal that the user's edits stopped reaching
 * the room; the next under-cap sync exchange (e.g. a reconnect) re-offers the
 * full diff and heals. There is NO "storage ok again" frame — recovery is not
 * observable here, which is why the UI cue clears on a reconnect edge (a fresh
 * sync exchange), never on a wire signal.
 */
const messageStorageFull = 4;

/** Link status surfaced to the UI: a reconnect-aware transport flips this on a
 *  drop so the shell can show a "reconnecting…" cue instead of silently losing
 *  edits into a dead outbox. */
export type ConnectionStatus = "connected" | "disconnected";

/**
 * The relay's storage-full reason, decoded from the wire's `reason` varint. An
 * OPEN enum: 1/2/3 are the reasons the relay knows how to send today, and
 * ANYTHING else is treated as a generic "write refused" (`"unknown"`) so a new
 * server reason degrades gracefully instead of misrendering. The UI keeps ONE
 * honest message across the "full" reasons rather than leaking the exact cap.
 */
export type StorageFullReason = "content-cap" | "log-ceiling" | "quota-unavailable" | "unknown";

/**
 * Decoded {@link messageStorageFull} payload surfaced to the UI via
 * {@link CollabConnection.onStorageFull}. `capBytes` is the relevant byte cap, or
 * `0` when not applicable (reason `"quota-unavailable"`, wire cap 0).
 */
export interface StorageFullInfo {
  reason: StorageFullReason;
  capBytes: number;
}

/** Map the wire's reason varint to a stable {@link StorageFullReason} (open enum). */
function storageFullReason(code: number): StorageFullReason {
  switch (code) {
    case 1:
      return "content-cap";
    case 2:
      return "log-ceiling";
    case 3:
      return "quota-unavailable";
    default:
      return "unknown"; // OPEN enum: an unrecognized reason is a generic refusal
  }
}

/**
 * Per-peer presence. Carries the live `Author` identity (so the agent shows up
 * as a real `{ kind: "agent" }` peer); everything else is an opaque, editor-owned
 * payload. Cursor/selection mechanics need Yjs relative positions and a real
 * editor, so they are deliberately NOT modelled here — that is the editor
 * binding's job.
 */
export interface Presence {
  author: Author;
  /**
   * The peer's access level for this share (B19-sharing-roles). Travels with
   * presence so a roster can show who is a `viewer` vs an `editor`. OPTIONAL and
   * additive — absent means the historical "everyone edits" share, so a pre-role
   * peer is treated as an editor (the default capability). Enforcement of the
   * read-only level is client-side this slice (the editor binds read-only); the
   * field is carried here so the room roster and future server gates can read it.
   */
  role?: "viewer" | "editor";
  /**
   * Comments Phase A (Layer 6): the id of the comment thread this peer currently
   * has open, or absent when none. Travels with presence so a thread card can show
   * "N viewing" off the live roster. OPTIONAL/additive, outside the doc, NOT
   * persisted, and cleared on disconnect — exactly the right lifetime for an
   * ephemeral "who's looking at this" cue (it should vanish when the peer leaves).
   */
  focusedThreadId?: string;
  /**
   * F13 (ADR-0024 §1): set TRUE by an in-browser HEADLESS agent-apply host — the
   * background tab that keeps applying a paired agent's proposals for a project
   * that is NOT the active editor document, with no human watching the review
   * surface. The host carries a normal `human` author (it really is a browser
   * editing the doc), but this honest marker tells the MCP kernel's liveness count
   * NOT to treat it as a watching human peer, so `browserAttached` stays a true
   * signal and `pending_review_unwatched` is never silently suppressed by a worker.
   * Absent/false ⇒ an ordinary watching peer (today's behaviour). Additive.
   */
  agentWorker?: boolean;
  [field: string]: unknown;
}

/**
 * The presence field an in-browser headless agent-apply host sets to advertise
 * itself as a NON-watching worker (F13). The MCP kernel's human-peer count
 * excludes any peer carrying `{[AGENT_WORKER_PRESENCE_FIELD]: true}`, so an
 * attached worker never flips a room "watched". Shared so the web host and the
 * kernel agree on the exact marker byte-for-byte.
 */
export const AGENT_WORKER_PRESENCE_FIELD = "agentWorker";

type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };

function isPresence(state: unknown): state is Presence {
  return typeof state === "object" && state !== null && "author" in state;
}

export class CollabConnection {
  readonly awareness: Awareness;
  private readonly doc: Doc;
  private connected = false;
  private unsubscribeMessage: (() => void) | undefined;
  /** The presence we want to advertise while connected (survives a reconnect). */
  private desiredPresence: Presence | null;
  /** Whether we've already sent a reactive step1 this connection (loop guard). */
  private resyncRequested = false;
  /** Whether the transport has opened at least once this connection — tells the
   *  initial handshake (queued synchronously in `connect()`) apart from a
   *  reconnect "open", which must re-run the handshake to reconcile. */
  private hasOpened = false;
  /** Unsubscribe from the transport's status stream (reconnect-aware transports). */
  private unsubscribeStatus: (() => void) | undefined;
  /** UI-facing link-status observers. */
  private readonly statusHandlers = new Set<(status: ConnectionStatus) => void>();
  /** UI-facing storage-full observers (the relay refused a growth write, B2). */
  private readonly storageFullHandlers = new Set<(info: StorageFullInfo) => void>();
  /**
   * Whether we've applied the relay's FIRST sync step2 — i.e. the room's existing
   * state has landed in our doc. A fresh CONNECTED joiner boots with an EMPTY doc
   * and the host's content only arrives over the wire (the relay replies step2 to
   * our step1); until then the empty editor isn't "the document", it's "not loaded
   * yet". This drives a calm "Syncing…" cue. STICKY: set once and never cleared, so
   * a later reconnect (which re-runs the handshake) never re-flags an already-loaded
   * joiner. An empty room still produces a step2, so this resolves there too. */
  private syncedOnce = false;
  /** One-shot observers fired when {@link syncedOnce} first flips true. */
  private readonly syncedHandlers = new Set<() => void>();

  private readonly onDocUpdate: (update: Uint8Array, origin: unknown) => void;
  private readonly onAwarenessUpdate: (change: AwarenessChange, origin: unknown) => void;

  constructor(
    collab: DocHost,
    private readonly transport: Transport,
    presence?: Presence,
  ) {
    this.doc = collab.doc;
    this.awareness = new Awareness(this.doc);
    // `new Awareness` seeds local state to `{}`; only advertise a real presence,
    // never an author-less one.
    this.desiredPresence = presence ?? null;
    this.awareness.setLocalState(this.desiredPresence);

    // Broadcast a local doc change. `origin === this` means we just applied a
    // remote update — don't echo it back.
    this.onDocUpdate = (update, origin) => {
      if (origin === this) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      this.transport.send(encoding.toUint8Array(encoder));
    };

    // Broadcast a local awareness change. Same origin filter: changes we applied
    // from the network (origin === this) are not re-broadcast — in a star server
    // the server fans out; in our mesh every peer hears the origin directly.
    this.onAwarenessUpdate = ({ added, updated, removed }, origin) => {
      if (origin === this) return;
      const changed = [...added, ...updated, ...removed];
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(this.awareness, changed));
      this.transport.send(encoding.toUint8Array(encoder));
    };
  }

  /** This peer's Yjs client id (its awareness identity). */
  get clientID(): number {
    return this.doc.clientID;
  }

  /** Set / replace this peer's presence (persists across reconnects). */
  setPresence(presence: Presence): void {
    this.desiredPresence = presence;
    this.awareness.setLocalState(presence);
  }

  /**
   * Rename THIS peer for presence — the live roster + cursor label — preserving
   * the role and every other presence field (the cursor `user.color`, etc.). The
   * `author.name` and the editor-binding `user.name` are updated together so the
   * roster and the in-editor cursor caption never drift. No-op when no presence
   * is advertised or this peer is not a human author.
   *
   * Scope note: this touches ONLY live awareness. The doc-global authors map
   * (per-file attribution history) is write-once per `clientID` and is NOT
   * changed here — by design (see `registerAuthor`).
   */
  setLocalAuthorName(name: string): void {
    const p = this.desiredPresence;
    if (p === null || p.author.kind !== "human") return;
    const author = { ...p.author, name };
    const user = p.user && typeof p.user === "object" ? (p.user as Record<string, unknown>) : {};
    this.setPresence({ ...p, author, user: { ...user, name } });
  }

  /**
   * Advertise (or clear) the comment thread THIS peer currently has open, for the
   * "N viewing" cue (Comments Phase A, Layer 6). Spreads the existing desired
   * presence so role / cursor `user` / author are all preserved; `null` removes the
   * field entirely (a present-but-undefined key would still serialize). No-op when
   * no presence is advertised (a local-only project has no awareness state to set).
   */
  setLocalFocusedThread(threadId: string | null): void {
    const p = this.desiredPresence;
    if (p === null) return;
    if (threadId === null) {
      // Drop the key rather than setting it to undefined so the roster filter sees
      // a clean "not focused" presence.
      const { focusedThreadId: _omit, ...rest } = p;
      this.setPresence(rest);
      return;
    }
    this.setPresence({ ...p, focusedThreadId: threadId });
  }

  /** Every peer's (well-formed) presence currently known to this connection. */
  presences(): Presence[] {
    return [...this.awareness.getStates().values()].filter(isPresence);
  }

  connect(): void {
    if (this.connected) return;
    this.connected = true;
    this.resyncRequested = false;
    this.hasOpened = false;
    // Re-announce our presence (a prior disconnect cleared local state).
    if (this.desiredPresence !== null) this.awareness.setLocalState(this.desiredPresence);

    // Reconnect-aware transports re-open the link after a drop. The FIRST "open"
    // merely flushes the handshake we queue synchronously below; every LATER
    // "open" is a reconnect that must re-run the handshake so the doc + presence
    // reconcile (the relay lost our state on its reap). A transport without
    // `onStatus` (the in-process test network) keeps the historical one-shot flow.
    this.unsubscribeStatus = this.transport.onStatus?.((status) => {
      if (status === "open") {
        const reconnected = this.hasOpened;
        this.hasOpened = true;
        if (reconnected) {
          this.resyncRequested = false;
          if (this.desiredPresence !== null) this.awareness.setLocalState(this.desiredPresence);
          this.sendHandshake();
        }
        this.emitStatus("connected");
      } else {
        this.emitStatus("disconnected");
      }
    });

    this.transport.connect();
    this.unsubscribeMessage = this.transport.onMessage((data) => this.handleMessage(data));
    this.doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);

    this.sendHandshake();
  }

  /**
   * Ask for the peer's state (sync step1) + their awareness, and announce our
   * own. Sent on the initial connect and re-sent on every reconnect.
   */
  private sendHandshake(): void {
    this.send((encoder) => {
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeSyncStep1(encoder, this.doc);
    });
    this.send((encoder) => encoding.writeVarUint(encoder, messageQueryAwareness));
    if (this.awareness.getLocalState() !== null) {
      this.send((encoder) => {
        encoding.writeVarUint(encoder, messageAwareness);
        encoding.writeVarUint8Array(
          encoder,
          encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
        );
      });
    }
  }

  /**
   * Observe the link status for the UI (e.g. a "reconnecting…" cue). Fires
   * "connected" on each (re)open and "disconnected" on each drop / explicit
   * `disconnect()`. Returns an unsubscribe.
   */
  onStatus(handler: (status: ConnectionStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private emitStatus(status: ConnectionStatus): void {
    for (const h of [...this.statusHandlers]) h(status);
  }

  /**
   * B2: observe the relay's storage-full control frame — the room refused a
   * growth write, so this peer's edits are no longer reaching the room (they stay
   * saved locally). Mirrors {@link onStatus}: fires once per decoded frame with
   * the mapped {@link StorageFullInfo}; returns an unsubscribe. There is no
   * "storage ok again" frame, so this NEVER fires a recovery — the UI clears its
   * cue on a reconnect edge (see link-status.ts).
   */
  onStorageFull(handler: (info: StorageFullInfo) => void): () => void {
    this.storageFullHandlers.add(handler);
    return () => this.storageFullHandlers.delete(handler);
  }

  private emitStorageFull(info: StorageFullInfo): void {
    for (const h of [...this.storageFullHandlers]) h(info);
  }

  /**
   * L6: user-initiated immediate reconnect (resets the backoff), behind the UI's
   * "Retry now" affordance on the reconnecting cue. Delegates to a reconnect-aware
   * transport; a transport without `retryNow` (e.g. the in-memory test network) is
   * a safe no-op. The transport itself ignores the call unless the link is down.
   */
  retryNow(): void {
    this.transport.retryNow?.();
  }

  /** Whether the relay's initial state has been applied (see {@link syncedOnce}). */
  get synced(): boolean {
    return this.syncedOnce;
  }

  /**
   * Observe the ONE-TIME transition to synced (first relay step2 applied). Fires
   * once. If already synced when subscribed, the handler is invoked immediately so
   * a late subscriber never misses the edge. Returns an unsubscribe.
   */
  onSynced(handler: () => void): () => void {
    if (this.syncedOnce) {
      handler();
      return () => {};
    }
    this.syncedHandlers.add(handler);
    return () => this.syncedHandlers.delete(handler);
  }

  private markSynced(): void {
    if (this.syncedOnce) return; // sticky + fire-once
    this.syncedOnce = true;
    for (const h of [...this.syncedHandlers]) h();
    this.syncedHandlers.clear();
  }

  disconnect(): void {
    if (!this.connected) return;
    // Deterministic departure: clear local awareness BEFORE detaching, so the
    // resulting local 'update' is broadcast and peers drop us at once.
    if (this.awareness.getLocalState() !== null) {
      this.awareness.setLocalState(null);
    }
    this.connected = false;
    this.resyncRequested = false;
    this.hasOpened = false;
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    this.unsubscribeMessage?.();
    this.unsubscribeMessage = undefined;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = undefined;
    this.transport.disconnect();
    this.emitStatus("disconnected");

    // Drop stale remote presence locally: while offline we won't hear peers
    // leave, so don't keep showing them. (origin === this → not re-broadcast.)
    const remote = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
    if (remote.length > 0) removeAwarenessStates(this.awareness, remote, this);
  }

  /** Disconnect and release the awareness instance (clears its internal timer). */
  destroy(): void {
    this.disconnect();
    this.awareness.destroy();
  }

  private handleMessage(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    // A frame may carry several top-level messages (a real server batches them).
    while (decoding.hasContent(decoder)) {
      const messageType = decoding.readVarUint(decoder);
      switch (messageType) {
        case messageSync: {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, messageSync);
          // Applies inbound step2/update to the doc with origin = this (so our
          // own onDocUpdate suppresses the echo) and writes a reply for a step1.
          const syncType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
          // The relay replies step2 to our step1 with the room's existing state —
          // applying it means we're loaded (watch ONLY inbound step2, never the
          // relay's own proactive step1). Empty rooms still send a step2, so this
          // also resolves there. Fire-once + sticky (markSynced).
          if (syncType === syncProtocol.messageYjsSyncStep2) {
            this.markSynced();
          }
          // Only reply if there's a real payload beyond the type byte.
          if (encoding.length(encoder) > 1) {
            this.transport.send(encoding.toUint8Array(encoder));
          }
          // Symmetric reconciliation: a peer asking for our state (step1) means
          // they exist — ask for theirs too, once, so offline-divergent peers
          // converge both ways. Guarded to avoid step1 ping-pong.
          if (syncType === syncProtocol.messageYjsSyncStep1 && !this.resyncRequested) {
            this.resyncRequested = true;
            this.send((e) => {
              encoding.writeVarUint(e, messageSync);
              syncProtocol.writeSyncStep1(e, this.doc);
            });
          }
          break;
        }
        case messageQueryAwareness: {
          this.send((encoder) => {
            encoding.writeVarUint(encoder, messageAwareness);
            encoding.writeVarUint8Array(
              encoder,
              encodeAwarenessUpdate(this.awareness, [...this.awareness.getStates().keys()]),
            );
          });
          break;
        }
        case messageAwareness: {
          applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
          break;
        }
        case messageStorageFull: {
          // B2: the relay refused a growth write (see messageStorageFull). Decode
          // reason + cap and surface via onStorageFull. This case must NOT touch
          // the doc or awareness — a storage frame is NOT peer activity and must
          // never bump the L6 stale timer (which keys on origin === this updates).
          //
          // Fail-soft: a truncated/malformed payload is ignored (never throws,
          // never fires the listener). lib0's readVarUint reads past the buffer
          // end as 0 rather than throwing, so guard each varint with hasContent();
          // the try/catch is a belt-and-braces net against a future lib0 that does
          // throw. On any malformation we `return` — the frame is its own ws frame
          // per the wire contract, so there is nothing after it to keep parsing.
          try {
            if (!decoding.hasContent(decoder)) return; // missing reason
            const reason = decoding.readVarUint(decoder);
            if (!decoding.hasContent(decoder)) return; // missing cap
            const capBytes = decoding.readVarUint(decoder);
            this.emitStorageFull({ reason: storageFullReason(reason), capBytes });
          } catch {
            return;
          }
          break;
        }
        default:
          return; // unknown message type: can't know its length — stop parsing this frame
      }
    }
  }

  private send(write: (encoder: encoding.Encoder) => void): void {
    const encoder = encoding.createEncoder();
    write(encoder);
    this.transport.send(encoding.toUint8Array(encoder));
  }
}
