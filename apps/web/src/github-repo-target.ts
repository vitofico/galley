/**
 * Per-project GitHub push target (owner/name/branch).
 *
 * Split out of the device-global `github-connect` connection so each project
 * remembers its OWN repository instead of every project inheriting one
 * device-wide selection (the 2026-06-15 IA/placement follow-up). The PAT +
 * resolved login stay device-scoped in `github-connect`; only the
 * non-sensitive repo coordinates live here, keyed per project.
 *
 * Mirrors `git-remote-config.ts`: one namespaced localStorage key per project
 * id, zero import-time side effects, guarded best-effort storage access, and an
 * injectable store so the Node unit gate drives an in-memory map with no globals.
 *
 * No secret lives in this store — so, unlike the git-remote / connect stores, it
 * needs no redacted view: there is nothing to keep out of the DOM.
 */

/** Where a project's snapshot push lands: owner/repo on a branch. */
export interface GithubRepoSelection {
  owner: string;
  name: string;
  branch: string;
}

/** The slice of `Storage` we use — injectable so tests pass a fake. */
export interface RepoTargetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Namespaced, versioned key prefix — one entry per project id. */
export const GITHUB_REPO_KEY_PREFIX = "galley.github-repo.v1";

/** The full storage key for a given project id. */
export function githubRepoKey(projectId: string): string {
  return `${GITHUB_REPO_KEY_PREFIX}.${projectId}`;
}

/** Resolve the guarded default storage (real `localStorage`, else null). */
function defaultStorage(): RepoTargetStorage | null {
  try {
    if (typeof globalThis !== "undefined" && globalThis.localStorage) {
      return globalThis.localStorage as unknown as RepoTargetStorage;
    }
  } catch {
    // Accessing localStorage can throw (blocked / sandboxed) — treat as absent.
  }
  return null;
}

/**
 * Coerce arbitrary parsed JSON into a valid {@link GithubRepoSelection}, or null.
 * Trims fields; a blank/absent branch defaults to "main". A missing owner or name
 * drops the whole selection (an incomplete target can't push anywhere).
 */
function normalize(raw: unknown): GithubRepoSelection | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const owner = typeof obj.owner === "string" ? obj.owner.trim() : "";
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!owner || !name) return null;
  const branch =
    typeof obj.branch === "string" && obj.branch.trim().length > 0 ? obj.branch.trim() : "main";
  return { owner, name, branch };
}

/**
 * Load a project's saved push target, or null when nothing is stored / storage is
 * unavailable / the stored value is malformed. Fail-soft.
 */
export function loadRepoTarget(
  projectId: string,
  storage: RepoTargetStorage | null = defaultStorage(),
): GithubRepoSelection | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(githubRepoKey(projectId));
    return raw ? normalize(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Outcome of {@link saveRepoTarget}: `ok`, or a user-facing validation `error`. */
export interface SaveResult {
  ok: boolean;
  error?: string;
}

/**
 * Persist a project's push target. Owner + name are required (a blank branch
 * defaults to "main"). Best-effort persist: a storage failure surfaces as
 * `{ ok:false }` rather than throwing.
 */
export function saveRepoTarget(
  projectId: string,
  input: { owner: string; name: string; branch?: string },
  storage: RepoTargetStorage | null = defaultStorage(),
): SaveResult {
  if (!storage) return { ok: false, error: "Storage is unavailable in this browser." };
  const owner = input.owner.trim();
  const name = input.name.trim();
  if (!owner || !name) return { ok: false, error: "Enter the repository owner and name." };
  const branch = input.branch?.trim() || "main";
  try {
    storage.setItem(githubRepoKey(projectId), JSON.stringify({ owner, name, branch }));
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not save in this browser." };
  }
}

/** Remove a project's stored push target entirely. */
export function clearRepoTarget(
  projectId: string,
  storage: RepoTargetStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(githubRepoKey(projectId));
  } catch {
    // Best-effort.
  }
}
