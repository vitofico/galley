/**
 * Connect GitHub v0 (roadmap "Connect GitHub — paste-a-PAT + manual push") —
 * the PURE GitHub REST client, over an INJECTED fetch seam.
 *
 * Why REST and not git smart-HTTP: browsers cannot reach `github.com`'s git
 * endpoints (no CORS), but `api.github.com` serves CORS headers — so the GitHub
 * path projects the CRDT snapshot through the Git Data API instead of the
 * existing isomorphic-git transport. The CRDT remains the single source of
 * truth; this is a ONE-WAY push (no fetch from GitHub in v0).
 *
 * ## Security posture (mirrors `redactRemoteError` discipline, ADR-0019)
 *  - The token rides ONLY in the `Authorization` header; it is never placed in
 *    a URL, a body, or an error message.
 *  - Every surfaced error passes through {@link scrubToken}, which strips the
 *    literal token, its URL-percent-encoded form, its base64 form, and the
 *    `Bearer <token>` wire form — so no encoding of the secret can ride out of
 *    this module, even if a transport echoed the request back.
 *  - The response text we PARSE/SURFACE is capped ({@link MAX_BODY_CHARS}).
 *    Honest scope: this is a parse/display cap, NOT an IO cap — the transport
 *    still reads the full body before we truncate it.
 *  - Failures map to a small TYPED vocabulary ({@link GithubErrorKind}) the UI
 *    renders honest copy from — never raw wire text alone.
 */
import { base64Utf8 } from "@galley/persistence/browser";

/** The error vocabulary the UI maps to honest copy. */
export type GithubErrorKind =
  | "bad-token"
  | "not-found"
  | "rate-limited"
  | "conflict"
  | "network"
  | "invalid"
  | "too-large";

/** A typed GitHub API failure. The message is ALWAYS token-scrubbed. */
export class GithubApiError extends Error {
  readonly kind: GithubErrorKind;
  readonly status: number | undefined;

  constructor(kind: GithubErrorKind, message: string, status?: number) {
    super(message);
    this.name = "GithubApiError";
    this.kind = kind;
    this.status = status;
  }
}

/** The slice of a `Response` this client reads — injectable fakes stay tiny. */
export interface GithubResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** The injected fetch seam (unit tests pass a recording fake; prod the global). */
export type GithubFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<GithubResponseLike>;

export interface GithubApiOptions {
  /** The fetch implementation. Default: the global `fetch`. */
  fetchImpl?: GithubFetch;
  /** API origin — overridable only for tests. Default {@link GITHUB_API_BASE}. */
  baseUrl?: string;
}

export const GITHUB_API_BASE = "https://api.github.com";

/**
 * Cap on how much response TEXT is parsed/surfaced (chars). NOT an IO cap: the
 * transport reads the body first; we truncate before parsing/error-mapping.
 */
export const MAX_BODY_CHARS = 64_000;

/** Caps on a pushed snapshot — beyond these we fail CLOSED with `too-large`. */
export const MAX_SNAPSHOT_FILES = 500;
export const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024; // 10 MiB of UTF-8 text

/**
 * Strip every encoding of `token` from `text`: the literal, the URL-encoded
 * form, the base64 form, and the `Bearer …` wire form. Defense in depth — we
 * never PUT the token into a message, but a transport error might echo our
 * request, so we scrub anyway (same discipline as `redactRemoteError`).
 */
export function scrubToken(text: string, token: string): string {
  if (!token) return text;
  let out = text;
  for (const form of [
    `Bearer ${token}`,
    token,
    encodeURIComponent(token),
    base64Utf8(token),
    base64Utf8(`Bearer ${token}`),
  ]) {
    if (form) out = out.split(form).join("[redacted]");
  }
  return out;
}

function defaultFetch(): GithubFetch {
  const f = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof f !== "function") {
    return () => Promise.reject(new Error("fetch is unavailable in this environment"));
  }
  // BIND to the global: an unbound `fetch` reference throws "Illegal invocation"
  // in browsers.
  const bound = f.bind(globalThis);
  return (url, init) => bound(url, init);
}

interface ResolvedOptions {
  fetchImpl: GithubFetch;
  baseUrl: string;
  token: string;
}

function resolve(token: string, opts: GithubApiOptions): ResolvedOptions {
  return {
    fetchImpl: opts.fetchImpl ?? defaultFetch(),
    baseUrl: (opts.baseUrl ?? GITHUB_API_BASE).replace(/\/+$/, ""),
    token,
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Pull GitHub's `{ message }` out of an error body, capped + fail-soft. */
function apiMessage(bodyText: string): string | null {
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { message?: unknown }).message === "string"
    ) {
      return (parsed as { message: string }).message.slice(0, 300);
    }
  } catch {
    // Non-JSON error body — ignored; the status line is enough.
  }
  return null;
}

/** Map a non-2xx response to a typed, token-scrubbed {@link GithubApiError}. */
function mapHttpError(res: GithubResponseLike, bodyText: string, token: string): GithubApiError {
  const detail = apiMessage(bodyText);
  const suffix = detail ? ` — ${detail}` : "";
  const make = (kind: GithubErrorKind, msg: string) =>
    new GithubApiError(kind, scrubToken(msg, token), res.status);
  if (res.status === 401) {
    return make("bad-token", `GitHub rejected the token (HTTP 401)${suffix}`);
  }
  if (res.status === 429) {
    return make("rate-limited", `GitHub rate limit hit (HTTP 429)${suffix}`);
  }
  if (res.status === 403) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0" || (detail ?? "").toLowerCase().includes("rate limit")) {
      return make("rate-limited", `GitHub rate limit hit (HTTP 403)${suffix}`);
    }
    return make("bad-token", `GitHub refused — the token lacks access (HTTP 403)${suffix}`);
  }
  if (res.status === 404) {
    return make("not-found", `GitHub could not find that (HTTP 404)${suffix}`);
  }
  if (res.status === 409 || res.status === 422) {
    return make("conflict", `GitHub reported a conflict (HTTP ${res.status})${suffix}`);
  }
  return make("network", `GitHub request failed (HTTP ${res.status})${suffix}`);
}

/**
 * One authenticated JSON request. 2xx → parsed JSON; anything else → a typed,
 * token-scrubbed {@link GithubApiError}. The body TEXT is truncated to
 * {@link MAX_BODY_CHARS} before parsing (a parse/surface cap, not an IO cap).
 */
async function request(
  o: ResolvedOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  let res: GithubResponseLike;
  try {
    res = await o.fetchImpl(`${o.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${o.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw new GithubApiError(
      "network",
      scrubToken(`Could not reach GitHub: ${errMessage(err)}`, o.token),
    );
  }
  let text = "";
  try {
    text = (await res.text()).slice(0, MAX_BODY_CHARS);
  } catch {
    text = "";
  }
  if (res.status >= 200 && res.status < 300) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GithubApiError(
        "network",
        `GitHub returned an unreadable response (HTTP ${res.status}).`,
        res.status,
      );
    }
  }
  throw mapHttpError(res, text, o.token);
}

/** A string field plucked from a parsed JSON object, or a typed failure. */
function stringField(value: unknown, field: string, context: string): string {
  const v =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[field]
      : undefined;
  if (typeof v !== "string" || v.length === 0) {
    throw new GithubApiError("network", `GitHub's ${context} response had no ${field}.`);
  }
  return v;
}

// --- Identifier validation (these become URL path segments) ------------------

const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

function assertOwnerRepo(value: string, what: "owner" | "repository"): string {
  const v = value.trim();
  if (!v || !OWNER_REPO_RE.test(v) || v === "." || v === "..") {
    throw new GithubApiError("invalid", `That is not a valid GitHub ${what} name.`);
  }
  return v;
}

function assertBranch(value: string): string {
  const v = value.trim();
  // `.` and `..` segments are rejected: they would URL-normalize the ref path
  // onto a DIFFERENT branch (`release/./main` → `release/main`), and a
  // force-push to the wrong branch is the worst possible outcome.
  if (
    !v ||
    !BRANCH_RE.test(v) ||
    v.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  ) {
    throw new GithubApiError("invalid", "That is not a valid branch name.");
  }
  return v;
}

/**
 * Percent-encode each branch segment for use in a URL path (slashes preserved —
 * GitHub ref routes take `heads/a/b` literally). Defensive: the validated
 * charset is already URL-safe, so this is the identity today; it stays correct
 * if the validation ever loosens.
 */
function encodeBranchPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

// --- Public API ---------------------------------------------------------------

/** `GET /user` — proves the PAT works and resolves who it belongs to. */
export async function validateToken(
  token: string,
  opts: GithubApiOptions = {},
): Promise<{ login: string }> {
  const t = token.trim();
  if (!t) throw new GithubApiError("invalid", "Paste a personal access token first.");
  const o = resolve(t, opts);
  const user = await request(o, "GET", "/user");
  return { login: stringField(user, "login", "user") };
}

export interface CreateRepoRequest {
  name: string;
  description?: string;
  /** Default TRUE — a paper's working copy should not be public by accident. */
  private?: boolean;
}

/** `POST /user/repos` — create a repository under the token's account. */
export async function createRepo(
  token: string,
  req: CreateRepoRequest,
  opts: GithubApiOptions = {},
): Promise<{ owner: string; name: string }> {
  const name = assertOwnerRepo(req.name, "repository");
  const o = resolve(token.trim(), opts);
  const repo = await request(o, "POST", "/user/repos", {
    name,
    private: req.private ?? true,
    ...(req.description ? { description: req.description.slice(0, 300) } : {}),
    auto_init: false,
  });
  const ownerObj =
    typeof repo === "object" && repo !== null
      ? (repo as { owner?: unknown }).owner
      : undefined;
  return {
    owner: stringField(ownerObj, "login", "repository"),
    name: stringField(repo, "name", "repository"),
  };
}

/** One text file of the snapshot (the materialized CRDT projection). */
export interface SnapshotFile {
  path: string;
  text: string;
}

export interface PushSnapshotRequest {
  owner: string;
  repo: string;
  /** Default `"main"`. */
  branch?: string;
  message: string;
  files: SnapshotFile[];
  // Deliberately NO `author`/`committer` seam (roadmap #12). Under the personal-PAT
  // model the pusher IS the token owner, so letting GitHub default both fields to
  // the authenticated user yields a VERIFIED, LINKED identity (avatar, profile
  // link, contribution-graph credit). Supplying a synthesized `@users.galley.local`
  // identity would trade that for an unlinkable one — and since an omitted
  // `committer` defaults to the AUTHOR, it would take BOTH fields down with it.
  // Contributor attribution rides the commit MESSAGE trailers instead.
}

export interface PushSnapshotResult {
  commitSha: string;
  branch: string;
  /** True when the push created the branch (first push / empty repo). */
  createdBranch: boolean;
  filesPushed: number;
}

/**
 * Reject a path that could escape the tree or smuggle odd segments. Mirrors the
 * shared `isSafeProjectPath` rules over the RELATIVE tree-path form the
 * projection emits (defense in depth — `materializeProject` already gated).
 */
function assertSafeSnapshotPath(path: string): void {
  let bad =
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
  if (!bad) {
    for (let i = 0; i < path.length; i++) {
      const code = path.charCodeAt(i);
      if (code <= 0x1f || code === 0x7f) {
        bad = true;
        break;
      }
    }
  }
  if (bad) {
    throw new GithubApiError("invalid", `Cannot push: unsafe file path "${path.slice(0, 80)}".`);
  }
}

/**
 * Push a whole-tree snapshot via the Git Data API:
 *
 *   1. `GET  /git/ref/heads/<branch>` — the parent commit (absent on a fresh
 *      branch → parentless commit; GitHub answers 409 on a wholly EMPTY repo,
 *      whose Git Data API is unusable until an initial commit exists);
 *   1b. on that 409, `PUT /contents/.galley-init` to BOOTSTRAP the empty repo
 *      with a first commit (the Contents API works where the Git Data API does
 *      not), then re-read the ref for its parent — the placeholder is replaced
 *      by the snapshot tree in step 4 (no base_tree);
 *   2. `POST /git/blobs` per file (utf-8 text);
 *   3. `POST /git/trees` — one full tree (nested paths allowed; NO base_tree:
 *      the snapshot REPLACES the branch contents, because the CRDT is the
 *      source of truth and git is a one-way projection);
 *   4. `POST /git/commits` — parented on (1) when it existed;
 *   5. `PATCH /git/refs/heads/<branch>` with `force:true`, or `POST /git/refs`
 *      when the branch is new.
 */
export async function pushSnapshot(
  token: string,
  req: PushSnapshotRequest,
  opts: GithubApiOptions = {},
): Promise<PushSnapshotResult> {
  const owner = assertOwnerRepo(req.owner, "owner");
  const repo = assertOwnerRepo(req.repo, "repository");
  const branch = assertBranch(req.branch ?? "main");
  if (req.files.length === 0) {
    throw new GithubApiError("invalid", "Cannot push: the project materialized to no files.");
  }
  if (req.files.length > MAX_SNAPSHOT_FILES) {
    throw new GithubApiError(
      "too-large",
      `Cannot push: ${req.files.length} files exceeds the ${MAX_SNAPSHOT_FILES}-file cap.`,
    );
  }
  const encoder = new TextEncoder();
  let totalBytes = 0;
  for (const f of req.files) {
    assertSafeSnapshotPath(f.path);
    totalBytes += encoder.encode(f.text).length;
  }
  if (totalBytes > MAX_SNAPSHOT_BYTES) {
    throw new GithubApiError(
      "too-large",
      `Cannot push: the snapshot is ${(totalBytes / (1024 * 1024)).toFixed(1)} MiB — over the ${MAX_SNAPSHOT_BYTES / (1024 * 1024)} MiB cap.`,
    );
  }

  const o = resolve(token.trim(), opts);
  // Defensive percent-encoding of every dynamic URL path segment — identity
  // for the validated charset, but no validated value is ever interpolated raw.
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const branchPath = encodeBranchPath(branch);

  // 1. Parent commit, if the branch exists. 404 = branch (or repo) missing,
  //    but the repo HAS commits → the Git Data API works, so push as a new
  //    branch with a parentless commit. 409 = GitHub's "Git Repository is
  //    empty" — a WHOLLY empty repo, where the Git Data API (blobs/trees/
  //    commits) 409s on every call until an initial commit exists; that repo
  //    must be bootstrapped (step 1b) before we can push.
  //    A missing REPO also 404s here; that surfaces clearly at the blob step.
  let parentSha: string | null = null;
  let repoEmpty = false;
  try {
    const ref = await request(o, "GET", `${repoPath}/git/ref/heads/${branchPath}`);
    const obj =
      typeof ref === "object" && ref !== null ? (ref as { object?: unknown }).object : undefined;
    parentSha = stringField(obj, "sha", "ref");
  } catch (err) {
    if (err instanceof GithubApiError && err.kind === "conflict") {
      repoEmpty = true;
    } else if (err instanceof GithubApiError && err.kind === "not-found") {
      parentSha = null;
    } else {
      throw err;
    }
  }
  // Did the branch already exist? (Only then do we PATCH instead of POST the
  // ref, and report createdBranch:false.) Captured BEFORE the bootstrap below
  // gives the empty repo a parent commit of its own.
  const branchExisted = parentSha !== null;

  // 1b. Bootstrap a wholly-empty repo. The Contents API creates an initial
  //     commit even on an empty repo (the Git Data API cannot), unblocking the
  //     blob/tree/commit flow below. The placeholder it writes is transient:
  //     the snapshot tree carries NO base_tree, so the force-push that follows
  //     replaces the whole branch — the placeholder never survives.
  if (repoEmpty) {
    await request(o, "PUT", `${repoPath}/contents/.galley-init`, {
      message: "chore: initialize repository",
      content: base64Utf8("Initialized by Galley — replaced by the first snapshot push.\n"),
      branch,
    });
    const ref = await request(o, "GET", `${repoPath}/git/ref/heads/${branchPath}`);
    const obj =
      typeof ref === "object" && ref !== null ? (ref as { object?: unknown }).object : undefined;
    parentSha = stringField(obj, "sha", "ref");
  }

  // 2. Blobs — sequential, so the call order is deterministic and we stop at
  //    the first failure instead of spraying requests.
  const blobShas: string[] = [];
  for (const f of req.files) {
    const blob = await request(o, "POST", `${repoPath}/git/blobs`, {
      content: f.text,
      encoding: "utf-8",
    });
    blobShas.push(stringField(blob, "sha", "blob"));
  }

  // 3. One full tree (no base_tree — the projection replaces the branch).
  const tree = await request(o, "POST", `${repoPath}/git/trees`, {
    tree: req.files.map((f, i) => ({
      path: f.path,
      mode: "100644",
      type: "blob",
      sha: blobShas[i],
    })),
  });
  const treeSha = stringField(tree, "sha", "tree");

  // 4. The snapshot commit. ALWAYS exactly {message, tree, parents}: no author
  //    and no committer, so GitHub attributes both to the authenticated PAT
  //    owner — a real, linked identity. See PushSnapshotRequest for why.
  const commit = await request(o, "POST", `${repoPath}/git/commits`, {
    message: req.message,
    tree: treeSha,
    parents: parentSha ? [parentSha] : [],
  });
  const commitSha = stringField(commit, "sha", "commit");

  // 5. Move (or create) the branch ref. `force` is honest: the remote is a
  //    one-way mirror of the CRDT, not a merge participant (ADR-0018).
  if (parentSha) {
    await request(o, "PATCH", `${repoPath}/git/refs/heads/${branchPath}`, {
      sha: commitSha,
      force: true,
    });
  } else {
    await request(o, "POST", `${repoPath}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: commitSha,
    });
  }

  return { commitSha, branch, createdBranch: !branchExisted, filesPushed: req.files.length };
}

// --- Fetch a snapshot (GitHub Fetch — the REST tree read) ---------------------

/** Where a fetch reads from: owner/repo on a branch. Mirrors the push target. */
export interface FetchSnapshotTarget {
  owner: string;
  repo: string;
  /** Default `"main"`. */
  branch?: string;
}

/**
 * Decode a base64 string (GitHub wraps blob `content` at 60 chars with `\n`) to
 * a UTF-8 string, runtime-neutral — `atob` when present (browser/worker), else a
 * small pure fallback. The mirror of {@link base64Utf8}; kept here, not in the
 * persistence core, because only this REST read path needs to DECODE.
 */
function utf8FromBase64(input: string): string {
  const clean = input.replace(/\s+/g, "");
  const g = globalThis as unknown as { atob?: (s: string) => string };
  let binary: string;
  if (typeof g.atob === "function") {
    binary = g.atob(clean);
  } else {
    binary = binaryFromBase64(clean);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Pure base64 → binary (Latin-1) string — fallback when `atob` is absent. */
function binaryFromBase64(b64: string): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
  let binary = "";
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < b64.length; i++) {
    const c = b64.charCodeAt(i);
    if (c === 0x3d /* '=' */) break;
    const v = c < 128 ? lookup[c]! : -1;
    if (v < 0) continue; // skip any stray non-alphabet char defensively
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      binary += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return binary;
}

/** One entry of GitHub's recursive tree response we care about. */
interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  /** Blob byte size from the tree listing — used for the pre-blob byte preflight. */
  size: number;
}

/** Pull the typed blob entries out of a parsed `GET /git/trees` response. */
function treeBlobs(tree: unknown): { entries: TreeEntry[]; truncated: boolean } {
  const obj = typeof tree === "object" && tree !== null ? (tree as Record<string, unknown>) : {};
  const truncated = obj.truncated === true;
  const rawList = Array.isArray(obj.tree) ? obj.tree : [];
  const entries: TreeEntry[] = [];
  for (const raw of rawList) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as Record<string, unknown>;
    if (e.type !== "blob") continue; // skip subtree (dir) and submodule entries
    if (typeof e.path === "string" && typeof e.sha === "string" && e.path && e.sha) {
      // `size` is the attacker-influenced byte count; keep it raw (a missing /
      // non-finite value becomes NaN) so the byte preflight can fail closed on it.
      const size = typeof e.size === "number" ? e.size : Number.NaN;
      entries.push({ path: e.path, type: "blob", sha: e.sha, size });
    }
  }
  return { entries, truncated };
}

/**
 * Read a whole-tree snapshot back from GitHub via the Git Data API — the inverse
 * of {@link pushSnapshot}, returning the branch's files as {@link SnapshotFile}[]
 * (the Accept-gated import CANDIDATE):
 *
 *   1. `GET /git/ref/heads/<branch>` → commit sha. A 404 (no such ref) or a 409
 *      (wholly empty repo) both mean "nothing to import" → `null`.
 *   2. `GET /git/commits/<sha>` → the commit's tree sha.
 *   3. `GET /git/trees/<sha>?recursive=1` → the blob list. If GitHub reports the
 *      tree `truncated`, it exceeds {@link MAX_SNAPSHOT_FILES}, or the summed blob
 *      `size`s exceed {@link MAX_SNAPSHOT_BYTES} (a byte preflight done from the
 *      tree listing, BEFORE any blob download — a missing size also fails closed),
 *      we fail CLOSED with `too-large` — NEVER a silent partial import.
 *   4. `GET /git/blobs/<sha>` per blob → base64 → UTF-8 text.
 *
 * Every returned path is run through {@link assertSafeSnapshotPath} (defense in
 * depth: a hostile remote tree cannot smuggle a traversal path into the
 * candidate). An empty tree (e.g. a freshly bootstrapped repo) → `null`. The
 * token rides only in the `Authorization` header and never appears in a thrown
 * message ({@link scrubToken} discipline, via {@link request}).
 */
export async function fetchSnapshot(
  token: string,
  target: FetchSnapshotTarget,
  opts: GithubApiOptions = {},
): Promise<SnapshotFile[] | null> {
  const owner = assertOwnerRepo(target.owner, "owner");
  const repo = assertOwnerRepo(target.repo, "repository");
  const branch = assertBranch(target.branch ?? "main");

  const o = resolve(token.trim(), opts);
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const branchPath = encodeBranchPath(branch);

  // 1. Resolve the branch ref to a commit sha. 404 (no ref) and 409 (wholly
  //    empty repo, whose Git Data API 409s) both mean "nothing to import".
  let commitSha: string;
  try {
    const ref = await request(o, "GET", `${repoPath}/git/ref/heads/${branchPath}`);
    const obj =
      typeof ref === "object" && ref !== null ? (ref as { object?: unknown }).object : undefined;
    commitSha = stringField(obj, "sha", "ref");
  } catch (err) {
    if (err instanceof GithubApiError && (err.kind === "not-found" || err.kind === "conflict")) {
      return null;
    }
    throw err;
  }

  // 2. The commit's tree sha.
  const commit = await request(o, "GET", `${repoPath}/git/commits/${encodeURIComponent(commitSha)}`);
  const treeRef =
    typeof commit === "object" && commit !== null ? (commit as { tree?: unknown }).tree : undefined;
  const treeSha = stringField(treeRef, "sha", "commit");

  // 3. The recursive tree. Fail CLOSED on a truncated tree or one over the cap —
  //    a partial import would silently drop files, the worst quiet outcome.
  const treeJson = await request(
    o,
    "GET",
    `${repoPath}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
  );
  const { entries, truncated } = treeBlobs(treeJson);
  if (truncated) {
    throw new GithubApiError(
      "too-large",
      `Cannot import: GitHub truncated the tree listing (over the ${MAX_SNAPSHOT_FILES}-file cap).`,
    );
  }
  if (entries.length > MAX_SNAPSHOT_FILES) {
    throw new GithubApiError(
      "too-large",
      `Cannot import: ${entries.length} files exceeds the ${MAX_SNAPSHOT_FILES}-file cap.`,
    );
  }
  if (entries.length === 0) return null;

  // 3b. PREFLIGHT every entry from the (untrusted) tree listing BEFORE any blob
  //     download: validate the path (cheap, structural — defense in depth against
  //     a hostile traversal path) and accumulate bytes from the listing's `size`,
  //     failing CLOSED on an oversized import OR a missing/invalid size. Without
  //     this, a hostile repo with <=500 files but one huge blob would force the
  //     browser to buffer a giant base64 body — `request()` reads the whole
  //     response before capping, so the file-count cap alone is not a byte cap.
  let totalBytes = 0;
  for (const entry of entries) {
    assertSafeSnapshotPath(entry.path);
    if (!Number.isFinite(entry.size) || entry.size < 0) {
      throw new GithubApiError(
        "too-large",
        `Cannot import: GitHub reported no usable size for "${entry.path.slice(0, 80)}".`,
      );
    }
    totalBytes += entry.size;
  }
  if (totalBytes > MAX_SNAPSHOT_BYTES) {
    throw new GithubApiError(
      "too-large",
      `Cannot import: the snapshot is ${(totalBytes / (1024 * 1024)).toFixed(1)} MiB — over the ${MAX_SNAPSHOT_BYTES / (1024 * 1024)} MiB cap.`,
    );
  }

  // 4. Each blob → base64 → UTF-8 text, sequentially (stop at the first failure).
  //    Paths were already validated in the preflight above.
  const files: SnapshotFile[] = [];
  for (const entry of entries) {
    const blob = await request(o, "GET", `${repoPath}/git/blobs/${encodeURIComponent(entry.sha)}`);
    const content = stringField(blob, "content", "blob");
    files.push({ path: entry.path, text: utf8FromBase64(content) });
  }
  return files;
}
