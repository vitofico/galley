/**
 * Collaboration session wiring for the web app (Phase 2c, ADR-0009/0010).
 * FLAG-GATED: off unless `?collab=1` is present, so the default single-user path
 * is untouched.
 *
 * - LOCAL (no `?sync=`): a `CollabDocument` + a bare `Awareness`, bound to
 *   CodeMirror via y-codemirror.next; the agent applies into the live doc.
 * - CONNECTED (`?sync=ws://…&room=…`): the doc joins a real `apps/sync` room via
 *   a `WebSocketTransport`, with author presence + remote cursors (Phase 2c-2).
 */
import {
  CollabDocument,
  CollabConnection,
  WebSocketTransport,
  seedIfPristine,
  registerAuthor,
  type WebSocketLike,
} from "@galley/collab";
import type { Author } from "@galley/shared";
import type * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { authorColor, authorLabel } from "./attribution-style.js";
import { parseShareRole, type ShareRole } from "./share.js";

export interface CollabConfig {
  enabled: boolean;
  /**
   * Multi-file project mode (`?project=1`, roadmap #2). Default OFF — optional so
   * existing single-file/`?collab=1` config literals are unaffected.
   */
  project?: boolean;
  /** ws URL of the sync server, e.g. `ws://localhost:1234`. */
  syncUrl: string | undefined;
  /** room / document id. */
  room: string | undefined;
  /**
   * The access level this boot joins at (B19-sharing-roles). Decoded from the
   * join link's untrusted `?role=` and FAILS CLOSED: only an explicit
   * `role=editor` grants write; `viewer`, an absent role, or a forged value all
   * resolve to read-only `viewer` (see {@link parseShareRole}). OPTIONAL +
   * additive: a config literal that omits it is treated as no decoded role.
   */
  role?: ShareRole;
}

export function readCollabConfig(search: string = window.location.search): CollabConfig {
  const params = new URLSearchParams(search);
  return {
    enabled: params.get("collab") === "1",
    project: params.get("project") === "1",
    syncUrl: params.get("sync") ?? undefined,
    room: params.get("room") ?? undefined,
    // Narrowed through `parseShareRole`, which FAILS CLOSED: a malformed/forged/
    // absent `?role=` resolves to the least-privilege `viewer`, and only an
    // explicit `role=editor` grants write (the local owner's editor session is
    // sourced separately, never from this untrusted URL parse).
    role: parseShareRole(params.get("role")),
  };
}

export interface CollabSession {
  doc: CollabDocument;
  awareness: Awareness;
  /** Present only in CONNECTED mode. */
  connection: CollabConnection | undefined;
  /**
   * Resolves once the session is ready to edit: in LOCAL mode, after the draft
   * store has loaded any persisted content and the seed-if-empty has run. Tests
   * await this; the app does not need to (the editor mirrors the live Y.Text).
   */
  whenReady: Promise<void>;
  /**
   * The raw local-persistence load — REJECTS if the draft store failed to
   * initialize (vs `whenReady`, which catches it so seeding proceeds). Present
   * only when this session owns a local draft store (LOCAL mode); undefined in
   * CONNECTED mode (the relay is authoritative). Drives the save badge's C1
   * `at-risk` state.
   */
  whenPersisted?: Promise<void>;
  destroy(): void;
}

/**
 * A persistence backend for a local draft — the seam over `y-indexeddb`. Kept
 * injectable so the Node unit gate (no `indexedDB`) can pass a fake; the real
 * factory dynamic-imports `y-indexeddb` so it is never loaded outside a browser.
 */
export interface DraftStore {
  /** Resolves once persisted content (if any) has been loaded into the doc. */
  whenSynced: Promise<void>;
  /** Detach the persistence provider. Does NOT wipe stored data. */
  destroy(): void;
}

export type DraftStoreFactory = (dbName: string, doc: Y.Doc) => DraftStore;

export interface CollabDeps {
  /** Override the local-draft persistence backend (tests inject a fake). */
  draftStore?: DraftStoreFactory;
  /** Override the WebSocket factory (tests inject a fake; default uses the global). */
  socketFactory?: (url: string) => WebSocketLike;
}

/**
 * The default draft store: `y-indexeddb`, loaded via a dynamic import so the
 * static module graph (and the Node unit gate) never pulls in a browser-only
 * dependency. Resolves `whenSynced` on the provider's `synced` event — which
 * fires after the persisted content is loaded, including the no-content case.
 */
export function createIndexeddbDraftStore(dbName: string, doc: Y.Doc): DraftStore {
  let provider: { destroy(): Promise<void> } | undefined;
  let destroyed = false;
  const whenSynced = import("y-indexeddb").then(({ IndexeddbPersistence }) => {
    // The session may have been torn down before this async import resolved;
    // don't attach a provider that would then leak (and seed late).
    if (destroyed) return;
    return new Promise<void>((resolve) => {
      const p = new IndexeddbPersistence(dbName, doc);
      provider = p;
      p.once("synced", () => resolve());
    });
  });
  return {
    whenSynced,
    destroy() {
      // destroy() detaches the provider but PRESERVES stored data (only
      // clearData() would wipe it) — exactly what a draft should do.
      destroyed = true;
      void provider?.destroy();
    },
  };
}

/** A short, stable-ish random id for this browser tab's human identity. */
function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** A y-codemirror.next `user` field (name + cursor color) derived from an author. */
function userField(author: Author): { name: string; color: string } {
  return { name: authorLabel(author), color: authorColor(author) };
}

/**
 * Replace a `Y.Text`'s content with `target` using the MINIMAL differing edit
 * (shared prefix + shared suffix preserved), inside the given `Y.Text` directly.
 * Must be called inside a transaction. Replacing only the middle span (rather
 * than clobbering the whole text) lets a disjoint concurrent edit merge.
 */
export function applyMinimalDiff(text: import("yjs").Text, target: string): void {
  const current = text.toString();
  if (current === target) return;
  let prefix = 0;
  while (prefix < current.length && prefix < target.length && current[prefix] === target[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < current.length - prefix &&
    suffix < target.length - prefix &&
    current[current.length - 1 - suffix] === target[target.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const deleteLen = current.length - prefix - suffix;
  const insert = target.slice(prefix, target.length - suffix);
  if (deleteLen > 0) text.delete(prefix, deleteLen);
  if (insert.length > 0) text.insert(prefix, insert);
}

/**
 * Apply an accepted source string into the shared `Y.Text` as a single
 * author-tagged transaction — the agent-as-peer move. Rather than clobbering the
 * whole text (which would discard a concurrent peer's edit), it replaces only the
 * minimal differing middle span (shared prefix + shared suffix), so disjoint
 * concurrent edits merge. The accepted `target` already comes from the
 * conflict-aware `resolveAccept`, so this only commits a change known to apply.
 */
export function applyAcceptedSource(doc: CollabDocument, target: string, author: Author): void {
  if (doc.getSource() === target) return;
  doc.transact((text) => applyMinimalDiff(text, target), author);
}

/**
 * Apply an accepted source as the AGENT acting as a DISTINCT peer, so the change
 * attributes to the agent (not the human's clientID). Cross-peer attribution keys
 * off each item's originating Yjs `clientID`, and a `Y.Doc` has exactly one — so
 * an agent-tagged transaction on the human's own doc would still carry the human's
 * id (ADR-0012). Instead we spin up a transient agent `Y.Doc` mirroring the main
 * doc, register it as the agent, apply the (conflict-aware, minimal-diff) edit
 * there — minting items under the agent's clientID — then merge just that delta
 * back into the main doc. The merge also carries the agent's author-map entry, so
 * the new spans resolve to the agent on every peer. No clobber: it reuses the same
 * minimal prefix/suffix diff as `applyAcceptedSource`.
 */
export function applyAcceptedSourceAsAgent(
  mainDoc: CollabDocument,
  target: string,
  runId: string,
): void {
  if (mainDoc.getSource() === target) return;
  const agent: Author = { kind: "agent", runId };
  const agentDoc = new CollabDocument();
  agentDoc.applyUpdate(mainDoc.encodeState());
  registerAuthor(agentDoc, agent);
  applyAcceptedSource(agentDoc, target, agent);
  mainDoc.applyUpdate(agentDoc.encodeStateSince(mainDoc.stateVector()));
  agentDoc.destroy();
}

/**
 * Create a collaboration session. Seed-once invariant: seed with `initial` ONLY
 * when there is no sync server (pure local) — when a server is the authority the
 * client joins empty, or two independent seeds would duplicate the text.
 *
 * In connected mode the session sets its `{ author, user }` presence ONCE (before
 * the editor binds), so y-codemirror.next can later merge its `cursor` field in
 * without `setLocalState` clobbering it.
 */
export function createCollabSession(
  initial: string,
  config: CollabConfig,
  deps: CollabDeps = {},
): CollabSession {
  const connected = config.syncUrl !== undefined;

  if (!connected) {
    // LOCAL mode: persist the draft to IndexedDB so it survives a refresh.
    // The doc starts EMPTY and is seeded ONLY after the store has loaded, so a
    // restored draft is never duplicated by a second seed (the seed-once footgun).
    const doc = new CollabDocument("");
    const awareness = new Awareness(doc.doc);
    const author: Author = { kind: "human", userId: randomId() };
    const dbName = `galley-local-draft-v1-${config.room ?? "default"}`;
    const store = (deps.draftStore ?? createIndexeddbDraftStore)(dbName, doc.doc);
    // Always settle, then seed: if persistence fails to load, degrade to an
    // in-memory doc rather than leaving the editor blank. Seeding is gated on the
    // doc being pristine, so a *late* load can never duplicate the seed.
    const whenReady = store.whenSynced
      .catch(() => undefined)
      .then(() => {
        // Order matters: seed FIRST (registering an author writes the authors map,
        // which would make a pristine doc look used and suppress the seed), then
        // record this peer's clientID -> author for cross-peer attribution.
        seedIfPristine(doc, initial, author);
        registerAuthor(doc, author);
      });
    return {
      doc,
      awareness,
      connection: undefined,
      whenReady,
      // C1: surface the RAW load (rejects on failure) so the save badge can read
      // at-risk. `whenReady` already attached a `.catch` above, so this shared
      // promise's rejection is handled — no unhandled-rejection warning.
      whenPersisted: store.whenSynced,
      destroy() {
        store.destroy();
        awareness.destroy();
        doc.destroy();
      },
    };
  }

  // CONNECTED mode: the sync server is the authority; join empty, no local
  // persistence (offline caching here tangles with server-authority + auth — a
  // later slice). See ADR-0011.
  const doc = new CollabDocument("");
  const author: Author = { kind: "human", userId: randomId() };
  const url = `${config.syncUrl!.replace(/\/+$/, "")}/${encodeURIComponent(config.room ?? "default")}`;
  const makeSocket = deps.socketFactory ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike);
  const connection = new CollabConnection(
    doc,
    new WebSocketTransport(() => makeSocket(url)),
    { author, user: userField(author) },
  );
  connection.connect();
  // Record this peer's clientID -> author in the shared (replicated) authors map
  // so remote peers can attribute our spans. CRDT-merges with other peers' entries.
  registerAuthor(doc, author);
  return {
    doc,
    awareness: connection.awareness,
    connection,
    whenReady: Promise.resolve(),
    destroy() {
      connection.destroy();
      doc.destroy();
    },
  };
}
