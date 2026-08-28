/**
 * The Galley collaboration sync server (ADR-0008): a thin, doc-holding y-websocket
 * relay. Per room (the websocket URL path) it keeps a `Y.Doc` + `Awareness`,
 * speaks the standard `y-protocols` sync + awareness messages (the exact bytes
 * `@galley/collab`'s `CollabConnection` sends), and broadcasts each peer's updates
 * to the others. Stateless across restarts BY DEFAULT; an optional `CrdtStore`
 * (B1.3, roadmap S2) makes room state durable — load on room create, append on
 * every relayed update, compact on reap/shutdown. Without it, this is transport
 * only, exactly as before.
 */
import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { createBlobRelay, BLOB_SUBPROTOCOL } from "./blob-handler.js";
import type { CrdtStore } from "@galley/shared";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const messageSync = 0;
const messageAwareness = 1;
const messageQueryAwareness = 3;
// Server→client storage-cap control frame (B2 — per-room storage caps). The
// y-websocket convention is messageSync=0, messageAwareness=1, and reserves 2 for
// auth; messageQueryAwareness=3 is ours. 4 is the next free top-level type. A
// stock client that predates this type ignores it safely: its message loop hits
// `default: return` on an unknown type (packages/collab/src/collab-connection.ts),
// which STOPS parsing the rest of that frame — so this control frame is ALWAYS
// sent as its own ws frame, never batched behind sync/awareness messages.
export const messageStorageFull = 4;

// The messageSync sub-body subtypes (y-protocols/sync.js): a state-vector request
// (SyncStep1) is a READ and never gated; SyncStep2 and Update carry a peer's CRDT
// growth and are the frames the storage-cap admission peek inspects.
const syncStep1 = 0; // SyncStep1 — read/handshake, never gated
const syncStep2 = 1; // SyncStep2 — carries an update payload (growth)
const syncUpdate = 2; // Update — carries an update payload (growth)

/**
 * Why a growth-write was refused, sent in the {@link messageStorageFull} frame.
 * An OPEN enum: a client MUST treat an unknown reason as a generic "write
 * refused" and keep reading (the cap is advisory to the client — enforcement is
 * server-side). 1/2 mean the user is genuinely out of room; 3 is a transient
 * provider fault, NOT "you are out of storage" — clients should retry later.
 */
export const StorageFullReason = {
  /** The room's persisted CRDT content is at/over its per-room byte cap. */
  ContentCap: 1,
  /** The room's raw append-log is at/over the flat hard ceiling even compacted. */
  LogCeiling: 2,
  /** The quota provider is temporarily unavailable (fail-closed for growth). */
  QuotaUnavailable: 3,
} as const;
export type StorageFullReason = (typeof StorageFullReason)[keyof typeof StorageFullReason];

/**
 * Encode a {@link messageStorageFull} control frame. Wire format (its OWN ws
 * frame — see {@link messageStorageFull}):
 *
 *   [varUint type = 4 (messageStorageFull)]
 *   [varUint reason]   // StorageFullReason: 1 content-cap, 2 log-ceiling, 3 unavailable
 *   [varUint cap]      // the relevant byte cap, or 0 when N/A (reason 3)
 *
 * Bounded (two small varints, never attacker-sized) and forward-compatible (new
 * reason codes extend the enum; old clients ignore the whole type). This encoder
 * IS the cross-repo contract for the client-side decoder (a planned follow-up
 * lane consumes it).
 *
 * WHY DECODING THIS IS LOAD-BEARING: y-sync has no per-update acknowledgement, so
 * a refused growth update silently remains client-local — this frame is the ONLY
 * signal a client gets that its edits have stopped reaching the room. Clients that
 * do not decode it will show what looks like working sync while diverging; the
 * next under-cap sync re-offers the full missing diff and heals.
 */
export function encodeStorageFull(reason: StorageFullReason, cap: number): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, messageStorageFull);
  encoding.writeVarUint(enc, reason);
  encoding.writeVarUint(enc, Number.isSafeInteger(cap) && cap > 0 ? cap : 0);
  return encoding.toUint8Array(enc);
}

// Cap the size of a single ws frame. Real CRDT sync/awareness frames are far
// smaller (a few KiB); the ws default is 100 MiB, which an unauthenticated peer
// could use to exhaust memory. 8 MiB leaves generous headroom for a fat initial
// sync while bounding a single hostile frame.
const MAX_WS_PAYLOAD_BYTES = 8 * 1024 * 1024;

// Bound the number of distinct rooms a single process will hold. With auth OFF
// (the default) every distinct ws URL path allocates a Y.Doc + Awareness; an
// unauthenticated attacker could otherwise open unbounded rooms. Reaping empty
// rooms (below) is the primary defense; this cap stops a burst of concurrent
// rooms from exhausting memory before any of them close.
const MAX_ROOMS = 10_000;

// Cap awareness client-ids (L2-S3, a facet of the S1 DoS). A real peer owns one
// client id (its own); the agent-as-peer adds one more — honest frames carry 1–2
// entries. Two layers: a PER-FRAME cap rejected before applyAwarenessUpdate (the
// load-bearing one — it stops a single ≤maxPayload frame from injecting masses of
// states OR `state:null` meta entries, the latter of which apply silently), and a
// cumulative PER-CONNECTION cap on live ids across frames. 64 is far above any
// honest client. On breach we terminate the connection.
const MAX_AWARENESS_CLIENTS_PER_FRAME = 64;
const MAX_AWARENESS_CLIENTS_PER_CONN = 64;

// Cumulative per-ROOM cap on the awareness `meta` map (SEC: awareness meta
// memory-DoS, distinct from SEC-SYNC-1 Y.Doc bloat). `applyAwarenessUpdate`
// writes a PERMANENT `meta` entry for every declared clientID — including
// `state:null` ids, which fire NO 'update' event, so the per-connection
// live-states cap above never sees them and the y-protocols outdated-timeout
// (which only prunes ids present in `states`) never reaps them. The per-FRAME
// cap bounds one frame; across many frames `meta` would otherwise grow without
// bound. We REFUSE a frame (before applying) that would push `meta.size` past
// this ceiling, so it is a hard bound — never overshot. The default is far above
// any honest room (a handful of distinct lifetime peers, each 1–2 entries) —
// ~16k entries ≈ a few hundred KiB — and is tunable via SyncServerOptions for
// deployments that expect very large public share rooms.
const MAX_AWARENESS_META_PER_ROOM = 16_384;

// Per-FRAME cap on the total serialized awareness STATE bytes (SEC: awareness
// state-payload memory-DoS). The id-count caps bound how MANY entries a peer
// retains, not how BIG each retained `states` value is — a peer could send a few
// one-id frames each carrying a large JSON state and pin lots of memory while
// staying under every count cap. Honest presence is tiny (an author + optional
// cursor/role, well under 4 KiB); 16 KiB is generous headroom (4×) while keeping
// the blast radius small. With this and the per-conn live-id cap (64), one
// connection retains at most 64 × 16 KiB ≈ 1 MiB of live state; the per-room meta
// ceiling bounds the room aggregate (meta holds every live id) to
// MAX_AWARENESS_META_PER_ROOM × this ≈ a few hundred MiB worst case. A frame over
// this is refused before applying.
const MAX_AWARENESS_STATE_BYTES_PER_FRAME = 16 * 1024;

// Per-connection message-RATE cap (#22.2 S1, a facet of the DoS surface). With no
// rate limit a single peer can flood unlimited sync/awareness frames and pin a CPU
// / grow room memory. We count messages per sliding window and TERMINATE a peer
// that exceeds the ceiling (the close handler frees its awareness ids + reaps the
// room). The bound is GENEROUS — honest collaborative editing is a few frames per
// keystroke, well under 1k/s even during a fat initial sync; 2000 messages per
// 1s window leaves enormous headroom for legit bursts while still bounding a flood.
// On breach we drop the connection rather than buffering, the same posture the
// awareness cap uses. Default-on but so high it never bites real use.
const RATE_WINDOW_MS = 1_000;
const MAX_MESSAGES_PER_WINDOW = 2_000;

// Storage-cap tuning (B2 — per-room storage caps, all inert unless a StorageQuota
// is configured AND the room persists). A successful per-room caps resolution is
// cached this long before a lazy background re-resolve on the next gated frame
// (reads are NEVER blocked on it); a FAILED resolution is cached for a short
// window so a flapping provider can't be hammered per frame.
const CAPS_TTL_MS = 60_000;
const CAPS_FAIL_TTL_MS = 5_000;
// Hard deadline on a single getCaps resolution. A provider that hangs must not
// pin a room "in flight" forever (that would keep a LOWERED cap from ever taking
// effect, and — before the name-only closure below — retain a reaped room). On
// timeout the attempt settles as a cached FAILURE; the hung promise, if it ever
// settles, loses the race and is discarded. An expired-but-cached "ok" value is
// honored only within a bounded stale-grace window (expiresAt + CAPS_TTL_MS);
// past that a still-unresolved room fails closed (reason 3), so a lowered cap
// cannot be evaded indefinitely by stalling the provider.
const CAPS_RESOLVE_TIMEOUT_MS = 10_000;
// Default compaction high-water floor when a quota omits `compactionFloorBytes`.
// The log is only folded once it exceeds max(this, 2× the exact content size), so
// steady editing never triggers a recompute/compact on the hot path.
const DEFAULT_COMPACTION_FLOOR_BYTES = 16 * 1024 * 1024;

// B1.3: room names double as `CrdtStore` project ids, but they arrive off the
// attacker-controlled ws URL path. Persist ONLY names that are safe storage
// keys — the same charset the fs adapters gate filesystem paths on
// (`packages/persistence/src/fs.ts` SAFE_KEY) — so a hostile room name can
// neither traverse a store's backing nor make its room UNJOINABLE via a store
// id rejection. Every real room id (project UUIDs, `share-…` capabilities)
// passes; anything else simply stays ephemeral, exactly the no-store behavior.
const PERSISTABLE_ROOM_ID = /^[A-Za-z0-9_-]{1,128}$/;

// Transaction origin tagging updates applied FROM the store during a room's
// load. The doc 'update' handler skips appending these (they are already
// persisted) — without the tag, every room re-create would append the whole
// restored log again and storage would snowball.
const RESTORED_FROM_STORE = Symbol("galley-sync-restored-from-store");

type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };

interface Room {
  doc: Y.Doc;
  awareness: Awareness;
  /** Each open connection → the awareness client ids it controls (for cleanup). */
  conns: Map<WebSocket, Set<number>>;
  /**
   * The store persisting this room — set iff `options.crdtStore` is configured
   * AND the room name is a safe storage key (see PERSISTABLE_ROOM_ID). Absent →
   * every branch below takes the exact stateless path.
   */
  store?: CrdtStore;
  /**
   * The load barrier (B1.3): resolves once the persisted log has been restored
   * into `doc`. Present iff `store` is. Every joiner parks on this ONE promise
   * — concurrent joiners share the single in-flight load — so the first
   * syncStep1 a client receives already carries the durable state.
   */
  ready?: Promise<void>;
  /**
   * Set when the persisted-state load failed. Joiners are then refused (1013)
   * rather than served an empty doc they might re-seed over the real state.
   */
  loadFailed?: boolean;
  /**
   * Joiners parked on `ready` that have not yet registered in `conns`. Guards
   * the reap: a room must not be destroyed under a joiner that is about to
   * register (and a room whose parked joiners ALL died must still be reaped,
   * or it would leak — no close handler ever fires for it). Always 0 on the
   * stateless path.
   */
  pendingJoins: number;
  /**
   * Rolling barrier over every `appendUpdate` issued for this room. Appends are
   * fire-and-forget on the relay hot path; compaction (reap/shutdown) chains
   * behind this so it always runs strictly after every append that was issued.
   * Inert (resolved) on the stateless path.
   */
  whenWritten: Promise<void>;
  /**
   * True once at least one append has been ISSUED for this room this lifetime.
   * Reap/shutdown compaction is skipped when nothing new was written — a
   * loaded-then-idle room must not rewrite its snapshot on every reap. Always
   * false on the stateless path.
   */
  dirty: boolean;
  /**
   * Storage accounting (B2). All inert (0/undefined/false) unless a
   * {@link StorageQuota} is configured AND this room persists. `logBytes` tracks
   * the raw append-log size; the admission upper bound on content is
   * `lastExactContentBytes + bytesAppendedSinceExact` (an over-estimate that is
   * cheaply maintained per append and only reconciled to the EXACT
   * `Y.encodeStateAsUpdate(doc).byteLength` when the bound crosses a cap or the
   * compaction high-water fires — never per frame). Invariant: bound ≥ exact.
   */
  logBytes: number;
  lastExactContentBytes: number;
  bytesAppendedSinceExact: number;
  /**
   * Bumped every time `logBytes` is REBASED by a compaction reset. A failed
   * `appendUpdate` rolls its byte count back out of `logBytes` (the write never
   * landed) ONLY if this epoch is unchanged since the append was issued — a
   * compaction in between already recomputed `logBytes` from scratch, so the
   * stale rollback must be skipped (SEC: a transient store outage must not
   * permanently inflate the log counter into false ceiling refusals).
   */
  logEpoch: number;
  /** Cached per-room caps ({@link StorageQuota.getCaps}); undefined until resolved. */
  caps?: CapsCache;
  /** A getCaps resolution is in flight (dedupes the lazy background refresh). */
  capsInFlight: boolean;
  /** A `store.compact` is chained + running (the in-flight flag: no double-fire). */
  compacting: boolean;
  /**
   * Per connection, the LAST storage-full {reason, cap} sent this episode. A frame
   * is emitted whenever either field differs from the last (so a reason TRANSITION
   * — e.g. provider-flap reason 3 becoming a genuine over-cap reason 1 — always
   * re-notifies, since this frame is the client's only divergence signal), and
   * suppressed only for an identical repeat. Cleared when the room leaves the full
   * state (a growth write admits under cap), starting a fresh episode.
   */
  notifiedFull: Map<WebSocket, { reason: StorageFullReason; cap: number }>;
}

export interface SyncServerHandle {
  readonly port: number;
  readonly roomCount: () => number;
  /**
   * Largest awareness `meta` map size across live rooms. An observability hook
   * (used by the awareness-DoS tests to assert the per-room ceiling actually
   * bounds a burst); 0 when no rooms exist.
   */
  readonly maxRoomMetaSize: () => number;
  /**
   * The galley-blob-v1 relay sharing this server's rooms + auth (Phase 1
   * byte-transport). Exposed for observability + tests (room/conn counts); the
   * byte forwarding is internal.
   */
  readonly blobRoomCount: () => number;
  readonly blobConnCount: (room: string) => number;
  /** In-flight blob transfers routed in `room` (0 if absent; tests/observability). */
  readonly blobTransferCount: (room: string) => number;
  /**
   * B2 storage observability (0 for an absent/stateless room). `roomContentBytes`
   * is the admission UPPER BOUND (`lastExactContentBytes + bytesAppendedSinceExact`);
   * `roomExactContentBytes` recomputes the true `Y.encodeStateAsUpdate` size on
   * demand (read-only — it does NOT reset the counters); `roomLogBytes` is the raw
   * append-log size. Used by the storage-cap tests to pin the bound ≥ exact
   * invariant and post-compaction log shrink.
   */
  readonly roomContentBytes: (room: string) => number;
  readonly roomExactContentBytes: (room: string) => number;
  readonly roomLogBytes: (room: string) => number;
  close(): Promise<void>;
}

/**
 * Per-room storage quota provider (B2 — cloud enabler). ABSENT on
 * {@link SyncServerOptions} ⇒ the relay does no storage accounting at all and is
 * byte-for-byte the previous behavior (the admission peek never runs).
 *
 * Applies ONLY to PERSISTED rooms — rooms whose name is a safe storage key AND a
 * `crdtStore` is configured. A stateless room holds nothing server-resident, so a
 * quota is N/A there by definition and is ignored.
 *
 * SCOPE: "content" here means CRDT bytes (the Yjs document). Binary assets/blobs
 * are NOT counted — blobs never persist server-side (a separate ws subprotocol
 * forwards them peer-to-peer), so they never touch a room's `crdtStore`.
 *
 * The shape is a CROSS-REPO CONTRACT (the cloud consumer builds against it
 * verbatim); do not reshape it.
 */
export interface StorageQuota {
  /**
   * Resolve the per-room content cap. A resolved `maxContentBytes` of `undefined`
   * ⇒ UNLIMITED content for that room. A REJECTION/THROW ⇒ the quota is
   * temporarily unavailable: growth-writes fail closed with a DISTINCT signal
   * (StorageFullReason.QuotaUnavailable), never "out of storage" — see the relay's
   * provider-failure semantics. Never blocks reads.
   */
  getCaps(roomId: string): Promise<{ maxContentBytes?: number }>;
  /** Flat raw append-log hard ceiling (bytes). Absent ⇒ no hard ceiling. */
  maxLogBytes?: number;
  /** Compaction high-water floor (bytes); defaults to 16 MiB. */
  compactionFloorBytes?: number;
}

/**
 * Cached per-room result of {@link StorageQuota.getCaps} — a success (with the
 * resolved cap and a soft expiry that triggers a lazy background refresh) or a
 * failure (cached for a short window so a provider flap isn't hammered per frame).
 */
type CapsCache =
  | { kind: "ok"; maxContentBytes: number | undefined; expiresAt: number }
  | { kind: "failed"; until: number };

export interface SyncServerOptions {
  /**
   * Optional authorization gate at the ws upgrade (roadmap #4 slice 5). Returns
   * whether this connection may join `room`. Omitted (the default) → rooms are
   * OPEN, exactly as before (the no-auth local/collab path is unchanged). When
   * provided, a denied connection is closed with 1008 BEFORE any doc data is sent.
   */
  authorizeUpgrade?: (ctx: { room: string; req: IncomingMessage }) => boolean | Promise<boolean>;

  /**
   * Optional Origin allowlist for the ws upgrade (#22.2 S2 — CSWSH defense),
   * mirroring how `apps/compile` consumes `ALLOWED_ORIGINS`. Empty/omitted (the
   * default) → NO Origin check, behavior byte-for-byte unchanged (browsers send an
   * Origin but native ws clients and the local/collab path do not, so a check is
   * opt-in). When non-empty, a ws upgrade whose `Origin` header is absent or not in
   * the list is rejected (close 1008) BEFORE the room is joined — cross-site pages
   * cannot hijack a room even if the relay is network-exposed without a gateway.
   * Fail-closed: a configured allowlist denies anything it does not explicitly list.
   *
   * ONE carve-out (#1 slice 2, only when `capabilityRooms` is ALSO configured —
   * i.e. under `GALLEY_SYNC_AUTH=required`): an upgrade whose Origin is ABSENT is
   * allowed to proceed iff its room is in the reserved capability namespace, and
   * even then it is admitted only if the registry confirms the room ACTIVE. This
   * preserves the cookie-less Node MCP kernel (native ws clients send no Origin)
   * while browsers — which ALWAYS send an Origin — still face the exact-match
   * allowlist. A PRESENT-but-unlisted Origin is denied for every room, capability
   * or not.
   */
  allowedOrigins?: string[];

  /**
   * Capability-room authorization (#1 slice 2) — wired ONLY when
   * `GALLEY_SYNC_AUTH=required` (see server-config.ts); omitted (the default) →
   * behavior byte-for-byte unchanged. When present, the upgrade order is:
   *   (a) parse the room (no join yet);
   *   (b) Origin policy (above, including the absent-Origin capability carve-out);
   *   (c) authorize: a room in the reserved capability namespace
   *       (`isCapabilityRoom`) is admitted iff `authorize` resolves true (active
   *       in the shared registry — NO cookie consulted); any OTHER room takes the
   *       existing `authorizeUpgrade` cookie→session→membership path UNCHANGED;
   *   (d) only then the room cap + join.
   * Authorization happens at the UPGRADE only — never per message — so a
   * revocation denies future joins/reconnects while live connections persist
   * until they disconnect. `authorize` failures/throws fail closed (1008).
   */
  capabilityRooms?: {
    /** Pure namespace predicate — picks the path; MUST NOT touch storage. */
    isCapabilityRoom: (room: string) => boolean;
    /** The registry decision for a capability-namespace room. */
    authorize: (room: string) => boolean | Promise<boolean>;
  };

  /**
   * Cumulative per-room ceiling on the awareness `meta` map (SEC: awareness meta
   * memory-DoS). A connection whose awareness frames push a room's `meta.size`
   * past this is terminated. Defaults to `MAX_AWARENESS_META_PER_ROOM` (16384) —
   * generous vs any honest room; raise it for deployments expecting very large
   * public share rooms, lower it to tighten the bound.
   */
  maxAwarenessMetaPerRoom?: number;

  /**
   * Optional CRDT persistence seam (B1.3, roadmap S2 — relay restart loses no
   * doc state). ABSENT (the default) → the relay stays stateless across
   * restarts, byte-for-byte the previous behavior: every persistence call sits
   * behind this option. When provided (server-config.ts wires an `FsCrdtStore`
   * via `GALLEY_SYNC_PERSIST_DIR`):
   *   - room create LOADS the persisted log and restores it into the fresh doc
   *     BEFORE any joiner's first syncStep1 (concurrent joiners share the one
   *     in-flight load; a failed load refuses joins with 1013, fail closed);
   *   - every relayed doc update is APPENDED as it happens — fire-and-forget on
   *     the hot path, a failed append logs and never crashes the room — so a
   *     CRASH (no graceful close) still loses nothing;
   *   - the log is COMPACTED to one snapshot when an emptied room reaps and,
   *     awaited, on `close()`, so storage does not grow unboundedly.
   * Rooms whose name is not a safe storage key (see PERSISTABLE_ROOM_ID) stay
   * ephemeral rather than unjoinable.
   */
  crdtStore?: CrdtStore;

  /**
   * Optional per-room storage caps (B2 — cloud enabler). ABSENT (the default) ⇒
   * NO storage accounting: the message-loop admission peek never runs and the
   * relay is byte-for-byte the previous behavior. When present it gates GROWTH
   * writes on PERSISTED rooms only (see {@link StorageQuota}): a write that would
   * push a room past its content cap (or the flat log ceiling) is refused BEFORE
   * apply — the doc is unchanged, nothing is appended/rebroadcast, and a typed
   * {@link messageStorageFull} frame is sent while the socket STAYS OPEN so reads
   * and other peers' updates keep flowing (availability over enforcement for data
   * the user already had). Delete-only updates always admit (a user is never
   * locked out of shrinking their own doc).
   */
  storageQuota?: StorageQuota;
}

function sendRaw(ws: WebSocket, data: Uint8Array): void {
  if (ws.readyState === 1 /* OPEN */) ws.send(data);
}

/**
 * Pre-parse an awareness update frame WITHOUT mutating room state, so an abusive
 * frame can be REFUSED before `applyAwarenessUpdate` (SEC: awareness memory-DoS).
 * `ws.terminate()` is asynchronous and cannot stop frames ALREADY QUEUED in the
 * same event-loop turn from mutating room state — so the budget decision has to
 * be made before the mutation, not after. Returns the declared entry count, how
 * many declared ids are NEW to `meta` (i.e. would grow `meta.size`), and the
 * total serialized state bytes. THROWS on a structurally malformed body (the
 * caller drops the frame). The entry walk is bounded: a declared count over the
 * per-frame id cap returns immediately without iterating.
 *
 * NOTE: this does NOT JSON.parse the states. `applyAwarenessUpdate` parses them
 * (and compares duplicates via a recursive deep-equal) and can THROW partway
 * through, after already mutating earlier entries — malformed JSON, a stack-
 * busting deeply-nested state on a duplicate id, etc. We cannot cheaply predict
 * every such throw here, so the caller wraps `applyAwarenessUpdate` in its own
 * try/catch and DROPS the connection on any apply throw (the partial mutation is
 * then bounded by the per-frame + per-room caps, which this pre-parse enforces
 * BEFORE the apply).
 */
export function inspectAwarenessUpdate(
  update: Uint8Array,
  meta: { has: (key: number) => boolean },
): { declared: number; newIds: number; stateBytes: number } {
  const dec = decoding.createDecoder(update);
  const declared = decoding.readVarUint(dec);
  if (declared > MAX_AWARENESS_CLIENTS_PER_FRAME) {
    return { declared, newIds: 0, stateBytes: 0 };
  }
  let newIds = 0;
  let stateBytes = 0;
  for (let i = 0; i < declared; i++) {
    const clientID = decoding.readVarUint(dec);
    decoding.readVarUint(dec); // clock (unused here)
    const state = decoding.readVarString(dec); // JSON state ("null" for state:null)
    stateBytes += Buffer.byteLength(state, "utf8");
    if (!meta.has(clientID)) newIds++;
  }
  return { declared, newIds, stateBytes };
}

function asBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return undefined;
}

/**
 * Start the sync server. `port = 0` binds an ephemeral port (resolved on the
 * handle) — handy for tests. Resolves once the server is listening.
 */
export function startSyncServer(port = 0, options: SyncServerOptions = {}): Promise<SyncServerHandle> {
  const rooms = new Map<string, Room>();
  // Normalize the Origin allowlist once. Empty → the check is OFF (default). A
  // non-empty list is fail-closed: only listed origins (exact match) are allowed.
  const allowedOrigins = (options.allowedOrigins ?? []).filter(Boolean);
  const maxAwarenessMetaPerRoom = Math.max(1, options.maxAwarenessMetaPerRoom ?? MAX_AWARENESS_META_PER_ROOM);
  // Per-room storage caps (B2). ABSENT ⇒ the admission peek + accounting never run
  // and the relay is byte-for-byte the previous behavior. Only ever active for a
  // room that BOTH has this configured AND persists (room.store !== undefined).
  const quota = options.storageQuota;
  // Connections we've decided to terminate for abuse. `ws.terminate()` is async
  // and does NOT stop frames already buffered in this event-loop turn from firing
  // 'message' (ws defaults allowSynchronousEvents:true) — so a single burst could
  // keep mutating room state after the kill decision. We LATCH the connection here
  // and bail at the top of the message handler so no further queued frame from an
  // abusive peer is processed (SEC: bounds the burst, not just the steady rate).
  const dropped = new WeakSet<WebSocket>();
  const drop = (ws: WebSocket): void => {
    dropped.add(ws);
    ws.terminate();
  };
  // A plain HTTP server carries the WebSocket upgrade AND a health endpoint, so
  // orchestrators (k8s) and test harnesses (Playwright's webServer) can poll
  // readiness over HTTP. WebSocket clients connect to ws://host:port/<room>.
  const httpServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("galley-sync ok");
  });
  // Accept the blob subprotocol when a client requests it, so ONE ws endpoint
  // (the same host:port/<room> URL + the same upgrade auth) carries BOTH the
  // y-protocols sync channel (no subprotocol) and the galley-blob-v1 byte channel
  // (`@galley/collab`'s BlobTransport). `handleProtocols` echoes the blob
  // subprotocol back only when offered; an ordinary sync client (offering none)
  // is unchanged. Returning `false` for an offered-but-unknown protocol leaves
  // the connection plain (the sync path), preserving back-compat.
  const handleProtocols = (protocols: Set<string>): string | false =>
    protocols.has(BLOB_SUBPROTOCOL) ? BLOB_SUBPROTOCOL : false;
  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
    handleProtocols,
  });
  // The blob relay shares the sync server's room namespace + auth. A connection
  // only reaches it AFTER the SAME upgrade authorization the sync path uses.
  const blobRelay = createBlobRelay();

  // ── Storage-cap accounting + admission (B2) ────────────────────────────────
  // Every helper below is a no-op unless `quota` is configured AND the room
  // persists; the message loop guards the entry points on both, so none of this
  // runs on the default (byte-identical) path.

  /**
   * Reconcile the cheap append bound to the EXACT content size and reset the
   * incremental counter. Called only on a cap crossing or the compaction
   * high-water — never per frame (the hot-path cost is measured in the tests).
   */
  const recomputeExact = (room: Room): number => {
    const exact = Y.encodeStateAsUpdate(room.doc).byteLength;
    room.lastExactContentBytes = exact;
    room.bytesAppendedSinceExact = 0;
    return exact;
  };

  /**
   * The current exact content size WITHOUT a redundant re-encode. When nothing has
   * been appended since the last reconcile, `bytesAppendedSinceExact === 0` and
   * `lastExactContentBytes` already IS the exact size — so skip the O(doc)
   * `Y.encodeStateAsUpdate`. This is the anti-spam guard: an at-cap peer pays O(1)
   * per refused frame after the first reconcile, not O(doc) — otherwise a bearer
   * (even viewer-role) could force continuous full-doc encodes by spamming tiny
   * over-cap frames within the per-connection rate limit.
   */
  const reconcileExact = (room: Room): number =>
    room.bytesAppendedSinceExact === 0 ? room.lastExactContentBytes : recomputeExact(room);

  /** The room is demonstrably accepting writes → end the full episode. */
  const markUnderCap = (room: Room): void => {
    if (room.notifiedFull.size > 0) room.notifiedFull.clear();
  };

  /**
   * Lazily (re)resolve this room's caps in the BACKGROUND — never awaited on the
   * message path, so reads are never blocked on it. A success is cached with a
   * soft TTL (stale-while-revalidate: the stale value still gates the current
   * frame while a refresh runs); a failure is cached for a short window so a
   * flapping provider is not hit per frame. getCaps rejection/throw is caught.
   *
   * SEC: the getCaps call is DEADLINE-bounded (a hung provider settles as a cached
   * failure instead of pinning the room in flight forever), and the resolution
   * closure captures only the room NAME — never the Room object — writing back via
   * `rooms.get(name)`. So a reaped room is not retained past the deadline, a room
   * recreated under the same name naturally re-resolves, and a late genuine settle
   * loses the Promise.race and is discarded.
   */
  const ensureCaps = (name: string, room: Room, now: number): void => {
    const c = room.caps;
    const fresh = c !== undefined && (c.kind === "ok" ? c.expiresAt > now : c.until > now);
    if (fresh || room.capsInFlight) return;
    room.capsInFlight = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("getCaps deadline")), CAPS_RESOLVE_TIMEOUT_MS);
      timer.unref(); // a pending deadline must never keep the process alive
    });
    // Promise.resolve().then() so a SYNCHRONOUS throw inside getCaps is captured;
    // race against the deadline so a hang cannot outlive CAPS_RESOLVE_TIMEOUT_MS.
    void Promise.race([Promise.resolve().then(() => quota!.getCaps(name)), deadline])
      .then(
        (caps) => {
          const r = rooms.get(name);
          if (r !== undefined) {
            r.caps = { kind: "ok", maxContentBytes: caps.maxContentBytes, expiresAt: Date.now() + CAPS_TTL_MS };
          }
        },
        () => {
          const r = rooms.get(name);
          if (r !== undefined) r.caps = { kind: "failed", until: Date.now() + CAPS_FAIL_TTL_MS };
        },
      )
      .finally(() => {
        clearTimeout(timer); // cancel the deadline if getCaps won the race
        const r = rooms.get(name);
        if (r !== undefined) r.capsInFlight = false;
      });
  };

  /**
   * Fold the append log into one snapshot behind `whenWritten` (strictly after
   * every append issued), guarded by the in-flight flag so a burst never
   * double-fires. On success the counters are reset from a FRESH encode taken
   * AFTER the compact resolves (never a stale snapshot). A FAILED compact leaves
   * every counter unchanged (the room stays effectively full) and logs loudly.
   *
   * SEC (tail preservation): appends accepted WHILE the compact ran chain AFTER
   * the fold, so they are physically in the log but not in the snapshot. We record
   * `logBytes` at schedule time and, on success, re-add whatever accrued since
   * (`tail`) on top of the fresh encode — an UPPER bound (some of the tail may have
   * been folded in) that never UNDER-counts the log, so the high-water can still
   * refire. Otherwise repeated slow-compact + churn cycles would erase the tail and
   * the log would grow unbounded while the counter never crossed the high-water.
   */
  const scheduleCompaction = (name: string, room: Room): void => {
    const store = room.store;
    if (store === undefined || room.compacting) return;
    room.compacting = true;
    const logBytesAtSchedule = room.logBytes;
    room.whenWritten = room.whenWritten
      .then(() => store.compact(name))
      .then(
        () => {
          // The last peer may have disconnected mid-compaction, reaping (and
          // DESTROYING) the room's doc. Re-encoding a destroyed doc is meaningless
          // (and unsafe) — skip; the counters die with the room.
          if (rooms.get(name) !== room) return;
          const freshEncode = Y.encodeStateAsUpdate(room.doc).byteLength;
          const tail = Math.max(0, room.logBytes - logBytesAtSchedule); // bytes appended since schedule
          room.logBytes = freshEncode + tail;
          room.lastExactContentBytes = freshEncode;
          room.bytesAppendedSinceExact = tail; // upper bound → preserves bound ≥ exact
          room.logEpoch++; // rebased: any in-flight append's failure-rollback is now stale
        },
        () => {
          // eslint-disable-next-line no-console
          console.error("[galley/sync] failed to compact persisted room state");
        },
      )
      .finally(() => {
        room.compacting = false;
      });
  };

  /**
   * Compaction high-water trigger, checked on every append. The log is folded
   * only once it exceeds max(floor, 2× the exact content size), so steady editing
   * never triggers a recompute/compact — the fresh exact is re-checked before a
   * fold is scheduled so a large single write does not spuriously compact.
   */
  const maybeCompact = (name: string, room: Room): void => {
    if (room.store === undefined || room.compacting) return;
    const floor = quota!.compactionFloorBytes ?? DEFAULT_COMPACTION_FLOOR_BYTES;
    if (room.logBytes <= Math.max(floor, 2 * room.lastExactContentBytes)) return;
    const exact = recomputeExact(room);
    if (room.logBytes <= Math.max(floor, 2 * exact)) return;
    scheduleCompaction(name, room);
  };

  type GrowthDecision = { admit: true } | { admit: false; reason: StorageFullReason; cap: number };

  /**
   * Decide whether a growth write of `declaredLen` incoming payload bytes may be
   * admitted. Fail-closed order: (3) quota unavailable, (2) raw-log hard ceiling
   * measured against the COMPACTED footprint, (1) per-room content cap. An
   * under-cap admit ends the full episode; a genuine over-cap refusal does not.
   * Does NOT apply anything — the caller performs the delete-escape + apply.
   */
  const evaluateGrowth = (name: string, room: Room, declaredLen: number, now: number): GrowthDecision => {
    const caps = room.caps;
    if (
      caps === undefined ||
      caps.kind === "failed" ||
      // An expired "ok" value gates only within a bounded stale-grace window; past
      // it, a still-unresolved room fails closed so a LOWERED cap cannot be evaded
      // indefinitely by stalling the provider (SEC — the refresh is already kicked
      // by ensureCaps; reads are never affected, only growth writes).
      now > caps.expiresAt + CAPS_TTL_MS
    ) {
      // Never yet resolved, a cached provider failure, or a past-grace stale value:
      // fail closed for GROWTH with a DISTINCT reason — a transient flap or a hung
      // provider must never read as "out of space".
      return { admit: false, reason: StorageFullReason.QuotaUnavailable, cap: 0 };
    }
    const maxContent = caps.maxContentBytes; // undefined ⇒ unlimited content
    const maxLog = quota!.maxLogBytes;

    // (2) Hard log ceiling — the ceiling is about the COMPACTED footprint, so a
    // merely bloated history is relieved by compaction, not a refusal. `reconcileExact`
    // skips the re-encode when the counter is already 0 (at-cap spam pays O(1)).
    if (maxLog !== undefined && room.logBytes + declaredLen > maxLog) {
      const exact = reconcileExact(room);
      if (exact + declaredLen > maxLog) {
        return { admit: false, reason: StorageFullReason.LogCeiling, cap: maxLog };
      }
      scheduleCompaction(name, room); // compactable under the ceiling → relieve + admit
    }

    // (1) Content cap.
    if (maxContent === undefined) {
      markUnderCap(room);
      return { admit: true };
    }
    const bound = room.lastExactContentBytes + room.bytesAppendedSinceExact;
    if (bound + declaredLen <= maxContent) {
      markUnderCap(room);
      return { admit: true };
    }
    // The cheap bound crossed the cap — reconcile to the exact size before
    // rejecting, so a stale (delete-inflated) bound never causes a false reject.
    // `reconcileExact` re-encodes ONLY when the counter is non-zero (real drift);
    // an at-cap spammer whose state hasn't changed pays O(1), not O(doc).
    const exact = reconcileExact(room);
    if (exact + declaredLen <= maxContent) {
      markUnderCap(room);
      return { admit: true };
    }
    return { admit: false, reason: StorageFullReason.ContentCap, cap: maxContent };
  };

  /**
   * Send a storage-full frame (its own ws frame) unless it is IDENTICAL to the one
   * this connection last received this episode. A reason/cap TRANSITION always
   * re-notifies — a provider-flap reason 3 that becomes a genuine over-cap reason 1
   * must reach the client, since this frame is its only divergence signal — while
   * an identical repeat is suppressed to avoid flooding.
   */
  const emitStorageFull = (room: Room, ws: WebSocket, reason: StorageFullReason, cap: number): void => {
    const last = room.notifiedFull.get(ws);
    if (last !== undefined && last.reason === reason && last.cap === cap) return;
    room.notifiedFull.set(ws, { reason, cap });
    sendRaw(ws, encodeStorageFull(reason, cap));
  };

  /**
   * Refuse-before-apply admission peek for a messageSync sub-body (B2). The outer
   * loop has just read the top-level messageSync type; `decoder.pos` sits at the
   * sub-body `[subtype][varUint8Array payload]`. On ADMIT the decoder is left
   * UNTOUCHED (the caller runs the normal readSyncMessage apply); on REFUSE the
   * sub-body is consumed off the real decoder (nothing applied) and, for a genuine
   * over-cap/unavailable refusal, one storage-full frame is emitted. Reads
   * (SyncStep1) and delete-only updates always admit.
   */
  const admitSyncFrame = (
    decoder: ReturnType<typeof decoding.createDecoder>,
    name: string,
    room: Room,
    ws: WebSocket,
  ): boolean => {
    let subtype: number;
    let declaredLen: number;
    let remaining: number;
    try {
      const peek = decoding.clone(decoder);
      subtype = decoding.readVarUint(peek);
      if (subtype !== syncStep2 && subtype !== syncUpdate) {
        // SyncStep1 (read) or any non-growth subtype: never gated.
        return true;
      }
      declaredLen = decoding.readVarUint(peek);
      remaining = peek.arr.byteLength - peek.pos;
      if (declaredLen > remaining) {
        // Lying length prefix: refuse safely — nothing applied, no crash. The body
        // can't be trusted to re-parse, so consume the rest of the frame.
        decoder.pos = decoder.arr.byteLength;
        return false;
      }
      const now = Date.now();
      ensureCaps(name, room, now);
      const decision = evaluateGrowth(name, room, declaredLen, now);
      if (decision.admit) return true; // decoder untouched → caller applies

      // Over budget by the cap/ceiling/availability check — but a DELETE-ONLY
      // update is always admitted (a user is never locked out of shrinking their
      // own doc; Yjs tombstones may still grow the encode — accepted overshoot).
      const payload = decoding.readUint8Array(peek, declaredLen);
      let deleteOnly = false;
      try {
        deleteOnly = Y.decodeUpdate(payload).structs.length === 0;
      } catch {
        deleteOnly = false; // malformed update → not a safe delete; refuse
      }
      if (deleteOnly) return true; // admit; decoder untouched

      // Genuine refusal: skip the sub-body on the REAL decoder (no apply) and emit
      // one storage-full frame for this episode.
      decoding.readVarUint(decoder); // subtype
      decoding.readVarUint8Array(decoder); // payload (declaredLen ≤ remaining — safe)
      emitStorageFull(room, ws, decision.reason, decision.cap);
      return false;
    } catch {
      // A structurally malformed sub-body: nothing applied. Consume the rest of the
      // frame so the outer loop terminates cleanly (matches the outer catch posture).
      decoder.pos = decoder.arr.byteLength;
      return false;
    }
  };

  const getRoom = (name: string): Room => {
    const existing = rooms.get(name);
    if (existing !== undefined) return existing;

    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    awareness.setLocalState(null); // the server holds no presence of its own
    const conns = new Map<WebSocket, Set<number>>();
    // B1.3: this room persists iff a store is configured AND its name is a safe
    // storage key; otherwise `persist` is undefined and every branch below is
    // the exact stateless path.
    const persist =
      options.crdtStore !== undefined && PERSISTABLE_ROOM_ID.test(name)
        ? options.crdtStore
        : undefined;
    const room: Room = {
      doc,
      awareness,
      conns,
      pendingJoins: 0,
      whenWritten: Promise.resolve(),
      dirty: false,
      logBytes: 0,
      lastExactContentBytes: 0,
      bytesAppendedSinceExact: 0,
      logEpoch: 0,
      capsInFlight: false,
      compacting: false,
      notifiedFull: new Map<WebSocket, { reason: StorageFullReason; cap: number }>(),
    };
    if (persist !== undefined) room.store = persist;

    // Relay a doc change to every connection EXCEPT the one that caused it.
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      // Append-on-update (B1.3): persist each peer-produced update as it relays.
      // Fire-and-forget — the relay hot path must not block on IO, and a failed
      // append must never crash the room (logged with a FIXED message; this file
      // never logs room names) — but the promise chains onto `whenWritten` so
      // compaction always runs strictly after every append that was issued.
      // Updates applied FROM the store during the room's load are skipped: they
      // are already persisted, and re-appending them would snowball the log.
      if (persist !== undefined && origin !== RESTORED_FROM_STORE) {
        room.dirty = true;
        // Storage accounting (B2): count the EMITTED bytes (what lands in the log)
        // into both the raw-log size and the cheap content upper bound.
        const appendedBytes = update.byteLength;
        const epochAtAppend = room.logEpoch;
        if (quota !== undefined) {
          room.logBytes += appendedBytes;
          room.bytesAppendedSinceExact += appendedBytes;
        }
        const written = persist.appendUpdate(name, update).catch(() => {
          // eslint-disable-next-line no-console
          console.error("[galley/sync] failed to persist a CRDT update");
          // SEC: the LOG write never landed, so roll its bytes back out of the log
          // counter — otherwise a transient store outage permanently inflates
          // `logBytes` into false log-ceiling refusals + spurious compactions. Skip
          // if a compaction rebased the counter meanwhile (epoch changed). The
          // CONTENT counters stay: the update IS applied in memory (the doc grew).
          if (quota !== undefined && room.logEpoch === epochAtAppend) {
            room.logBytes = Math.max(0, room.logBytes - appendedBytes);
          }
        });
        room.whenWritten = room.whenWritten.then(() => written);
        // Fold the log if it has outgrown its snapshot (B2). Called AFTER the
        // append is chained onto `whenWritten` so the compact runs strictly after
        // the append that triggered it.
        if (quota !== undefined) maybeCompact(name, room);
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      const frame = encoding.toUint8Array(encoder);
      for (const conn of conns.keys()) if (conn !== origin) sendRaw(conn, frame);
    });

    // Relay awareness changes, tracking which client ids each connection owns.
    awareness.on("update", ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
      if (origin !== null && conns.has(origin as WebSocket)) {
        const ws = origin as WebSocket;
        const owned = conns.get(ws)!;
        // Derive ownership from the FINAL state, not the raw add/remove arrays: a
        // crafted frame can list the same id as added AND removed, which would
        // otherwise leave `owned` out of sync with what's actually live (and so
        // missed by close-cleanup). An id is owned iff it has a live state now.
        for (const id of new Set([...added, ...updated, ...removed])) {
          if (awareness.getStates().has(id)) owned.add(id);
          else owned.delete(id);
        }
        // Cumulative per-connection cap (L2-S3): a peer that accrues an implausible
        // number of LIVE awareness ids across frames is abusive — terminate it
        // (the close handler frees the ids it owns). The PER-FRAME cap in the
        // message handler bounds a single-frame burst; this bounds the running sum.
        if (owned.size > MAX_AWARENESS_CLIENTS_PER_CONN) {
          drop(ws);
        }
      }
      const changed = [...added, ...updated, ...removed];
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, changed));
      const frame = encoding.toUint8Array(encoder);
      for (const conn of conns.keys()) if (conn !== origin) sendRaw(conn, frame);
    });

    if (persist !== undefined) {
      // Load-on-room-create (B1.3): restore the persisted log into the fresh
      // doc BEFORE any joiner is admitted — `proceed` parks every joiner on
      // this ONE promise, so the first syncStep1 a client receives already
      // carries the durable state, and concurrent joiners never trigger a
      // second load. A failed load REFUSES joins (fail closed) rather than
      // silently serving an empty doc a client might re-seed over real state.
      room.ready = (async () => {
        try {
          const updates = await persist.loadUpdates(name);
          for (const u of updates) Y.applyUpdate(doc, u, RESTORED_FROM_STORE);
          // Storage accounting init (B2): seed the counters from the LOADED log so
          // an already-over-cap room refuses growth immediately after a restart.
          // The restore updates fired `doc.on("update")` with RESTORED_FROM_STORE
          // origin (skipped there), so we set the baseline exactly once here. Kick
          // off an eager caps resolution (fire-and-forget, never awaited — reads
          // must not block on it) so caps are settled before the first growth frame.
          if (quota !== undefined) {
            let loaded = 0;
            for (const u of updates) loaded += u.byteLength;
            room.logBytes = loaded;
            room.lastExactContentBytes = Y.encodeStateAsUpdate(doc).byteLength;
            room.bytesAppendedSinceExact = 0;
            ensureCaps(name, room, Date.now());
          }
        } catch {
          room.loadFailed = true;
          // eslint-disable-next-line no-console
          console.error("[galley/sync] failed to load persisted room state; refusing joins");
        }
      })();
    }

    rooms.set(name, room);
    return room;
  };

  /**
   * Tear a room down: drop it from the map, compact its persisted log, free the
   * doc. Idempotent via the identity guard — a same-name room created after this
   * one was reaped must not be clobbered, and a second reap of the same room is a
   * no-op. The map entry is dropped FIRST so a (theoretical) throw from destroy()
   * can't leave a dead room lingering in the map.
   */
  const reapRoom = (name: string, room: Room): void => {
    if (rooms.get(name) !== room) return;
    rooms.delete(name);
    // Compact-on-reap (B1.3, replaces the old persistence TODO): fold the room's
    // append log into ONE snapshot so storage doesn't grow unboundedly across
    // sessions. Chained behind `whenWritten` so it runs strictly after every
    // append that was issued; fire-and-forget (nothing awaits a reap) and a
    // failure only logs — compaction is an optimization, the appends already
    // made the state durable. Skipped when the load failed (there is nothing
    // trustworthy to fold) or nothing was appended this lifetime (an idle
    // reload must not rewrite its snapshot on every reap).
    const store = room.store;
    if (store !== undefined && !room.loadFailed && room.dirty) {
      void room.whenWritten.then(() =>
        store.compact(name).catch(() => {
          // eslint-disable-next-line no-console
          console.error("[galley/sync] failed to compact persisted room state");
        }),
      );
    }
    room.awareness.destroy();
    room.doc.destroy();
  };

  /** Reap `room` iff nobody is connected AND nobody is parked on its load barrier. */
  const reapRoomIfEmpty = (name: string, room: Room): void => {
    if (room.conns.size === 0 && room.pendingJoins === 0) reapRoom(name, room);
  };

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    ws.binaryType = "arraybuffer";
    const roomName = (req.url ?? "/").slice(1).split("?")[0] || "default";

    // Attach an error handler IMMEDIATELY (#22.2 S6). The `ws` receiver emits
    // 'error' on protocol-level faults a hostile peer can trigger — an over-cap
    // frame (RangeError: Max payload size exceeded), malformed WS framing, an abrupt
    // RST. On an EventEmitter an 'error' with NO listener is re-thrown and crashes
    // the whole relay process. Swallowing it here (the socket is closed by ws
    // itself) downgrades a one-frame process-kill to a single dropped connection.
    ws.on("error", () => {
      /* protocol-level socket error: ws closes the socket; don't let it crash the process */
    });

    // (#1 slice 2) Which authorization path does this room take? A pure
    // NAMESPACE test only — the registry is consulted later, in step (c).
    const cap = options.capabilityRooms;
    const isCapabilityRoom = cap !== undefined && cap.isCapabilityRoom(roomName);

    // Origin allowlist (default OFF; #22.2 S2 — CSWSH defense). Checked BEFORE the
    // auth gate and any room join: a cross-site page (wrong/absent Origin) is closed
    // 1008 and never reaches a room. When no allowlist is configured this is a no-op.
    //
    // Capability carve-out (#1 slice 2, active only when `capabilityRooms` is
    // configured): an ABSENT Origin may proceed for a capability-namespace room —
    // native ws clients (the cookie-less Node MCP kernel) send no Origin, while
    // browsers always do — and such a room is still admitted only if the registry
    // confirms it ACTIVE below. A PRESENT Origin must exact-match the allowlist
    // for every room; without the capability option this branch is byte-for-byte
    // the previous absent-Origin deny.
    const origin = req.headers.origin;
    if (allowedOrigins.length > 0) {
      if (origin !== undefined) {
        if (!allowedOrigins.includes(origin)) {
          ws.close(1008, "forbidden origin");
          return;
        }
      } else if (!isCapabilityRoom) {
        ws.close(1008, "forbidden origin");
        return;
      }
    }

    // Authorization gate (default OFF). Resolve the decision BEFORE touching the
    // room or sending any doc data; a denied connection is closed (1008) and never
    // joins. Errors fail closed.
    const proceed = (): void => {
      // The client may have disconnected while an async gate was pending — don't
      // resurrect a room/connection for a dead socket (resource leak).
      if (ws.readyState !== 1 /* OPEN */) return;
      // The blob channel (galley-blob-v1 subprotocol) takes the SAME room + the
      // SAME auth gate as the sync socket, but routes to the near-stateless blob
      // relay — it never allocates a Y.Doc/Awareness Room. Authorization has
      // already passed at this point (this is inside the authorized path).
      if (ws.protocol === BLOB_SUBPROTOCOL) {
        blobRelay.handleConnection(ws, roomName);
        return;
      }
      // Reject creation of a NEW room past the cap (existing rooms still join):
      // 1013 = "try again later". This only bites a flood of distinct rooms; a
      // normal single-room collab session is unaffected.
      if (!rooms.has(roomName) && rooms.size >= MAX_ROOMS) {
        ws.close(1013, "too many rooms");
        return;
      }
      const room = getRoom(roomName);
      if (room.ready === undefined) {
        // Stateless room (no store, or an unsafe-key room): join immediately —
        // byte-for-byte the previous behavior.
        room.conns.set(ws, new Set());
        onAuthorized(ws, roomName, room);
        return;
      }
      // Load barrier (B1.3): park this joiner until the persisted state has
      // been restored into the doc, so the FIRST syncStep1 it receives already
      // carries the durable state (a client synced against an empty doc could
      // otherwise briefly render — or re-seed — a blank document). Every
      // concurrent joiner parks on the SAME promise; auth already passed
      // (proceed() is only reached on the authorized path).
      room.pendingJoins++;
      void room.ready.then(() => {
        room.pendingJoins--;
        if (rooms.get(roomName) !== room) {
          // The room was torn down while this joiner was parked (server
          // shutdown, or a failed-load reap by an earlier parked joiner).
          ws.close(1013, "room unavailable");
          return;
        }
        if (room.loadFailed) {
          // Fail closed: never serve an empty doc a client might re-seed over
          // the real persisted state. 1013 = "try again later"; the failed
          // room is reaped once its parked joiners drain, so a later join
          // RETRIES the load fresh (a transient store fault heals itself).
          ws.close(1013, "room state unavailable");
          reapRoomIfEmpty(roomName, room);
          return;
        }
        if (ws.readyState !== 1 /* OPEN */) {
          // The joiner died while parked. Don't register a dead socket — and
          // reap the room if it now has nobody, because no close handler will
          // ever fire for a joiner that never registered (it would leak).
          reapRoomIfEmpty(roomName, room);
          return;
        }
        room.conns.set(ws, new Set());
        onAuthorized(ws, roomName, room);
      });
    };
    // (c) Capability-namespace rooms (#1 slice 2): admitted iff ACTIVE in the
    // registry — NO cookie/session/membership consulted (the share-link joiner
    // and the Node kernel hold only the room capability). This path NEVER falls
    // through to the cookie gate: an unregistered/revoked/expired capability
    // room is denied even if the connection carries a valid session cookie
    // (fail closed — old pre-auth links die until re-shared). Errors (sync or
    // async) fail closed, mirroring the cookie gate below.
    if (isCapabilityRoom) {
      void (async () => {
        let allowed = false;
        try {
          allowed = await cap!.authorize(roomName);
        } catch {
          allowed = false;
        }
        if (allowed) proceed();
        else ws.close(1008, "unauthorized");
      })();
      return;
    }

    const gate = options.authorizeUpgrade;
    if (gate === undefined) {
      proceed();
    } else {
      // Async IIFE so a SYNCHRONOUS throw in the gate is caught too (it would
      // otherwise escape before any .catch attaches). Any failure → fail closed.
      void (async () => {
        let allowed = false;
        try {
          allowed = await gate({ room: roomName, req });
        } catch {
          allowed = false;
        }
        if (allowed) proceed();
        else ws.close(1008, "unauthorized");
      })();
    }
  });

  function onAuthorized(ws: WebSocket, roomName: string, room: Room): void {

    // Initial sync: server -> client step1, plus any current awareness.
    const hello = encoding.createEncoder();
    encoding.writeVarUint(hello, messageSync);
    syncProtocol.writeSyncStep1(hello, room.doc);
    sendRaw(ws, encoding.toUint8Array(hello));
    if (room.awareness.getStates().size > 0) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, messageAwareness);
      encoding.writeVarUint8Array(
        enc,
        encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]),
      );
      sendRaw(ws, encoding.toUint8Array(enc));
    }

    // Per-connection sliding-window message-rate counter (#22.2 S1). A peer that
    // exceeds MAX_MESSAGES_PER_WINDOW within RATE_WINDOW_MS is flooding — terminate
    // it (the close handler frees its awareness ids + reaps the room). The window
    // resets lazily on the first message after it elapses; no timers to leak.
    let windowStart = Date.now();
    let windowCount = 0;

    ws.addEventListener("message", (event: unknown) => {
      // A connection latched for abuse must not process ANY further queued frame
      // (terminate() can't stop already-buffered 'message' events) — bail first.
      if (dropped.has(ws)) return;
      const now = Date.now();
      if (now - windowStart >= RATE_WINDOW_MS) {
        windowStart = now;
        windowCount = 0;
      }
      if (++windowCount > MAX_MESSAGES_PER_WINDOW) {
        drop(ws);
        return; // flooding peer dropped; do not parse this frame
      }
      const data = asBytes((event as { data?: unknown }).data);
      if (data === undefined) return;
      const decoder = decoding.createDecoder(data);
      // A hostile peer can send a structurally MALFORMED frame (truncated varint,
      // a sync/awareness body that runs off the end of the buffer, etc). The lib0
      // decoder THROWS on those ("Unexpected end of array"), and a throw out of this
      // message listener is an uncaught exception that crashes the relay process
      // (#22.2 S5 — a one-frame DoS). Honest @galley/collab peers never send such
      // frames, so we simply DROP a frame that fails to parse and keep the conn
      // alive. The decoder advances destructively, so a partial parse can't be
      // resumed safely — bail the whole frame on any error.
      try {
        while (decoding.hasContent(decoder)) {
          // A batched sub-message may have just tripped a cap (drop) — stop
          // processing the rest of this frame the moment we've latched.
          if (dropped.has(ws)) return;
          const type = decoding.readVarUint(decoder);
          if (type === messageSync) {
            // Storage-cap admission peek (B2) — ONLY on a persisted room with a
            // quota, so the default path never clones/peeks. On refuse the sub-body
            // is consumed and any storage-full frame emitted; `continue` skips the
            // apply. On admit the decoder is untouched and the apply runs as before.
            if (quota !== undefined && room.store !== undefined) {
              if (!admitSyncFrame(decoder, roomName, room, ws)) continue;
            }
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, messageSync);
            // origin = ws: the doc 'update' handler then skips echoing to ws.
            syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws);
            if (encoding.length(encoder) > 1) sendRaw(ws, encoding.toUint8Array(encoder));
          } else if (type === messageQueryAwareness) {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, messageAwareness);
            encoding.writeVarUint8Array(
              encoder,
              encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]),
            );
            sendRaw(ws, encoding.toUint8Array(encoder));
          } else if (type === messageAwareness) {
            const awarenessUpdate = decoding.readVarUint8Array(decoder);
            // REFUSE-BEFORE-MUTATE (SEC: awareness memory-DoS — meta-count AND
            // state-payload). applyAwarenessUpdate writes a permanent `meta` entry
            // for every declared id (including `state:null` ids that fire no
            // 'update', so the per-conn live-states cap never sees them) and
            // retains each id's state bytes. terminate() can't unwind a mutation
            // already applied this turn, so we INSPECT the frame first and reject
            // any that (a) over-declares ids, (b) carries too many state bytes, or
            // (c) would push the room's `meta.size` past the ceiling — latching the
            // peer (drop) so its queued frames stop here. An honest client sends
            // 1–2 small entries that re-declare existing ids (newIds = 0).
            let info: { declared: number; newIds: number; stateBytes: number };
            try {
              info = inspectAwarenessUpdate(awarenessUpdate, room.awareness.meta);
            } catch {
              // A structurally malformed awareness sub-body — nothing was applied,
              // so just drop this FRAME and keep the connection, matching the outer
              // catch's "a transient bad frame shouldn't kill an honest session"
              // posture (a sustained flood is bounded by the per-conn rate cap).
              return;
            }
            if (
              info.declared > MAX_AWARENESS_CLIENTS_PER_FRAME ||
              info.stateBytes > MAX_AWARENESS_STATE_BYTES_PER_FRAME ||
              room.awareness.meta.size + info.newIds > maxAwarenessMetaPerRoom
            ) {
              drop(ws);
              return; // never apply an over-budget frame
            }
            // applyAwarenessUpdate parses each state and deep-compares duplicates,
            // so it can THROW partway — after mutating earlier entries and WITHOUT
            // firing 'update' (so the per-conn live-id cap would never see the
            // retained state). A budget-passing frame that still makes apply throw
            // is anomalous/abusive: latch + drop the peer. The partial mutation it
            // left behind is bounded by the per-frame + per-room caps enforced
            // above (and counts toward the meta ceiling, so it can't be repeated
            // past the bound). An honest, well-formed frame never throws here.
            try {
              applyAwarenessUpdate(room.awareness, awarenessUpdate, ws);
            } catch {
              drop(ws);
              return;
            }
          } else {
            return; // unknown type: can't know its length — stop parsing this frame
          }
        }
      } catch {
        // Malformed frame (truncated / over-running body). Drop it; the connection
        // stays alive so a transient bad frame doesn't kill an honest session, and
        // a hostile flood of bad frames is bounded by the per-conn rate cap above.
        return;
      }
    });

    ws.addEventListener("close", () => {
      const owned = room.conns.get(ws);
      room.conns.delete(ws);
      room.notifiedFull.delete(ws); // B2: drop this conn's storage-full episode latch
      if (owned !== undefined && owned.size > 0) {
        removeAwarenessStates(room.awareness, [...owned], null); // tell remaining peers
      }
      // Reap an emptied room so distinct ws paths don't permanently accumulate a
      // Y.Doc + Awareness (a memory-DoS vector with auth OFF). Awareness states
      // are already cleared above. `reapRoomIfEmpty` also holds the room open
      // while a parked joiner (B1.3 load barrier) is about to register, and
      // compacts the room's persisted log when a store is wired — the appends
      // already made every update durable, so the reap only FOLDS the log, it
      // never races data onto disk.
      reapRoomIfEmpty(roomName, room);
    });
  }

  return new Promise((resolve) => {
    httpServer.listen(port, () => {
      const address = httpServer.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        port: boundPort,
        roomCount: () => rooms.size,
        maxRoomMetaSize: () => {
          let max = 0;
          for (const room of rooms.values()) {
            const size = room.awareness.meta.size;
            if (size > max) max = size;
          }
          return max;
        },
        blobRoomCount: () => blobRelay.roomCount(),
        blobConnCount: (room: string) => blobRelay.connCount(room),
        blobTransferCount: (room: string) => blobRelay.transferCount(room),
        roomContentBytes: (room: string) => {
          const r = rooms.get(room);
          return r === undefined ? 0 : r.lastExactContentBytes + r.bytesAppendedSinceExact;
        },
        roomExactContentBytes: (room: string) => {
          const r = rooms.get(room);
          return r === undefined ? 0 : Y.encodeStateAsUpdate(r.doc).byteLength;
        },
        roomLogBytes: (room: string) => {
          const r = rooms.get(room);
          return r === undefined ? 0 : r.logBytes;
        },
        close: () =>
          new Promise<void>((res, rej) => {
            blobRelay.closeAll();
            // Flush-on-shutdown (B1.3): compact every persisted room's log to
            // ONE snapshot, chained behind its `whenWritten` barrier (strictly
            // after every append that was issued) and AWAITED before this
            // promise resolves — a graceful shutdown never races process exit.
            // Same skips as the reap: failed loads and never-dirtied rooms.
            const flushes: Promise<void>[] = [];
            for (const [name, room] of rooms) {
              for (const conn of room.conns.keys()) conn.close();
              const store = room.store;
              if (store !== undefined && !room.loadFailed && room.dirty) {
                flushes.push(
                  room.whenWritten.then(() =>
                    store.compact(name).catch(() => {
                      // eslint-disable-next-line no-console
                      console.error("[galley/sync] failed to compact persisted room state");
                    }),
                  ),
                );
              }
              // Destroying the doc BEFORE the flush settles is safe: compaction
              // reads the STORE, never the doc — and it stops any late-queued
              // frame from appending after the flush barrier was captured.
              room.awareness.destroy();
              room.doc.destroy();
            }
            // Clear the map NOW: the ws close events still in flight must not
            // re-reap (and re-compact) these rooms, and a joiner parked on a
            // load barrier must see the shutdown instead of registering onto a
            // destroyed doc.
            rooms.clear();
            void Promise.all(flushes).then(() =>
              wss.close(() => httpServer.close((err) => (err ? rej(err) : res()))),
            );
          }),
      });
    });
  });
}
