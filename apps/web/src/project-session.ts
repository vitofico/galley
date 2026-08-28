/**
 * Multi-file PROJECT session wiring for the web app (roadmap #2, ADR-0013).
 * FLAG-GATED behind `?project=1` (default OFF), so the single-file and `?collab=1`
 * paths are untouched.
 *
 * This is the single-file `createCollabSession` generalized to a `CollabProject`
 * (many files in one `Y.Doc`). It reuses the SAME seams: the `DraftStore`
 * persistence seam (y-indexeddb) over the project doc, the `CollabConnection`
 * sync (which already syncs a whole `Y.Doc`), and per-peer `registerAuthor`. Seed
 * order matches single-file: persistence loads → `seedIfPristine` → `registerAuthor`.
 */
import {
  CollabProject,
  CollabConnection,
  WebSocketTransport,
  registerAuthor,
  renameAuthor,
  projectInstructionsFromTree,
  planBlobDemand,
  planBlobServe,
  decodeWantList,
  BLOB_WANTS_FIELD,
  BLOB_WANT_BATCH_MAX,
  type SeedFile,
  type WebSocketLike,
  type BinaryAsset,
  type BlobStore,
  type BlobPointer,
  type PeerBlobWant,
  type ProjectSnapshot,
  type BlobTerminalSigner,
  type BlobTerminalVerifier,
} from "@galley/collab";
import { createBlobChannelSession, type BlobChannelSession } from "./blob-session.js";
import { scheduleBlobSweep } from "./blob-gc.js";
import {
  isReservedProjectPath,
  isSafeProjectPath,
  type Author,
  type VersionedFile,
  type VersionStore,
} from "@galley/shared";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { authorColor, authorLabel } from "./attribution-style.js";
import { capabilityAuthActive, ensureShareRoomRegistered } from "./capability-rooms-client.js";
import {
  applyMinimalDiff,
  createIndexeddbDraftStore,
  type CollabConfig,
  type CollabDeps,
} from "./collab-session.js";
import { IdbVersionStore } from "./idb-version-store.js";
import { writeProjectInstructions } from "./instructions-write.js";
import { seedDemoHistory } from "./seed-demo-history.js";
import type { ShareRole } from "./share.js";

/** Project-session deps: the collab seams plus the version store (#20.2). */
export interface ProjectSessionDeps extends CollabDeps {
  /**
   * Version store receiving the demo history after a TRUE first seed (#20.2).
   * Tests inject a fake; the default is the browser IndexedDB-backed store —
   * constructed lazily, only when a fresh seed actually happened.
   */
  versionStore?: VersionStore;
  /**
   * Seed the Einstein 1905 demo version history after a TRUE first seed
   * (project-model redesign §2). Carried from the pending seed
   * (`seed.demoHistory`) — only the Einstein template path sets it. When false
   * (blank / import / every other project), a fresh seed writes ZERO demo
   * versions. Default false: a fresh project is blank, not the demo.
   */
  demoHistory?: boolean;
  /**
   * Optional display name for THIS peer's human author (#19.4 joiner identity).
   * Carried on the `Author` (additive `name` field) so it registers into the
   * replicated authors map and travels with presence — peers see a real name in
   * the Share popover and per-file attribution. Absent → anonymous "Editor".
   */
  displayName?: string;
  /**
   * The project's content-addressed blob store (Phase 1 byte-transport). When
   * provided AND the session is CONNECTED (or later Shared), the galley-blob-v1
   * byte channel is opened for the same room: VERIFIED inbound blobs (from the
   * MCP kernel / a collaborator) are stored here, and `session.blobChannel.send`
   * pushes local blobs out. Optional + additive — omitting it (every existing
   * test + the local-only path) opens NO blob channel, so behavior is unchanged.
   */
  blobStore?: BlobStore;
  /** Injectable blob-channel socket factory (tests); defaults to a browser WebSocket. */
  blobSocketFactory?: (url: string) => WebSocketLike;
}

export interface ProjectSession {
  project: CollabProject;
  awareness: Awareness;
  /**
   * This peer's human identity, registered in the doc-global authors map at
   * creation. Reused (never re-minted) when the session is live-upgraded to a
   * shared connection — `registerAuthor` is write-once per Yjs clientID, so a
   * fresh author here would throw. See {@link connectProjectSession}.
   */
  author: Author;
  /** Present only in CONNECTED mode (set at creation, or by a live Share upgrade). */
  connection: CollabConnection | undefined;
  /**
   * The access level THIS peer's live connection was ESTABLISHED with
   * (B19-sharing-roles) — the SOURCE OF TRUTH for the session role. The host's
   * Share upgrade sets it to `editor`; a joiner booting connected sets it from
   * their link's decoded `config.role`. Undefined while local (no connection) and
   * for legacy connects that passed no role (the caller then falls back to the
   * fail-closed `?role=` parse via {@link resolveSessionRole}). Set ALONGSIDE
   * `connection`, never read when `connection` is undefined.
   */
  role?: ShareRole;
  /**
   * The galley-blob-v1 byte channel (Phase 1), present only when a `blobStore`
   * was supplied AND the session is connected/shared. `send(bytes,hash,mime)`
   * pushes a local blob to the room; inbound verified blobs are stored in the
   * provided `blobStore`. Undefined on the local-only path.
   */
  blobChannel?: BlobChannelSession;
  /** Resolves once persistence has loaded and the seed-if-pristine has run. */
  whenReady: Promise<void>;
  /**
   * The raw local-persistence load — REJECTS if the draft store failed to
   * initialize (vs `whenReady`, which catches it so seeding proceeds). Present
   * only in LOCAL mode (where IndexedDB is the sole durability); undefined in
   * CONNECTED mode (the relay is authoritative, the cache only an optimization).
   * Drives the save badge's C1 `at-risk` state.
   */
  whenPersisted?: Promise<void>;
  destroy(): void;
}

/** A short, stable-ish random id for this browser tab's human identity. */
function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** A y-codemirror.next `user` field (name + cursor color) derived from an author. */
function userField(author: Author): { name: string; color: string } {
  return { name: authorLabel(author), color: authorColor(author) };
}

/** This peer's human author: a fresh tab-local id, plus the display name if any. */
function mintHumanAuthor(displayName: string | undefined): Author {
  const name = displayName?.trim();
  return { kind: "human", userId: randomId(), ...(name ? { name } : {}) };
}

/**
 * Create a multi-file project session. Mirrors `createCollabSession`:
 *  - LOCAL (no `?sync=`): a `CollabProject` persisted to IndexedDB; the doc starts
 *    EMPTY and is seeded with `initialFiles` ONLY after the store loads and ONLY
 *    if the doc is pristine (no re-seed of a restored draft).
 *  - CONNECTED (`?sync=`): join an `apps/sync` room over a `WebSocketTransport`.
 *    The relay stays the shared authority — NO `seedIfPristine` and NO demo
 *    history — but the joiner ALSO keeps a room-scoped IndexedDB replica
 *    (`galley-connected-project-v1-*`, a namespace distinct from the LOCAL
 *    draft store) so their edits survive a relay restart/reap. The replica is
 *    pure cache: the CRDT merges it with relay state commutatively on every
 *    connect, and `destroy()` detaches the provider but KEEPS the data.
 */
export function createProjectSession(
  initialFiles: SeedFile[],
  mainPath: string,
  config: CollabConfig,
  deps: ProjectSessionDeps = {},
): ProjectSession {
  const connected = config.syncUrl !== undefined;

  if (!connected) {
    const project = new CollabProject();
    const awareness = new Awareness(project.doc);
    const author: Author = mintHumanAuthor(deps.displayName);
    const dbName = `galley-local-project-v1-${config.room ?? "default"}`;
    const store = (deps.draftStore ?? createIndexeddbDraftStore)(dbName, project.doc);
    const whenReady = store.whenSynced
      .catch(() => undefined)
      .then(async () => {
        // Seed FIRST (registering an author writes history, which would suppress a
        // pristine-gated seed), THEN record this peer's clientID → author.
        const created = project.seedIfPristine(initialFiles, mainPath, author);
        registerAuthor(project, author);
        // project-model redesign §2: a TRUE first seed (non-null return — the
        // doc was pristine and was seeded by THIS boot) seeds the demo's four
        // 1905 versions ONLY when this is the Einstein template path
        // (`deps.demoHistory`). Blank/import/default projects seed zero demo
        // versions. NEVER triggered by an empty version list alone: a restored
        // project returns null above and is untouched. `seedDemoHistory` is
        // fail-soft and additionally guards exactly-once.
        if (created !== null && deps.demoHistory === true) {
          // Same projectId derivation as ProjectApp's HistoryPanel wiring.
          const versionStore = deps.versionStore ?? new IdbVersionStore();
          await seedDemoHistory(versionStore, config.room ?? "default");
        }
      });
    // GC (wave-13): reclaim orphan blobs once the CRDT is HYDRATED — a local session
    // is hydrated after `whenReady` (persistence loaded + seed run). Never before:
    // sweeping a pristine/pre-load doc would wrongly delete blobs referenced by
    // about-to-load pointers. A no-op unless a sweepable blob store was supplied.
    scheduleBlobSweep(whenReady, deps.blobStore, () => project.snapshot());
    const session: ProjectSession = {
      project,
      awareness,
      author,
      connection: undefined,
      whenReady,
      // C1: the RAW load (rejects on failure) drives the at-risk save badge.
      // `whenReady` already attached a `.catch`, so this shared promise's
      // rejection is handled — no unhandled-rejection warning.
      whenPersisted: store.whenSynced,
      destroy() {
        // Close a connection added by a later Share upgrade, too.
        session.connection?.destroy();
        store.destroy();
        awareness.destroy();
        project.destroy();
      },
    };
    return session;
  }

  // CONNECTED mode: the relay is the shared authority, but the joiner ALSO keeps
  // a room-scoped local IndexedDB cache (#2a, 2026-06-15 audit). Before, a joiner
  // held NO local copy — their edits lived only in the relay's RAM, so a relay
  // restart/crash or last-disconnect reap destroyed them. The cache is a pure
  // replica: NO seedIfPristine and NO demo-history seeding in connected mode (the
  // relay/host state is authoritative; the CRDT merges the cached copy and the
  // relay state commutatively on connect and on every reconnect).
  const project = new CollabProject();
  const author: Author = mintHumanAuthor(deps.displayName);
  const url = `${config.syncUrl!.replace(/\/+$/, "")}/${encodeURIComponent(config.room ?? "default")}`;
  const makeSocket = deps.socketFactory ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike);
  // Distinct namespace from the LOCAL `galley-local-project-v1-*` draft store so a
  // joiner's replica never collides with a locally-owned project of the same room.
  const cacheDbName = `galley-connected-project-v1-${config.room ?? "default"}`;
  const store = (deps.draftStore ?? createIndexeddbDraftStore)(cacheDbName, project.doc);
  // B19-sharing-roles: a CONNECTED boot (a joiner opening a `?sync=` link) carries
  // its decoded `config.role` onto presence so the HOST sees a "Viewer" badge in
  // the room roster. Additive + back-compat: an absent/editor role adds no field,
  // so a pre-role join's presence is byte-for-byte unchanged.
  const connection = new CollabConnection(
    project,
    new WebSocketTransport(() => makeSocket(url)),
    { author, user: userField(author), ...(config.role ? { role: config.role } : {}) },
  );
  connection.connect();
  registerAuthor(project, author);
  // galley-blob-v1 byte channel (Phase 1): when a blob store is supplied, open the
  // side channel for the SAME room (same URL shape + relay auth gate) so binary
  // bytes flow beside the CRDT without bloating its log. Additive: omitting
  // `blobStore` opens no channel.
  let blobChannel: BlobChannelSession | undefined;
  let blobSync: BlobSyncHandle | undefined;
  if (deps.blobStore !== undefined) {
    const blobStore = deps.blobStore;
    blobChannel = createBlobChannelSession(config.syncUrl!, config.room ?? "default", blobStore, {
      ...(deps.blobSocketFactory ? { socketFactory: deps.blobSocketFactory } : {}),
      // §4.6: a verified inbound blob just landed → replan so its (now-present) hash is
      // unexpected + dropped from the want-list. Received bytes are stored NEUTRAL by the
      // channel's `put`; this never grants a servable marker.
      onInboundStored: () => blobSync?.notifyInbound(),
    });
    blobChannel.connect();
    // D1 online-only blob-sync: discover missing blobs over awareness + serve ONLY
    // locally-provenanced (servable) blobs over the byte channel. Torn down with the
    // session (before the connection, so the awareness withdrawal still lands).
    blobSync = wireBlobSync({
      awareness: connection.awareness,
      clientId: project.doc.clientID,
      snapshot: () => project.snapshot(),
      store: blobStore,
      channel: blobChannel,
      subscribeDoc: (cb) => {
        const h = (): void => cb();
        project.doc.on("update", h);
        return () => project.doc.off("update", h);
      },
      subscribeAwareness: (cb) => subscribePeerAwareness(connection.awareness, project.doc.clientID, cb),
      subscribeSynced: (cb) => connection.onSynced(cb),
    });
  }
  // GC (wave-13, Security round #4): destructive orphan GC runs ONLY for a
  // LOCAL/OFFLINE (solo) project, where the snapshot is the authoritative reference
  // set and there is no hostile peer. A CONNECTED session NEVER sweeps: the doc is
  // peer-writable and its replica hydrates asynchronously, so a sweep could race a
  // late-arriving pointer and delete a still-referenced blob. Quota enforcement
  // (idb-blob-store) still applies in connected mode — only the destructive sweep
  // is skipped here.
  return {
    project,
    awareness: connection.awareness,
    author,
    connection,
    // B19: the joiner's effective role is the one their link decoded (already
    // fail-closed by `parseShareRole` in readCollabConfig). Recorded on the
    // session so `resolveSessionRole` reads the connection — not a re-parse — as
    // the source of truth.
    ...(config.role ? { role: config.role } : {}),
    ...(blobChannel !== undefined ? { blobChannel } : {}),
    // Surface the cache load so a caller can await a restored replica instead of
    // assuming an empty doc. Fail-soft: a cache error must never block the join.
    whenReady: store.whenSynced.catch(() => undefined),
    destroy() {
      // Tear down blob-sync FIRST (while the connection's awareness is still live) so
      // the want-list withdrawal + expectation release actually land.
      blobSync?.destroy();
      blobChannel?.destroy();
      connection.destroy();
      // Detach the cache provider but KEEP its data — the joiner's replica must
      // survive across sessions (y-indexeddb destroy() stops syncing, not delete).
      store.destroy();
      project.destroy();
    },
  };
}

/**
 * Live-upgrade a LOCAL project session to a SHARED one (roadmap #14-C) — the
 * machinery behind the project shell's "Share" button, so collaboration is an
 * explicit one-click action and never the default.
 *
 * Unlike the CONNECTED branch of {@link createProjectSession} (which joins an
 * empty doc, server-authoritative), this binds a `CollabConnection` to the
 * EXISTING, content-bearing project: a `CollabConnection` syncs the whole
 * `Y.Doc`, and the symmetric step-1 handshake pushes the local content up to the
 * (empty) freshly-minted room with no re-seed, preserving file ids, history, and
 * attribution. The local IndexedDB persistence stays attached as a cache (a
 * pragmatic continuity exception to ADR-0011's connected-mode no-persistence
 * stance — the server is still the shared authority).
 *
 * The author is REUSED from the session (write-once per clientID), so attribution
 * keeps crossing the wire. Idempotent: a second call returns the existing
 * connection rather than opening a duplicate socket.
 */
export function connectProjectSession(
  session: ProjectSession,
  syncUrl: string,
  room: string,
  deps: CollabDeps = {},
  /**
   * The access level THIS peer is sharing/joining at (B19-sharing-roles). Carried
   * on presence so the room roster can show viewer vs editor. Optional + additive
   * — absent means the historical "everyone edits" share (the editor default).
   */
  role?: "viewer" | "editor",
  /**
   * Optional galley-blob-v1 byte channel for the live Share upgrade (Phase 1
   * byte-transport, rework §F). Supplied as a SEPARATE optional arg — NOT folded
   * into the shared `CollabDeps` interface — so adding the blob channel here
   * churns nothing for the dozens of existing `connectProjectSession` callers.
   * When `store` is provided, the same room's blob channel is opened beside the
   * sync connection and set on `session.blobChannel` (destroyed by the session's
   * destroy / stop-sharing). Omitted ⇒ no blob channel, behavior unchanged.
   */
  blobOpts?: {
    store: BlobStore;
    socketFactory?: (url: string) => WebSocketLike;
    /**
     * A1 export channel: the grant-scoped blob-terminal {signer, verifier} (built
     * from the per-grant responseKey + scope in control-responder-mount.ts). When
     * supplied, the blob channel ENFORCES authenticated completion — the browser
     * (the SENDER of the exported PDF) resolves a push ONLY on a MAC-verified
     * COMPLETE, so a forged/unsigned COMPLETE from a 3rd room peer cannot make the
     * browser believe its push delivered. Omitted ⇒ advisory completion (unchanged).
     */
    terminalSigner?: BlobTerminalSigner;
    terminalVerifier?: BlobTerminalVerifier;
  },
): CollabConnection {
  if (session.connection) return session.connection;
  const author = session.author;
  const url = `${syncUrl.replace(/\/+$/, "")}/${encodeURIComponent(room)}`;
  const makeSocket = deps.socketFactory ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike);
  const connection = new CollabConnection(
    session.project,
    new WebSocketTransport(() => makeSocket(url)),
    { author, user: userField(author), ...(role ? { role } : {}) },
  );
  if (capabilityAuthActive()) {
    // #1 slice 2 — REGISTER BEFORE CONNECT: under an auth-required deployment
    // the relay only admits capability rooms that are ACTIVE in the registry,
    // so the freshly minted room must be registered (a cookie-authenticated
    // POST by this signed-in host) before the socket ever opens. On failure
    // the connection is simply never connected — no doc bytes leave this tab,
    // and the Share popover (watching the same tracker) holds the link back
    // and surfaces the error instead. With auth OFF this branch is never
    // taken: connect() runs synchronously exactly as before.
    void ensureShareRoomRegistered(room).then((result) => {
      // The user may have hit "Stop sharing" while registration was in
      // flight — never connect a detached connection.
      if (result.ok && session.connection === connection) connection.connect();
    });
  } else {
    connection.connect();
  }
  // Idempotent for the SAME identity (this peer was registered at creation); this
  // re-affirms the clientID → author entry so it's in the state pushed to the room.
  registerAuthor(session.project, author);
  session.connection = connection;
  // B19: record the role this peer's live Share/upgrade connected with (the host
  // is always "editor"; an agent-share re-attach likewise). `resolveSessionRole`
  // reads THIS — the connection is the source of truth — so the owner is never
  // mistaken for a fail-closed viewer just because a connection now exists. A
  // legacy connect that passed no role leaves it unset (the caller then falls back
  // to the fail-closed `?role=` parse).
  if (role) session.role = role;
  else delete session.role;
  // §F: open the blob channel for the live Share upgrade when a store is given,
  // mirroring the CONNECTED branch. The session.destroy / disconnect tears it down.
  if (blobOpts?.store !== undefined && session.blobChannel === undefined) {
    const blobStore = blobOpts.store;
    let sync: BlobSyncHandle | undefined;
    // §4.6: a verified inbound blob just landed → replan so its (now-present) hash is
    // unexpected + dropped from the want-list. (This live-Share `blobOpts` shape carries
    // no caller inbound hook, so there is nothing to compose here.)
    const channel = openBlobChannel(syncUrl, room, {
      ...blobOpts,
      onInboundStored: () => sync?.notifyInbound(),
    });
    session.blobChannel = channel;
    // D1 online-only blob-sync over the freshly-opened share channel (same servable-only
    // policy as the CONNECTED branch). Fold its teardown into the channel's destroy so it
    // dies wherever the channel does (stop-sharing / session destroy) — and BEFORE the
    // connection tears down, so the awareness withdrawal lands.
    sync = wireBlobSync({
      awareness: connection.awareness,
      clientId: session.project.doc.clientID,
      snapshot: () => session.project.snapshot(),
      store: blobStore,
      channel,
      subscribeDoc: (cb) => {
        const h = (): void => cb();
        session.project.doc.on("update", h);
        return () => session.project.doc.off("update", h);
      },
      subscribeAwareness: (cb) =>
        subscribePeerAwareness(connection.awareness, session.project.doc.clientID, cb),
      subscribeSynced: (cb) => connection.onSynced(cb),
    });
    const innerDestroy = channel.destroy;
    channel.destroy = (): void => {
      sync?.destroy();
      innerDestroy();
    };
  }
  return connection;
}

/** The blobOpts shape shared by connect + the A1 channel-auth guarantee. */
export interface AgentBlobOpts {
  store: BlobStore;
  socketFactory?: (url: string) => WebSocketLike;
  terminalSigner?: BlobTerminalSigner;
  terminalVerifier?: BlobTerminalVerifier;
  /** A2/C1a: delivery hook — fired with `{hash,size}` after a verified inbound blob is stored. */
  onInboundStored?: (hash: string, size: number) => void;
  /**
   * A1 §1: a stable identity of the terminal-auth SCOPE (the grant the
   * signer/verifier were built for). Carried onto the created channel so the
   * channel-auth guarantee can recreate it when the scope CHANGES (a re-consent
   * minted a new grantId) — never keep a verifier bound to a stale key. Absent on
   * the advisory (no-verifier) path.
   */
  terminalScopeId?: string;
}

/** Build (and connect) a blob channel from `blobOpts` — terminal-auth'd when supplied. */
function openBlobChannel(syncUrl: string, room: string, blobOpts: AgentBlobOpts): BlobChannelSession {
  const channel = createBlobChannelSession(syncUrl, room, blobOpts.store, {
    ...(blobOpts.socketFactory ? { socketFactory: blobOpts.socketFactory } : {}),
    // A1: enforce authenticated completion when the grant-scoped terminal auth is
    // supplied — the SENDER (browser) rejects a forged/unsigned COMPLETE.
    ...(blobOpts.terminalSigner ? { terminalSigner: blobOpts.terminalSigner } : {}),
    ...(blobOpts.terminalVerifier ? { terminalVerifier: blobOpts.terminalVerifier } : {}),
    ...(blobOpts.terminalScopeId !== undefined ? { terminalScopeId: blobOpts.terminalScopeId } : {}),
    ...(blobOpts.onInboundStored !== undefined ? { onInboundStored: blobOpts.onInboundStored } : {}),
  });
  channel.connect();
  return channel;
}

/**
 * A1 §1 channel-auth GUARANTEE. Ensure the session's blob channel is TERMINAL-
 * AUTHENTICATED for the EXACT agent grant scope before an agent export pushes over
 * it. Two hazards:
 *   - a plain Share opened the channel earlier with `{store}`-only (advisory) opts
 *     — pushing an agent export over THAT channel re-exposes the forged-COMPLETE
 *     DoS; and
 *   - the grant scope CHANGED while the share stayed connected (a revoke + re-
 *     consent mints a NEW grantId) — a channel still bound to the OLD scope's
 *     verifier would REJECT the new kernel's legitimately-signed COMPLETE, failing
 *     the export closed until a reload.
 * So when an authenticated `blobOpts` is supplied (terminal verifier present) and
 * the live channel is ABSENT, ADVISORY, or built for a DIFFERENT scope identity,
 * destroy + recreate it with the new-scope auth. No-op ONLY when the live channel
 * is authenticated AND its `terminalScopeId` EXACTLY matches the requested one. Also
 * a no-op when `blobOpts` is undefined or carries no verifier (no agent session →
 * nothing to upgrade). Returns the live channel (or undefined when none could be
 * established).
 */
export function ensureAuthenticatedBlobChannel(
  session: ProjectSession,
  syncUrl: string,
  room: string,
  blobOpts: AgentBlobOpts | undefined,
): BlobChannelSession | undefined {
  if (blobOpts?.store === undefined) return session.blobChannel;
  const live = session.blobChannel;
  // No verifier in the opts → cannot authenticate; leave the channel untouched
  // (the export path will refuse to push over an unauthenticated channel).
  if (blobOpts.terminalVerifier === undefined) return live;
  // Already enforced FOR THE SAME SCOPE → no-op. A scope MISMATCH (a re-consent
  // minted a new grantId) must NOT short-circuit — fall through to recreate with
  // the new-scope auth so the verifier matches the new kernel's signing key.
  if (
    live !== undefined &&
    live.authenticated &&
    live.terminalScopeId !== undefined &&
    live.terminalScopeId === blobOpts.terminalScopeId
  ) {
    return live;
  }
  // Absent OR advisory OR stale-scope → (re)build with the requested-scope auth.
  if (live !== undefined) live.destroy();
  session.blobChannel = openBlobChannel(syncUrl, room, blobOpts);
  return session.blobChannel;
}

// ===========================================================================
// D1 online-only blob-sync (servable-provenance trust model, wave 14)
// ===========================================================================

/** The awareness surface the blob-sync loop needs (structural, so tests can fake it). */
interface BlobSyncAwareness {
  getStates(): Map<number, Record<string, unknown>>;
  setLocalStateField(field: string, value: unknown): void;
}

/**
 * Injectable deps for {@link wireBlobSync} — every I/O seam is passed in for testing.
 *
 * THE SPLIT IS LOAD-BEARING: the peer-writable `snapshot` feeds ONLY the REQUESTER's
 * demand (what bytes do *I* need). The HOLDER's serve authority is
 * `store.isServable(hash) && store.has(hash)` — a durable, device-local grant AND the
 * verified bytes present — and is DELIBERATELY NOT derived from the snapshot. Feeding
 * snapshot pointers as serve authority is exactly the pre-Accept exfiltration bug the
 * servable-provenance model exists to close.
 */
export interface BlobSyncDeps {
  awareness: BlobSyncAwareness;
  /** This peer's Yjs clientID — its OWN want-list is excluded from the holder scan. */
  clientId: number;
  /** The project snapshot — REQUESTER demand ONLY (binary pointers, incl. tombstoned). */
  snapshot: () => ProjectSnapshot;
  /**
   * Blob-store seams. `isServable` AND `has` together are the SOLE holder serve
   * authority; `get` reads the bytes to send. `has` also answers the requester's
   * "what am I missing". The snapshot is deliberately never a serve input.
   */
  store: Pick<BlobStore, "has" | "get" | "isServable">;
  channel: Pick<BlobChannelSession, "expect" | "unexpect" | "send">;
  /** Subscribe to doc updates (binary-pointer changes); returns an unsubscribe. */
  subscribeDoc: (cb: () => void) => () => void;
  /** Subscribe to peer awareness changes; returns an unsubscribe. */
  subscribeAwareness: (cb: () => void) => () => void;
  /** Subscribe to the connection's first-sync signal; returns an unsubscribe. */
  subscribeSynced: (cb: () => void) => () => void;
  /** Mint a rotating requestId (tests inject deterministic ids). Defaults to random. */
  mintRequestId?: () => string;
}

export interface BlobSyncHandle {
  /** Run ONE planning pass now (also the internal trigger target). Awaitable for tests. */
  replan(): Promise<void>;
  /**
   * Signal that local blob PRESENCE changed out-of-band — a verified inbound blob was
   * just stored (§4.6). Bumps the demand generation and schedules a replan so a
   * now-present hash is `unexpect`ed and dropped from the advertised want-list at once,
   * closing the window where we keep advertising a blob we already hold.
   */
  notifyInbound(): void;
  /** Detach listeners, withdraw the want-list, release live expectations. Idempotent. */
  destroy(): void;
}

/**
 * Wire the Phase-1 "D1" online-only blob-sync loop over a CONNECTED session's
 * awareness + byte channel — the session-layer counterpart to the pure
 * {@link planBlobDemand} (requester) + {@link planBlobServe} (holder). On first sync,
 * on binary-pointer changes, on peer-awareness changes, and on inbound storage it:
 *
 *   - (REQUESTER) reconciles EXACT expectations against a fresh demand generation:
 *     `unexpect` a hash whose last pointer disappeared / became locally available /
 *     changed size; `expect` newly-referenced-and-missing hashes; then advertise ONLY
 *     the hashes whose `expect()` was ACCEPTED, via `setLocalStateField` (touching
 *     just {@link BLOB_WANTS_FIELD} — cursor/author presence survives). Withdrawals
 *     happen BEFORE the awareness write.
 *   - (HOLDER) serves bytes for a peer's want ONLY when
 *     `isServable(hash) && has(hash)` — a durable local grant AND the bytes present.
 *     The peer-writable snapshot is NEVER consulted for serve authority. Work is
 *     bounded per `(clientId, hash)` to 2 attempts (initial + one retry); `requestId`
 *     carries NO authorization or dedup meaning. Multiple requesters for one hash
 *     collapse into ONE broadcast, recording every `(clientId, hash)` as attempted.
 *
 * STALE-GENERATION SUPPRESSION: because the store checks are async, a demand-changing
 * event during a pass's `has()`/`isServable()` awaits bumps a generation counter; a
 * plan whose captured generation went stale performs NO side effects (no
 * expect/unexpect/advertise/serve) — a fresh rerun is always already queued. This
 * closes the orphan-fill + re-advertise-after-withdraw findings.
 *
 * Zero server change: discovery is awareness presence, transfer is the existing byte
 * channel. Best-effort; the bounded retry covers a transient send failure.
 */
export function wireBlobSync(deps: BlobSyncDeps): BlobSyncHandle {
  const mintRequestId = deps.mintRequestId ?? randomId;
  // Currently-registered transport expectations: hash → asserted size. The exact
  // set we have `expect()`ed on the channel (and advertise). Reconciled every pass.
  const activeExpects = new Map<string, number>();
  // Per-connected-session serve ledger, keyed `${clientId} ${hash}` → attempt count
  // (cap 2). Its lifetime IS this session — a reconnect / new Yjs clientID mints a
  // fresh wireBlobSync and thus a fresh ledger. `requestId` never keys it.
  const attempts = new Map<string, number>();
  // Hashes with a broadcast in flight — a transient guard so overlapping passes don't
  // double-broadcast the SAME bytes (distinct from the durable attempt ledger).
  const inFlight = new Set<string>();
  let currentRequestId = mintRequestId();
  let lastWantSig = ""; // signature of the last-published want set ("" = nothing wanted)
  let lastBinarySig = binarySig(deps.snapshot());
  // Demand generation: bumped by every demand-relevant trigger (binary-pointer change,
  // first sync, inbound storage). A plan captures it before its awaits and bails if it
  // moved — so a stale snapshot can never re-advertise a withdrawn pointer.
  let demandGen = 0;
  let disposed = false;

  const attemptKey = (clientId: number, hash: string): string => `${clientId} ${hash}`;
  const attemptCount = (clientId: number, hash: string): number =>
    attempts.get(attemptKey(clientId, hash)) ?? 0;
  const reserveAttempt = (clientId: number, hash: string): void => {
    const k = attemptKey(clientId, hash);
    attempts.set(k, (attempts.get(k) ?? 0) + 1);
  };

  const doPlan = async (): Promise<void> => {
    if (disposed) return;
    // Capture the generation of the snapshot we are about to read. Reading the
    // snapshot + collecting pointers is synchronous, so no trigger can interleave
    // until the first `await` below.
    const planGen = demandGen;
    const snap = deps.snapshot();

    // REQUESTER demand: every binary pointer (INCLUDING tombstoned — their bytes are
    // retained for restore), deduped by hash. Snapshot state is used HERE and ONLY here.
    const demandPointers: BlobPointer[] = [];
    const seen = new Set<string>();
    for (const f of snap.binaryFiles ?? []) {
      if (!seen.has(f.hash)) {
        seen.add(f.hash);
        demandPointers.push({ hash: f.hash, size: f.size });
      }
    }

    // Presence of referenced hashes (bounded by binary count).
    const present = new Set<string>();
    await Promise.all(
      demandPointers.map(async (p) => {
        if (await deps.store.has(p.hash)) present.add(p.hash);
      }),
    );

    // HOLDER inputs: peer want-lists from awareness (self EXCLUDED, malformed dropped
    // wholesale through the SAME decode gate the planner uses).
    const peerWants: PeerBlobWant[] = [];
    for (const [cid, state] of deps.awareness.getStates()) {
      if (cid === deps.clientId) continue;
      const wl = decodeWantList((state as Record<string, unknown>)[BLOB_WANTS_FIELD]);
      if (wl !== undefined) peerWants.push({ clientId: cid, wants: wl });
    }
    // Serve authority = SERVABLE marker AND bytes held. Computed only for hashes a
    // peer actually wants (bounds the async work; the decode already caps each list).
    const wanted = new Set<string>();
    for (const pw of peerWants) for (const h of pw.wants.hashes) wanted.add(h);
    const servable = new Set<string>();
    await Promise.all(
      [...wanted].map(async (h) => {
        if ((await deps.store.isServable(h)) && (await deps.store.has(h))) servable.add(h);
      }),
    );

    // STALE-GENERATION GUARD: a demand-changing trigger fired during the awaits above,
    // so this plan is stale — perform NO side effects. A rerun is already queued (every
    // demand bump also `schedule()`s), so the fresh snapshot is handled next.
    if (disposed || planGen !== demandGen) return;

    // ---- REQUESTER: exact expectation reconciliation --------------------------------
    const demand = planBlobDemand({
      local: demandPointers,
      has: (h) => present.has(h),
      requestId: currentRequestId,
    });
    const wantSize = new Map<string, number>();
    for (const e of demand.toExpect) wantSize.set(e.hash, e.size);

    // 1. WITHDRAW: unexpect a hash whose last pointer disappeared, became locally
    //    available (so it left the missing set), or whose asserted size changed.
    for (const [hash, size] of [...activeExpects]) {
      const nextSize = wantSize.get(hash);
      if (nextSize === undefined || nextSize !== size) {
        deps.channel.unexpect(hash, size);
        activeExpects.delete(hash);
      }
    }
    // 2. REGISTER: expect newly-demanded hashes; keep ONLY those the channel ACCEPTED
    //    (a quota-refused `expect()` returns false → we must not advertise it).
    for (const [hash, size] of wantSize) {
      if (!activeExpects.has(hash)) {
        if (deps.channel.expect(hash, size)) activeExpects.set(hash, size);
      }
    }
    // 3. ADVERTISE (AFTER withdrawals): the want-list is the ACCEPTED expectations only,
    //    sorted + capped. Rotate requestId + write awareness ONLY when the set changed —
    //    re-publishing an unchanged set would loop our own awareness observer.
    const wantHashes = [...activeExpects.keys()].sort().slice(0, BLOB_WANT_BATCH_MAX);
    const wantSig = wantHashes.join(",");
    if (wantSig !== lastWantSig) {
      lastWantSig = wantSig;
      currentRequestId = mintRequestId();
      // setLocalStateField touches ONLY this field — cursor/author presence survives.
      deps.awareness.setLocalStateField(
        BLOB_WANTS_FIELD,
        wantHashes.length > 0
          ? { v: 1, requestId: currentRequestId, hashes: wantHashes }
          : null,
      );
    }

    // ---- HOLDER: serve servable+held bytes for peers' wants -------------------------
    const serve = planBlobServe({
      servableHeld: (h) => servable.has(h),
      peerWants,
      serveAttempts: attemptCount,
    });
    // Coalesce by hash: ONE broadcast per hash, but reserve an attempt for EVERY current
    // requester (clientId, hash) — recording them all as attempted. RESERVE before the
    // async get/send so a re-trigger sees the consumed budget (cap 2 = initial + retry).
    const broadcast = new Map<string, number[]>();
    for (const s of serve.toSend) {
      const arr = broadcast.get(s.hash);
      if (arr) arr.push(s.clientId);
      else broadcast.set(s.hash, [s.clientId]);
    }
    for (const [hash, clientIds] of broadcast) {
      for (const cid of clientIds) reserveAttempt(cid, hash);
      if (inFlight.has(hash)) continue; // a broadcast for these bytes is already flying
      inFlight.add(hash);
      void sendOne(hash);
    }
  };

  const sendOne = async (hash: string): Promise<void> => {
    try {
      const bytes = await deps.store.get(hash);
      if (bytes === undefined) return; // bytes vanished (e.g. GC) — attempt already spent
      // MIME is intentionally NEUTRAL: the holder has no snapshot/pointer input, and a
      // peer-writable pointer must never source the served MIME. The requester already
      // holds the authoritative pointer (that is why it wants the bytes); the bytes are
      // sha256-verified on receipt regardless of this label.
      await deps.channel.send(bytes, hash, "application/octet-stream").done;
    } catch {
      /* transient failure — the bounded retry (cap 2) covers one more attempt */
    } finally {
      inFlight.delete(hash);
    }
  };

  // Coalesce triggers into a single microtask-scheduled pass; the re-entrancy guard runs
  // one pass per burst (plus one more if a trigger arrived mid-run).
  let scheduled = false;
  let running = false;
  let rerun = false;
  const runPlan = (): void => {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    void doPlan()
      .catch(() => undefined)
      .finally(() => {
        running = false;
        if (rerun && !disposed) {
          rerun = false;
          runPlan();
        }
      });
  };
  const schedule = (): void => {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      runPlan();
    });
  };

  // A doc update matters only when the BINARY pointer set changed — skip every keystroke.
  // A real change bumps the demand generation (invalidating any in-flight stale plan).
  const onDoc = (): void => {
    const sig = binarySig(deps.snapshot());
    if (sig === lastBinarySig) return;
    lastBinarySig = sig;
    demandGen += 1;
    schedule();
  };
  const onSynced = (): void => {
    demandGen += 1;
    schedule();
  };
  const unsubs = [
    deps.subscribeDoc(onDoc),
    deps.subscribeAwareness(schedule),
    deps.subscribeSynced(onSynced),
  ];

  return {
    replan: doPlan,
    notifyInbound() {
      if (disposed) return;
      // Presence changed (a hash we may have been wanting is now stored) → invalidate any
      // in-flight plan and replan so the want-list + expectation drop it immediately.
      demandGen += 1;
      schedule();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      for (const off of unsubs) {
        try {
          off();
        } catch {
          /* unsubscribing a torn-down emitter is fine */
        }
      }
      // Teardown: withdraw the awareness want-list + release every live expectation, so a
      // gone peer neither keeps advertising nor leaves dangling transport expectations.
      try {
        deps.awareness.setLocalStateField(BLOB_WANTS_FIELD, null);
      } catch {
        /* awareness already torn down — nothing to withdraw */
      }
      for (const [hash, size] of activeExpects) {
        try {
          deps.channel.unexpect(hash, size);
        } catch {
          /* channel already closed — nothing to release */
        }
      }
      activeExpects.clear();
    },
  };
}

/** Signature of a snapshot's BINARY pointer set — the D1 demand trigger discriminator. */
function binarySig(snap: ProjectSnapshot): string {
  return (snap.binaryFiles ?? [])
    .map((f) => `${f.hash}:${f.size}`)
    .sort()
    .join(",");
}

/** Subscribe to PEER awareness changes (this peer's OWN updates are filtered out). */
function subscribePeerAwareness(awareness: Awareness, selfId: number, cb: () => void): () => void {
  const handler = (changes: { added: number[]; updated: number[]; removed: number[] }): void => {
    if ([...changes.added, ...changes.updated, ...changes.removed].some((id) => id !== selfId)) cb();
  };
  awareness.on("update", handler);
  return () => awareness.off("update", handler);
}

/**
 * Name (or rename) THIS peer after the session already exists — the host's
 * counterpart to the joiner's pre-session name prompt (#19.4). The session author
 * is minted once (write-once per clientID) from the local profile at creation, so
 * a host who never set a display name shares as the generic "Editor"; this lets
 * the Share UI fix that at the point of need.
 *
 * Three effects: (1) mutate the in-memory author so a LATER share builds its
 * presence with the name; (2) if already connected, re-push presence so the room
 * roster + remote cursor labels update live; and (3) rename this peer's HUMAN
 * author across the doc-global attribution map (`renameAuthor`) so the spans it
 * already wrote — and `distinctAuthors`, hence FUTURE version snapshots — show the
 * new name, not just live presence. Identity stays on `userId`; prior version
 * snapshots keep their already-recorded contributor labels (immutable history).
 * No-op for a blank name or a non-human author.
 */
export function setSessionDisplayName(session: ProjectSession, name: string): void {
  const trimmed = name.trim();
  if (trimmed.length === 0 || session.author.kind !== "human") return;
  session.author.name = trimmed;
  session.connection?.setLocalAuthorName(trimmed);
  renameAuthor(session.project, session.author.userId, trimmed);
}

/**
 * Stop sharing a live-upgraded project (B18) — the inverse of
 * {@link connectProjectSession}. Gracefully closes the sync connection (a real
 * awareness-removal departure, so peers drop us at once) and DETACHES it from the
 * session, reverting to local-only editing. The local project doc + its IndexedDB
 * persistence stay intact: only the shared connection goes away.
 *
 * Idempotent and safe: a session with no connection (already local, or a joiner
 * that never owned the room) is left untouched and returns `false`. Returns
 * `true` when a connection was actually closed, so the caller can branch its UI
 * reset. We call `disconnect()` (not `destroy()`): the connection's `Awareness`
 * is created internally and is not the session's local `awareness`, so the caller
 * restores the editor to the session's local awareness rather than reusing this
 * one. (A later Share mints a brand-new connection + awareness anyway.)
 */
export function disconnectProjectSession(session: ProjectSession): boolean {
  const connection = session.connection;
  if (!connection) return false;
  connection.disconnect();
  session.connection = undefined;
  // B19: the connection (the role's source of truth) is gone, so drop the recorded
  // role; the now-local session reverts to the owner-editor default via
  // `resolveSessionRole(connected=false, …)`. Defensive — that helper already
  // short-circuits to editor when no connection exists.
  delete session.role;
  // §F: tear down the live-upgrade blob channel too, so stop-sharing closes both
  // the sync and the byte channel (reverting to fully local editing).
  session.blobChannel?.destroy();
  delete session.blobChannel;
  return true;
}

/**
 * Apply an accepted source to a project FILE as the AGENT acting as a DISTINCT
 * peer, so the new spans attribute to the agent (ADR-0012) — the project sibling
 * of `applyAcceptedSourceAsAgent`. Cross-peer attribution keys off each item's
 * originating Yjs `clientID`, and a `Y.Doc` has exactly one, so we spin up a
 * transient agent `CollabProject` mirroring the main one, register it as the
 * agent, apply the minimal-diff to THAT file's `Y.Text` there (minting items
 * under the agent's clientID), then merge just that delta back. No clobber: it's
 * the same minimal prefix/suffix diff as the human path.
 */
export function applyAcceptedFileAsAgent(
  project: CollabProject,
  fileId: string,
  target: string,
  runId: string,
): void {
  const live = project.fileText(fileId);
  if (!live || live.toString() === target) return;
  const agent: Author = { kind: "agent", runId };
  const agentProject = new CollabProject(new Y.Doc());
  agentProject.applyUpdate(project.encodeState());
  registerAuthor(agentProject, agent);
  const ytext = agentProject.fileText(fileId);
  if (!ytext) {
    agentProject.destroy();
    return;
  }
  agentProject.transactFile(fileId, (t) => applyMinimalDiff(t, target), agent);
  project.applyUpdate(Y.encodeStateAsUpdate(agentProject.doc, Y.encodeStateVector(project.doc)));
  agentProject.destroy();
}

/**
 * Apply a whole accepted MULTI-FILE change set as the agent peer in ONE merged
 * update (the `propose_files` Accept). Every create + edit is staged on a
 * transient agent-cloned project, then the single resulting delta is merged back
 * into the live project — so the live doc's observers see ONE atomic update with
 * no partial landing and no empty-file intermediate, and a mid-apply failure
 * leaves the live project untouched (the throw is contained in the clone). The
 * caller MUST have validated every op against the live snapshot first
 * (`planFileProposalAccept`); this only stages the pre-resolved plan.
 */
export function applyAcceptedFileSetAsAgent(
  project: CollabProject,
  plan: {
    creates: { path: string; text: string }[];
    edits: { fileId: string; source: string }[];
    renames?: { fileId: string; newPath: string }[];
    deletes?: { fileId: string }[];
    /**
     * A2: new binary files — a path + a content-addressed pointer. The CALLER
     * (the accept orchestrator) MUST have verified every blob's bytes are present
     * in the store before calling this; here we only write the CRDT pointer.
     */
    binaryCreates?: { path: string; asset: BinaryAsset }[];
  },
  runId: string,
): void {
  const renames = plan.renames ?? [];
  const deletes = plan.deletes ?? [];
  const binaryCreates = plan.binaryCreates ?? [];
  if (
    plan.creates.length === 0 &&
    plan.edits.length === 0 &&
    renames.length === 0 &&
    deletes.length === 0 &&
    binaryCreates.length === 0
  )
    return;
  const agent: Author = { kind: "agent", runId };
  const agentProject = new CollabProject(new Y.Doc());
  agentProject.applyUpdate(project.encodeState());
  registerAuthor(agentProject, agent);
  try {
    for (const c of plan.creates) {
      // Create empty then diff in the body so the new spans attribute to the
      // agent's clientID (ADR-0012) — same shape as the single-file path.
      const id = agentProject.create(c.path, "", agent);
      if (c.text.length > 0) {
        agentProject.transactFile(id, (t) => applyMinimalDiff(t, c.text), agent);
      }
    }
    for (const e of plan.edits) {
      const live = agentProject.fileText(e.fileId);
      if (live && live.toString() !== e.source) {
        agentProject.transactFile(e.fileId, (t) => applyMinimalDiff(t, e.source), agent);
      }
    }
    // Rename is metadata-only (path is not the key) so the Y.Text + its
    // attribution history survive; delete sets the recoverable soft-delete flag.
    for (const r of renames) {
      agentProject.rename(r.fileId, r.newPath, agent);
    }
    for (const d of deletes) {
      agentProject.delete(d.fileId, agent);
    }
    // A2: write the binary file POINTER (path + {hash,size,mime}); the bytes are
    // already in the project blob store (the orchestrator verified them before
    // calling us). createBinary never sets main (the compile entry is text).
    for (const b of binaryCreates) {
      agentProject.createBinary(b.path, b.asset, agent);
    }
    project.applyUpdate(Y.encodeStateAsUpdate(agentProject.doc, Y.encodeStateVector(project.doc)));
  } finally {
    agentProject.destroy();
  }
}

/** Where the materialized manifest lives in a version tree (mirrors collab's PROJECT_MANIFEST_PATH). */
const VERSION_MANIFEST_PATH = ".galley/project.json";

/** Canonicalize a materialized (relative) tree path back to the project's leading-slash form. */
function canonicalProjectPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * Restore a project to a saved version tree (#12.6) as EXPLICIT CRDT operations —
 * never a destructive wipe (ADR-0018): minimal-diff each existing file's text to
 * the version's, create any file the version has that the project lacks, soft-
 * delete (a recoverable flag, never a CRDT destroy) the live files the version
 * omits, and re-point `main` by path (fileIds don't survive a version boundary).
 * All operations are tagged `author` (the local human peer). The manifest entry
 * is consumed for `main` and excluded from the restored files.
 *
 * Reserved `.galley/*` entries (14-D): the WHOLE namespace is fenced out of the
 * regular create/diff loop (a tree from an untrusted remote must never raw-create
 * reserved config into the CRDT). The ONE recognized config file —
 * `.galley/instructions`, carried by the export surfaces — is applied through the
 * coalescing {@link writeProjectInstructions} seam instead, completing the
 * export → import round-trip. A tree WITHOUT instructions (every version
 * snapshot, by design) leaves the project's existing instructions untouched.
 */
export function restoreProjectFromTree(
  project: CollabProject,
  tree: VersionedFile[],
  author: Author,
): void {
  // Fence the reserved namespace (manifest, instructions, anything else) out of
  // the regular file loop — the manifest is consumed below; instructions go
  // through the dedicated write seam; unknown reserved entries are ignored. ALSO
  // gate every remaining entry through `isSafeProjectPath` (the same predicate
  // the projection and version stores enforce): a git-fetch candidate is REMOTE-
  // controlled, and a non-normalized path like `./.galley/evil`, `//.galley/x`,
  // or `../escape.typ` would slip past the first-segment reserved check and be
  // raw-created into the CRDT as an unexportable, materialize-breaking file.
  // Unsafe entries are dropped (never mutated into the project), mirroring the
  // zip import's `toSafeProjectFiles` gate; legitimate trees (every Galley
  // projection) never contain them.
  const fileEntries = tree.filter((f) => {
    const canonical = canonicalProjectPath(f.path);
    return !isReservedProjectPath(canonical) && isSafeProjectPath(canonical);
  });
  const manifest = tree.find((f) => f.path === VERSION_MANIFEST_PATH);
  const instructionsText = projectInstructionsFromTree(tree);
  let mainPath: string | null = null;
  if (manifest) {
    try {
      mainPath = (JSON.parse(manifest.text) as { main?: string | null }).main ?? null;
    } catch {
      /* a malformed manifest leaves main untouched */
    }
  }

  const live = project.snapshot().files.filter((f) => !f.deleted);
  const idByPath = new Map<string, string>();
  for (const f of live) if (!idByPath.has(f.path)) idByPath.set(f.path, f.fileId);

  const wanted = new Set<string>();
  for (const file of fileEntries) {
    const path = canonicalProjectPath(file.path);
    wanted.add(path);
    const existingId = idByPath.get(path);
    if (existingId) {
      project.transactFile(existingId, (t) => applyMinimalDiff(t, file.text), author);
    } else {
      project.create(path, file.text, author);
    }
  }

  // Soft-delete files absent from the version (recoverable; preserves history).
  // EXCEPT the reserved `.galley/*` namespace (14-D): version snapshots never
  // list `/.galley/instructions` (materializeProject excludes it by default), so
  // tombstoning it here would silently wipe the project's agent-steering config
  // on every restore/compare round-trip. Restore only touches it via the explicit
  // instructions write below, when the tree actually carries one.
  for (const f of live) {
    if (!wanted.has(f.path) && !isReservedProjectPath(f.path)) project.delete(f.fileId, author);
  }

  // 14-D round-trip: a tree that CARRIES `.galley/instructions` (the export
  // surfaces opt in; e.g. a git-remote fetch of a repo Galley pushed) restores it
  // through the coalescing write seam — never a raw create, so duplicates can't
  // form and a re-import of identical text is a no-op.
  if (instructionsText !== undefined) {
    writeProjectInstructions(project, instructionsText, author);
  }

  // Re-point main by PATH (manifest.main is already canonical, leading-slash).
  if (mainPath) {
    const target = canonicalProjectPath(mainPath);
    const id = project
      .snapshot()
      .files.find((f) => !f.deleted && f.path === target)?.fileId;
    if (id) project.setMain(id, author);
  }
}
