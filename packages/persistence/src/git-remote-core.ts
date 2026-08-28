/**
 * Lane C — E6 git-remote **projection** core (roadmap #4 / ADR-0018, ADR-0019):
 * push the latest materialized version tree to a git remote, and fetch a remote
 * tree back as an *import candidate*. The CRDT (Yjs) stays the single source of
 * truth — git is a one-way projection. `fetchTree` is **pure**: it returns the
 * remote's files and mutates NOTHING (no CRDT, no local store, only a private
 * scratch area). The caller later turns a candidate into an explicit CRDT
 * transaction (out of scope here).
 *
 * ## Browser-safe by construction (ADR-0019)
 * This module is the **runtime-neutral** half of the old `git-remote.ts`: it
 * MUST NOT statically import `node:fs`/`node:os`/`node:path` and uses no
 * `Buffer`. isomorphic-git's plumbing speaks to an injected `fs` (the
 * `PromiseFsClient` subset), so the SAME object-plumbing runs against `node:fs`
 * (the Node default, see `git-remote-node.ts`) or a hand-rolled in-memory fs (the
 * browser, see `browser-git-fs.ts`). The Node-only `LocalBareRemoteSync` and the
 * `node:fs`-backed scratch default live in `git-remote-node.ts`.
 *
 * ## The transport seam (why it looks like this)
 * isomorphic-git's `push`/`fetch` speak smart-HTTP and require an injected
 * `HttpClient`; they have no native local/`file://` remote transport. So the seam
 * is the *semantic* operation — {@link RemoteSync} (`pushTree`/`fetchTree`) — not
 * the HTTP client. {@link HttpRemoteSync} is the real network edge over
 * `isomorphic-git/http`; it is wired but **not exercised in the CI gate** (no
 * network), exactly like other injected-IO seams in this repo.
 *
 * ## Security: tokens are write-only
 * A {@link RemoteConfig}'s `auth.token` is an input only. It is NEVER placed in a
 * return value, NEVER embedded in a URL we expose (auth goes via `onAuth`), and
 * every error — at BOTH the public-wrapper and the adapter layers (defense in
 * depth) — passes through {@link redactRemoteError}, which scrubs the literal
 * token, its URL-encoded form, and the HTTP-Basic base64 wire form, so no
 * encoding of the secret can ride out in a message.
 *
 * Other hardening: {@link HttpRemoteSync} runs each op in a fresh, isolated
 * scratch gitdir deleted in a `finally` (no stale/ambient state across remotes;
 * never parents a projection onto an unrelated history). A fetch candidate is
 * bounded by {@link FetchLimits} (file-count / per-file / total bytes) so a
 * hostile remote can't OOM the importer.
 */
import git from "isomorphic-git";
import type { VersionedFile } from "@galley/shared";

const REDACTED = "[REDACTED]";
const DEFAULT_BRANCH = "main";
const AUTHOR = { name: "galley", email: "galley@localhost" } as const;

/**
 * The isomorphic-git `PromiseFsClient` subset the plumbing here actually
 * exercises. We type the seam structurally (not as `node:fs`) so a browser
 * in-memory fs can be injected with no `node:*` import reaching the bundle.
 */
export interface GitFs {
  promises: {
    readFile(path: string, options?: unknown): Promise<unknown>;
    writeFile(path: string, data: unknown, options?: unknown): Promise<void>;
    mkdir(path: string, options?: unknown): Promise<unknown>;
    readdir(path: string, options?: unknown): Promise<string[]>;
    stat(path: string, options?: unknown): Promise<unknown>;
    lstat(path: string, options?: unknown): Promise<unknown>;
    unlink(path: string): Promise<void>;
    rmdir(path: string, options?: unknown): Promise<void>;
    rm?(path: string, options?: unknown): Promise<void>;
    symlink?(target: string, path: string): Promise<void>;
    readlink?(path: string, options?: unknown): Promise<unknown>;
  };
}

/**
 * A scratch-gitdir provider: make a fresh, isolated bare-repo path, and tear it
 * down. Injected so the Node path uses `mkdtemp(tmpdir())` while the browser
 * path uses a per-op in-memory root — without this core importing `node:*`.
 */
export interface ScratchProvider {
  /** Allocate a fresh empty directory path for a bare gitdir. */
  make(): Promise<string>;
  /** Remove a previously-made scratch path (recursive, best-effort). */
  cleanup(path: string): Promise<void>;
}

/**
 * Where/how to reach a git remote. `auth.token` is a **write-only** secret: it is
 * consumed to authenticate and is never echoed back out (see module docs).
 */
export interface RemoteConfig {
  /** Remote URL (HTTP for the live path) or, for `LocalBareRemoteSync`, a bare-repo path. */
  url: string;
  /** Short branch name to push/fetch. Defaults to `main`. */
  ref?: string;
  /** Write-only credentials. The token never appears in any output. */
  auth?: { token: string };
}

/** Result of a push: the new projection commit and the fully-qualified ref it moved. */
export interface PushResult {
  oid: string;
  /** Fully-qualified ref, e.g. `refs/heads/main`. */
  ref: string;
}

/**
 * The semantic remote-sync seam. Implementations differ only in *transport*; the
 * projection meaning is identical. Callers go through {@link pushTree} /
 * {@link fetchTree}, which add ref-defaulting and token redaction around these.
 */
export interface RemoteSync {
  /**
   * Project `tree` as a single commit onto `fullRef` of the remote and update the
   * ref (parented onto its current tip, or a root commit if the ref is new).
   */
  pushTree(config: RemoteConfig, fullRef: string, tree: VersionedFile[]): Promise<PushResult>;
  /**
   * Read the remote's tree at `fullRef`. Returns the files (sorted by path) or
   * `null` if the ref does not exist. MUST NOT mutate anything but a private
   * scratch area; in particular it never touches caller state.
   */
  fetchTree(config: RemoteConfig, fullRef: string): Promise<VersionedFile[] | null>;
}

/** Short branch name → fully-qualified ref. `main` → `refs/heads/main`. */
export function toFullRef(ref: string | undefined): string {
  const r = ref ?? DEFAULT_BRANCH;
  return r.startsWith("refs/") ? r : `refs/heads/${r}`;
}

// --- Public entry points (ref-defaulting + redaction wrappers) ---------------

/**
 * Push the materialized `tree` (e.g. from `materializeProject`) to the configured
 * remote ref. Any failure is rethrown with the token/credentials redacted.
 */
export async function pushTree(
  sync: RemoteSync,
  config: RemoteConfig,
  tree: VersionedFile[],
): Promise<PushResult> {
  const fullRef = toFullRef(config.ref);
  try {
    return await sync.pushTree(config, fullRef, tree);
  } catch (err) {
    throw redactRemoteError(err, config);
  }
}

/**
 * Fetch the configured remote ref and return its file tree as an **import
 * candidate** — or `null` if the ref is absent. This is pure: it does NOT mutate
 * any CRDT or local store. The caller decides whether/how to apply it.
 */
export async function fetchTree(
  sync: RemoteSync,
  config: RemoteConfig,
): Promise<VersionedFile[] | null> {
  const fullRef = toFullRef(config.ref);
  try {
    return await sync.fetchTree(config, fullRef);
  } catch (err) {
    throw redactRemoteError(err, config);
  }
}

// --- Token redaction ---------------------------------------------------------

/**
 * Runtime-neutral base64 of a UTF-8 string. Uses `btoa` over a Latin-1
 * re-encoding of the UTF-8 bytes when present (browser / web worker), else a
 * small pure fallback — so the redactor never depends on Node's `Buffer`.
 */
export function base64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const g = globalThis as unknown as { btoa?: (s: string) => string };
  if (typeof g.btoa === "function") return g.btoa(binary);
  return base64FromBinary(binary);
}

/** Pure base64 over a binary (Latin-1) string — fallback when `btoa` is absent. */
function base64FromBinary(binary: string): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < binary.length; i += 3) {
    const c0 = binary.charCodeAt(i);
    const c1 = i + 1 < binary.length ? binary.charCodeAt(i + 1) : 0;
    const c2 = i + 2 < binary.length ? binary.charCodeAt(i + 2) : 0;
    out += chars[c0 >> 2];
    out += chars[((c0 & 3) << 4) | (c1 >> 4)];
    out += i + 1 < binary.length ? chars[((c1 & 15) << 2) | (c2 >> 6)] : "=";
    out += i + 2 < binary.length ? chars[c2 & 63] : "=";
  }
  return out;
}

/**
 * Strip credentials embedded as `userinfo` in a URL (`https://user:tok@host/…` →
 * `https://host/…`). Non-URLs pass through unchanged. Used so a remote URL can be
 * shown in errors/logs without leaking a baked-in token.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
    }
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * True iff `url` carries `userinfo` (a `user` or `user:pass@` credential). Used to
 * fail closed BEFORE transport (ADR-0019 HIGH-1): credentials belong in the token
 * field (sent via HTTP Basic `onAuth`), never baked into the URL where they would
 * round-trip into a render path / get logged by a host. Non-URLs → `false`.
 */
export function urlHasUserinfo(url: string): boolean {
  try {
    const u = new URL(url);
    return u.username.length > 0 || u.password.length > 0;
  } catch {
    return false;
  }
}

/**
 * Decoded userinfo parts (username + password) embedded in a URL, or `[]`. The
 * `URL` API percent-DECODES `username`/`password`, so these are the cleartext
 * secrets — what we must scrub from any surfaced message (defense in depth for
 * HIGH-2, complementing the HIGH-1 fail-closed reject).
 */
function urlUserinfoSecrets(url: string): string[] {
  try {
    const u = new URL(url);
    const out: string[] = [];
    if (u.username) out.push(decodeURIComponent(u.username));
    if (u.password) out.push(decodeURIComponent(u.password));
    return out;
  } catch {
    return [];
  }
}

/**
 * Pass an error through a redactor: remove any literal `auth.token`, scrub
 * credentials embedded in the config URL, and collapse generic `user:pass@host`
 * userinfo — so a token can never ride out in a surfaced message. Returns a fresh
 * `Error` (the original may itself reference the token in nested fields).
 */
export function redactRemoteError(err: unknown, config: RemoteConfig): Error {
  let msg = err instanceof Error ? err.message : String(err);
  msg = scrubSecrets(msg, config);
  const out = new Error(msg);
  out.name = err instanceof Error ? err.name : "Error";
  return out;
}

/** The HTTP Basic credential we send for a token (see `HttpRemoteSync.onAuth`). */
const BASIC_PASSWORD = "x-oauth-basic";

/** base64 of `username:password`, the wire form of an HTTP Basic `Authorization` header. */
function basicBase64(username: string, password: string): string {
  return base64Utf8(`${username}:${password}`);
}

function scrubSecrets(text: string, config: RemoteConfig): string {
  let out = text;
  const token = config.auth?.token;
  if (token) {
    // 1) the literal token, 2) its URL-percent-encoded form (if it ever leaks via
    //    a URL we built), and 3) the HTTP Basic `Authorization: Basic <b64>` wire
    //    form we actually send (base64 of `token:x-oauth-basic`). All scrubbed so
    //    no on-the-wire encoding of the secret survives in a surfaced message.
    for (const form of [token, encodeURIComponent(token), basicBase64(token, BASIC_PASSWORD)]) {
      if (form) out = out.split(form).join(REDACTED);
    }
  }
  // Also scrub the token if it was embedded in the config URL's userinfo.
  out = out.split(config.url).join(redactUrl(config.url));
  // Defense in depth (HIGH-2): even though HIGH-1 fails closed on a userinfo URL,
  // scrub any DECODED url credential plus its percent-encoded and HTTP-Basic
  // base64 forms — so a cred derived from URL userinfo can never ride out, no
  // matter which encoding a transport/host echoed it as.
  const userinfo = urlUserinfoSecrets(config.url);
  for (const secret of userinfo) {
    if (!secret) continue;
    for (const form of [secret, encodeURIComponent(secret)]) {
      out = out.split(form).join(REDACTED);
    }
  }
  if (userinfo.length === 2) {
    // The Basic wire form built from `user:pass` URL creds.
    out = out.split(basicBase64(userinfo[0]!, userinfo[1]!)).join(REDACTED);
  }
  // Generic catch-all: any `scheme://user:secret@host` userinfo in the message.
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, `$1${REDACTED}@`);
  return out;
}

// --- Object plumbing (shared by both transports, fs-injected) ----------------

/**
 * A node in the tree we're about to write: either a blob (file) or a nested tree.
 * isomorphic-git's `writeTree` takes a flat list of entries per directory, so we
 * build the directory hierarchy ourselves from the flat `VersionedFile[]`.
 */
interface TreeDir {
  dirs: Map<string, TreeDir>;
  files: Map<string, string>; // name → text
}

function emptyDir(): TreeDir {
  return { dirs: new Map(), files: new Map() };
}

function buildHierarchy(tree: VersionedFile[]): TreeDir {
  const root = emptyDir();
  for (const f of tree) {
    const parts = f.path.split("/").filter((p) => p.length > 0);
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i] as string;
      let next = cur.dirs.get(name);
      if (!next) {
        next = emptyDir();
        cur.dirs.set(name, next);
      }
      cur = next;
    }
    const leaf = parts[parts.length - 1];
    if (leaf !== undefined) cur.files.set(leaf, f.text);
  }
  return root;
}

/** Recursively write a directory hierarchy as git tree objects; return the root tree oid. */
async function writeTreeRecursive(fs: GitFs, gitdir: string, node: TreeDir): Promise<string> {
  const entries: { mode: string; path: string; oid: string; type: "blob" | "tree" }[] = [];

  for (const [name, text] of node.files) {
    const oid = await git.writeBlob({ fs, gitdir, blob: new TextEncoder().encode(text) });
    entries.push({ mode: "100644", path: name, oid, type: "blob" });
  }
  for (const [name, child] of node.dirs) {
    const oid = await writeTreeRecursive(fs, gitdir, child);
    entries.push({ mode: "040000", path: name, oid, type: "tree" });
  }
  // git requires tree entries sorted by name.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return git.writeTree({ fs, gitdir, tree: entries });
}

/**
 * Commit `tree` onto `fullRef` of the bare repo at `gitdir` using object plumbing
 * (porcelain `git.commit` is worktree/index-oriented and unfit for a bare repo),
 * with an EXPLICIT `parent` (the caller decides — never resolved from ambient
 * state, so a stale ref can't sneak in as a parent). Updates `fullRef` to the new
 * commit and returns it.
 */
export async function commitTreeOnto(
  fs: GitFs,
  gitdir: string,
  fullRef: string,
  parent: string[],
  tree: VersionedFile[],
  nowSec: number,
): Promise<PushResult> {
  const treeOid = await writeTreeRecursive(fs, gitdir, buildHierarchy(tree));
  const oid = await git.writeCommit({
    fs,
    gitdir,
    commit: {
      tree: treeOid,
      parent,
      author: { ...AUTHOR, timestamp: nowSec, timezoneOffset: 0 },
      committer: { ...AUTHOR, timestamp: nowSec, timezoneOffset: 0 },
      message: "galley projection\n",
    },
  });
  await git.writeRef({ fs, gitdir, ref: fullRef, value: oid, force: true });
  return { oid, ref: fullRef };
}

/**
 * Local-bare push: `gitdir` IS the real remote (a bare repo), so the ref's
 * current tip is the authoritative parent — resolve it and commit onto it.
 */
export async function commitTreeToRef(
  fs: GitFs,
  gitdir: string,
  fullRef: string,
  tree: VersionedFile[],
  nowSec: number,
): Promise<PushResult> {
  const parent = await git
    .resolveRef({ fs, gitdir, ref: fullRef })
    .then((tip) => [tip])
    .catch(() => [] as string[]); // new ref → root commit
  return commitTreeOnto(fs, gitdir, fullRef, parent, tree, nowSec);
}

/**
 * Caps on an imported fetch CANDIDATE (DoS guard against a hostile/huge remote —
 * we read every blob into memory). Mirrors the repo's existing input-cap posture
 * (`apps/compile` `ArchiveLimits`), scaled up since a candidate is a whole project
 * tree, not a single package. Exceeding any cap fails closed.
 */
export interface FetchLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_FETCH_LIMITS: FetchLimits = {
  maxFiles: 4_096,
  maxFileBytes: 5 * 1024 * 1024, // 5 MiB / file
  maxTotalBytes: 50 * 1024 * 1024, // 50 MiB total
};

/**
 * Read every file of `fullRef`'s tree from the bare repo at `gitdir`, sorted by
 * path — bounded by `limits` (file-count, per-file bytes, total bytes). A remote
 * exceeding any cap aborts with a sanitized error (no remote-controlled content
 * in the message). Returns `null` if the ref is absent.
 */
export async function readTreeAtRef(
  fs: GitFs,
  gitdir: string,
  fullRef: string,
  limits: FetchLimits,
): Promise<VersionedFile[] | null> {
  let oid: string;
  try {
    oid = await git.resolveRef({ fs, gitdir, ref: fullRef });
  } catch {
    return null; // unknown ref → nothing to import
  }
  const paths = await git.listFiles({ fs, gitdir, ref: oid });
  if (paths.length > limits.maxFiles) {
    throw new Error(`fetch candidate exceeds the file-count cap (${limits.maxFiles})`);
  }
  const out: VersionedFile[] = [];
  let total = 0;
  for (const path of paths) {
    const { blob } = await git.readBlob({ fs, gitdir, oid, filepath: path });
    if (blob.byteLength > limits.maxFileBytes) {
      throw new Error(`fetch candidate file exceeds the per-file byte cap (${limits.maxFileBytes})`);
    }
    total += blob.byteLength;
    if (total > limits.maxTotalBytes) {
      throw new Error(`fetch candidate exceeds the total byte cap (${limits.maxTotalBytes})`);
    }
    out.push({ path, text: new TextDecoder().decode(blob) });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

// --- HttpRemoteSync (live network edge — wired, NOT gate-exercised) -----------

/**
 * A minimal structural view of isomorphic-git's `HttpClient`. We accept it via
 * injection so we never import the `isomorphic-git/http/*` subpath at module load
 * (keeps this file network-free and the gate offline). Callers wire the real
 * client (`import http from "isomorphic-git/http/node"` on Node, or
 * `createBrowserGitHttp()` in the browser).
 */
export interface GitHttpClient {
  request: (args: unknown) => Promise<unknown>;
}

/**
 * The real network projection over smart-HTTP. **Wired but intentionally not
 * exercised in the CI gate** (no network in CI) — same posture as the repo's
 * other injected-IO seams.
 *
 * Both the `fs` and the scratch provider are INJECTED (ADR-0019): the Node default
 * is `node:fs` + `mkdtemp(tmpdir())` scratch (see `git-remote-node.ts`); the
 * browser injects an in-memory fs + per-op in-memory scratch (see
 * `browser-git-fs.ts`). Each op runs in a FRESH scratch gitdir torn down in a
 * `finally` — so there is no ambient/stale state to leak or corrupt across
 * remotes, and a swallowed fetch can never let us parent onto an unrelated
 * history. The token is supplied through `onAuth` (never embedded in a URL),
 * every error self-redacts, and `git.push`'s report is summarized (never surfaced
 * verbatim, which could echo the URL/creds).
 *
 * @param http  the injected `isomorphic-git/http/*` client.
 * @param fs  the injected git fs (`node:fs` on Node, in-memory in the browser).
 * @param scratch  fresh-isolated scratch gitdir provider (per-op make/cleanup).
 * @param nowSec  injectable seconds clock (deterministic tests).
 * @param limits  caps on a fetched import candidate (DoS guard).
 */
export class HttpRemoteSync implements RemoteSync {
  constructor(
    private readonly http: GitHttpClient,
    private readonly fs: GitFs,
    private readonly scratch: ScratchProvider,
    private readonly nowSec: () => number = () => Math.floor(Date.now() / 1000),
    private readonly limits: FetchLimits = DEFAULT_FETCH_LIMITS,
  ) {}

  private onAuth(config: RemoteConfig) {
    // Token via the auth callback only — never baked into the URL.
    return config.auth?.token
      ? () => ({ username: config.auth!.token, password: BASIC_PASSWORD })
      : undefined;
  }

  /**
   * Fail closed (HIGH-1, ADR-0019) BEFORE any network op if the remote URL carries
   * `userinfo`. Credentials belong in `auth.token` (sent via HTTP Basic `onAuth`),
   * never in the URL — a userinfo URL would round-trip into a render path and be
   * logged by intermediaries. The thrown message is fixed and secret-free.
   */
  private assertNoUrlCredentials(config: RemoteConfig): void {
    if (urlHasUserinfo(config.url)) {
      throw new Error(
        "remote URL must not contain credentials — put your access token in the token field, not the URL",
      );
    }
  }

  /** Run `body` against a fresh, isolated scratch gitdir that is always cleaned up. */
  private async withScratch<T>(fn: (gitdir: string) => Promise<T>): Promise<T> {
    const gitdir = await this.scratch.make();
    try {
      await git.init({ fs: this.fs, gitdir, bare: true, defaultBranch: DEFAULT_BRANCH });
      return await fn(gitdir);
    } finally {
      await this.scratch.cleanup(gitdir);
    }
  }

  async pushTree(config: RemoteConfig, fullRef: string, tree: VersionedFile[]): Promise<PushResult> {
    try {
      this.assertNoUrlCredentials(config);
      return await this.withScratch(async (gitdir) => {
        // Fetch the remote tip so the projection parents onto it. We parent ONLY
        // off the ref the fetch actually wrote into THIS fresh repo — never an
        // ambient pre-existing ref. If the fetch fails (no such ref), it's a
        // first/root push; the scratch repo is empty so there's nothing stale.
        let parent: string[] = [];
        try {
          await git.fetch({
            fs: this.fs,
            http: this.http as never,
            gitdir,
            url: config.url,
            ref: fullRef,
            singleBranch: true,
            depth: 1,
            ...(this.onAuth(config) ? { onAuth: this.onAuth(config) } : {}),
          });
          const tip = await resolveFetchedTip(this.fs, gitdir, fullRef);
          if (tip) {
            await git.writeRef({ fs: this.fs, gitdir, ref: fullRef, value: tip, force: true });
            parent = [tip];
          }
        } catch {
          parent = []; // remote ref absent → root commit (fresh repo, no stale state)
        }

        const result = await commitTreeOnto(this.fs, gitdir, fullRef, parent, tree, this.nowSec());
        const report = await git.push({
          fs: this.fs,
          http: this.http as never,
          gitdir,
          url: config.url,
          ref: fullRef,
          remoteRef: fullRef,
          force: false,
          ...(this.onAuth(config) ? { onAuth: this.onAuth(config) } : {}),
        });
        if (report.ok === false || report.error) {
          // Don't surface the raw report (could echo the URL/creds); summarize.
          throw new Error("remote rejected the push");
        }
        return result;
      });
    } catch (err) {
      throw redactRemoteError(err, config);
    }
  }

  async fetchTree(config: RemoteConfig, fullRef: string): Promise<VersionedFile[] | null> {
    try {
      this.assertNoUrlCredentials(config);
      return await this.withScratch(async (gitdir) => {
        try {
          await git.fetch({
            fs: this.fs,
            http: this.http as never,
            gitdir,
            url: config.url,
            ref: fullRef,
            singleBranch: true,
            depth: 1,
            ...(this.onAuth(config) ? { onAuth: this.onAuth(config) } : {}),
          });
        } catch {
          return null; // no such ref / nothing to import
        }
        const tip = await resolveFetchedTip(this.fs, gitdir, fullRef);
        if (!tip) return null;
        await git.writeRef({ fs: this.fs, gitdir, ref: fullRef, value: tip, force: true });
        return readTreeAtRef(this.fs, gitdir, fullRef, this.limits);
      });
    } catch (err) {
      throw redactRemoteError(err, config);
    }
  }
}

/**
 * Resolve the tip that a just-completed `git.fetch` landed in THIS fresh gitdir:
 * the local ref if `git.fetch` wrote it, else the remote-tracking ref it always
 * writes. Returns `undefined` if neither exists (nothing was fetched).
 */
async function resolveFetchedTip(
  fs: GitFs,
  gitdir: string,
  fullRef: string,
): Promise<string | undefined> {
  const branch = fullRef.replace(/^refs\/heads\//, "");
  for (const ref of [fullRef, `refs/remotes/origin/${branch}`]) {
    const oid = await git.resolveRef({ fs, gitdir, ref }).catch(() => undefined);
    if (oid) return oid;
  }
  return undefined;
}
