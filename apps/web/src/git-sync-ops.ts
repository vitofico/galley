/**
 * Lane S / ADR-0019 — the host-side git-sync ORCHESTRATION, factored out of
 * `ProjectApp` so it is pure and Node-testable (the apps/web vitest env has no
 * DOM). These functions are what the panel's injected `onPush`/`onFetch` call.
 *
 * Both go through the persistence core's redacted public wrappers (`pushTree` /
 * `fetchTree`), so a token can never ride out in a surfaced error. `fetchGitRemote`
 * returns the remote tree as a CANDIDATE only (ADR-0018) — the caller routes it
 * through the existing Accept-gated compare/restore path; nothing is auto-applied
 * here.
 */
import {
  pushTree,
  fetchTree,
  encodeMessage,
  sanitizeTrailer,
  type RemoteConfig,
  type RemoteSync,
} from "@galley/persistence/browser";
import { CollabProject, materializeProject } from "@galley/collab";
import type { VersionedFile } from "@galley/shared";
import * as Y from "yjs";
import type { GitSyncPushOutcome, GitSyncFetchOutcome } from "./git-sync-types.js";
import { loadGithubConnection, type GithubConnection } from "./github-connect.js";
import type { GithubRepoSelection } from "./github-repo-target.js";
import { GithubApiError, fetchSnapshot, pushSnapshot, type GithubFetch } from "./github-api.js";

/** A materialize step that yields the project's current git-shaped tree, or an error. */
export type Materialize = () =>
  | { ok: true; files: VersionedFile[] }
  | { ok: false; reason: string };

/**
 * Push the materialized project tree to `config`'s remote via the browser
 * `RemoteSync`. Returns a redacted outcome (never throws a raw token): a
 * materialize failure or a transport failure both surface as `{ ok:false, error }`.
 */
export async function pushGitRemote(
  sync: RemoteSync,
  config: RemoteConfig,
  materialize: Materialize,
): Promise<GitSyncPushOutcome> {
  const tree = materialize();
  if (!tree.ok) return { ok: false, error: `Cannot push: ${tree.reason}.` };
  try {
    const res = await pushTree(sync, config, tree.files);
    return { ok: true, oid: res.oid };
  } catch (err) {
    // The persistence wrapper already redacted the token from this message.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A fetch outcome that also carries the candidate tree for the Accept gate. */
export interface FetchGitResult extends GitSyncFetchOutcome {
  /** The remote tree, when the ref existed — handed to the Accept-gated review. */
  candidate?: VersionedFile[];
}

/**
 * Fetch `config`'s remote ref as an import CANDIDATE. Returns the tree (for the
 * caller's Accept-gated compare/restore flow) or, when the ref is absent,
 * `{ ok:true, hasCandidate:false }`. NEVER applies anything. Errors are redacted.
 */
export async function fetchGitRemote(
  sync: RemoteSync,
  config: RemoteConfig,
): Promise<FetchGitResult> {
  try {
    const tree = await fetchTree(sync, config);
    if (tree === null) return { ok: true, hasCandidate: false };
    return { ok: true, hasCandidate: true, candidate: tree };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// --- Connect GitHub v0 — "Push snapshot to GitHub" ----------------------------
//
// The GitHub path CANNOT reuse the smart-HTTP transport above: browsers get no
// CORS from github.com's git endpoints. `api.github.com` does serve CORS, so
// the snapshot goes through the REST Git Data API instead (`github-api.ts`).
// One-way only in v0: the CRDT stays the source of truth; there is no fetch.

/** An async materialize step (the IndexedDB projection below is async). */
export type MaterializeAsync = () => Promise<
  { ok: true; files: VersionedFile[] } | { ok: false; reason: string }
>;

/** Injectable seams for {@link pushGithubSnapshot} — tests pass fakes. */
export interface GithubPushOptions {
  /**
   * The DEVICE connection to push with (token + login). `undefined` (absent) →
   * load the stored one; an explicit `null` means "no connection" (tests
   * exercise the gate).
   */
  connection?: GithubConnection | null;
  /**
   * The PER-PROJECT push target (owner/name/branch). The caller loads it from
   * `github-repo-target` for the active project and passes it explicitly —
   * `undefined`/`null` both mean "no target chosen" and gate honestly. Kept
   * explicit (no storage default) so this stays pure and Node-testable: the
   * function never needs to know the project id.
   */
  repo?: GithubRepoSelection | null;
  /** Fetch seam handed through to the REST client. Default: global fetch. */
  fetchImpl?: GithubFetch;
  /** Commit-message clock, injectable for determinism. Default: `Date`. */
  now?: () => Date;
  /**
   * The pusher's LOCAL identity (roadmap #12). Used for exactly one thing: to
   * suppress a redundant `Co-authored-by:` line naming the pusher on a commit
   * they already author. It is NEVER sent to GitHub — the remote author is
   * deliberately GitHub's authenticated default (the PAT owner), which under the
   * personal-PAT model is this same person but as a VERIFIED, LINKED identity.
   * INJECTED by the caller, matching the connection/repo convention that keeps
   * this module pure and Node-testable.
   */
  author?: { name: string; email: string };
  /**
   * The project's contributor display labels (roadmap #11) — trailered onto the
   * commit so the remote carries the same attribution the local git path writes.
   * Absent/empty → no trailer block is appended at all.
   */
  contributors?: string[];
}

/**
 * Longest identity value (contributor label, and the author name it is compared
 * against) that may ride out to the remote. Display labels are CRDT data any
 * collaborator can set, so they are untrusted AND unbounded; the commit message
 * must not be a place a peer can dump megabytes. Generous enough that no real
 * name is ever touched. Applied to BOTH sides of the self-co-author comparison —
 * bounding only the contributor would make a long name stop matching its author
 * and re-introduce the redundant self-co-author line.
 */
export const MAX_IDENTITY_CHARS = 200;

/**
 * CR/LF-strip + length-bound one untrusted display value. Bounds by CODE POINT
 * (not code unit): a plain `slice` can cut a surrogate pair in half and put a
 * lone surrogate on the wire.
 */
function boundIdentity(value: string): string {
  return [...sanitizeTrailer(value)].slice(0, MAX_IDENTITY_CHARS).join("");
}

/**
 * Push the materialized project tree to the connected GitHub account's chosen
 * repository via the REST snapshot path. The credential is device-scoped
 * (`connection`); the TARGET is per-project (`repo`). Gates honestly (no
 * connection / no repo target), and returns a redacted outcome — the typed REST
 * client never puts the token in a message, and this wrapper scrubs the literal
 * once more, defense in depth.
 */
export async function pushGithubSnapshot(
  materialize: MaterializeAsync,
  options: GithubPushOptions = {},
): Promise<GitSyncPushOutcome> {
  const conn =
    options.connection !== undefined ? options.connection : loadGithubConnection();
  if (!conn) {
    return { ok: false, error: "Connect GitHub in Settings first." };
  }
  const repo = options.repo ?? null;
  if (!repo) {
    return { ok: false, error: "Choose a repository in this project’s Git panel first." };
  }
  const tree = await materialize();
  if (!tree.ok) return { ok: false, error: `Cannot push: ${tree.reason}.` };
  try {
    const when = (options.now?.() ?? new Date()).toISOString();
    // Attribution (#11/#12) rides the MESSAGE only. Reuse the persistence encoder
    // the LOCAL git path uses, so the remote carries the identical trailer format
    // — never a second one. The subject is unchanged, so with no contributors the
    // encoder appends nothing and the commit is byte-for-byte the pre-#12 push.
    // Every untrusted display value is CR/LF-stripped and length-bounded first.
    //
    // `author` is fed to the encoder but NOT to `pushSnapshot`: the encoder reads
    // it solely to skip co-authoring the pusher to their own commit (it is never
    // emitted into the message). The REMOTE author stays GitHub's authenticated
    // default, so the commit keeps a real, linked identity.
    const author = options.author
      ? { name: boundIdentity(options.author.name), email: boundIdentity(options.author.email) }
      : undefined;
    const contributors = (options.contributors ?? []).map(boundIdentity).filter((c) => c.length > 0);
    const message = encodeMessage({
      name: `Galley snapshot — ${when}`,
      ...(contributors.length > 0 ? { contributors } : {}),
      ...(author ? { author } : {}),
    });
    const res = await pushSnapshot(
      conn.token,
      {
        owner: repo.owner,
        repo: repo.name,
        branch: repo.branch,
        message,
        files: tree.files.map((f) => ({ path: f.path, text: f.text })),
      },
      { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) },
    );
    return { ok: true, oid: res.commitSha };
  } catch (err) {
    // The REST client already scrubbed its messages; strip the literal token
    // once more in case a non-GithubApiError bubbled out of a seam.
    const raw =
      err instanceof GithubApiError || err instanceof Error ? err.message : String(err);
    return { ok: false, error: raw.split(conn.token).join("[redacted]") };
  }
}

/** Injectable seams for {@link fetchGithubSnapshot} — tests pass fakes. */
export interface GithubFetchOptions {
  /**
   * The DEVICE connection to read with (token + login). `undefined` (absent) →
   * load the stored one; an explicit `null` means "no connection" (tests
   * exercise the gate). Mirrors {@link GithubPushOptions.connection}.
   */
  connection?: GithubConnection | null;
  /**
   * The PER-PROJECT repo to read (owner/name/branch). Passed explicitly so this
   * stays pure and Node-testable; `undefined`/`null` both gate honestly. Mirrors
   * {@link GithubPushOptions.repo}.
   */
  repo?: GithubRepoSelection | null;
  /** Fetch seam handed through to the REST client. Default: global fetch. */
  fetchImpl?: GithubFetch;
}

/**
 * Fetch the connected GitHub account's chosen repository as an import CANDIDATE
 * via the REST tree read ({@link fetchSnapshot}) — the GitHub mirror of
 * {@link fetchGitRemote}. The credential is device-scoped (`connection`); the
 * SOURCE is per-project (`repo`). Gates honestly (no connection / no repo
 * target), returns the remote tree as a {@link FetchGitResult} candidate for the
 * caller's Accept-gated compare/restore flow, and NEVER applies anything. When
 * the ref is empty/absent → `{ ok:true, hasCandidate:false }`. Errors are
 * redacted: the typed REST client never puts the token in a message, and this
 * wrapper scrubs the literal once more, defense in depth (matching
 * {@link pushGithubSnapshot}).
 */
export async function fetchGithubSnapshot(
  options: GithubFetchOptions = {},
): Promise<FetchGitResult> {
  const conn =
    options.connection !== undefined ? options.connection : loadGithubConnection();
  if (!conn) {
    return { ok: false, error: "Connect GitHub in Settings first." };
  }
  const repo = options.repo ?? null;
  if (!repo) {
    return { ok: false, error: "Choose a repository in this project’s Git panel first." };
  }
  try {
    const files = await fetchSnapshot(
      conn.token,
      { owner: repo.owner, repo: repo.name, branch: repo.branch },
      { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) },
    );
    if (files === null) return { ok: true, hasCandidate: false };
    const candidate: VersionedFile[] = files.map((f) => ({ path: f.path, text: f.text }));
    return { ok: true, hasCandidate: true, candidate };
  } catch (err) {
    // The REST client already scrubbed its messages; strip the literal token
    // once more in case a non-GithubApiError bubbled out of a seam.
    const raw =
      err instanceof GithubApiError || err instanceof Error ? err.message : String(err);
    return { ok: false, error: raw.split(conn.token).join("[redacted]") };
  }
}

/** The per-project y-indexeddb database name (`createProjectSession`'s scheme). */
export function projectIdbName(projectId: string): string {
  return `galley-local-project-v1-${projectId}`;
}

/** Promise wrapper over an IDB request. */
function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

/**
 * Materialize the SAME git-shaped tree the existing git projection pushes —
 * read directly from the project's persisted y-indexeddb CRDT updates.
 *
 * Why from storage and not the live doc: the live `ProjectSession` is private
 * to the shell (`ProjectApp`), while this panel only knows the `projectId`.
 * y-indexeddb commits every doc update durably as it happens, so replaying the
 * stored updates into a fresh read-only `Y.Doc` reconstructs the same state
 * (CRDT updates are order-insensitive). STRICTLY read-only: we never attach a
 * persistence provider (which could compact/write), we only `getAll` the
 * `updates` store — so the live session's provider is undisturbed.
 */
export async function materializeProjectTreeFromIdb(
  projectId: string,
): Promise<{ ok: true; files: VersionedFile[] } | { ok: false; reason: string }> {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb || typeof idb.databases !== "function") {
    return { ok: false, reason: "local project storage is unavailable in this browser" };
  }
  const dbName = projectIdbName(projectId);
  try {
    // Only open a db that already exists — a bare `open()` would CREATE an
    // empty one and shadow y-indexeddb's own store-creating upgrade.
    const names = (await idb.databases()).map((d) => d.name);
    if (!names.includes(dbName)) {
      return { ok: false, reason: "this project has no locally saved copy yet" };
    }
    const db = await idbRequest<IDBDatabase>(idb.open(dbName));
    let updates: unknown[];
    try {
      if (!db.objectStoreNames.contains("updates")) {
        return { ok: false, reason: "this project has no locally saved copy yet" };
      }
      updates = await idbRequest(
        db.transaction("updates", "readonly").objectStore("updates").getAll(),
      );
    } finally {
      db.close();
    }
    const doc = new Y.Doc();
    try {
      for (const u of updates) {
        if (u instanceof Uint8Array) Y.applyUpdate(doc, u);
        else if (u instanceof ArrayBuffer) Y.applyUpdate(doc, new Uint8Array(u));
      }
      const outcome = materializeProject(new CollabProject(doc).snapshot(), {
        includeInstructions: true,
      });
      return outcome.ok
        ? { ok: true, files: outcome.result.files }
        : { ok: false, reason: `${outcome.reason} (${outcome.detail})` };
    } finally {
      doc.destroy();
    }
  } catch (err) {
    return {
      ok: false,
      reason: `could not read the saved project (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}
