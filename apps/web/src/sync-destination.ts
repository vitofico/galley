/**
 * Per-project sync-destination KIND marker (unified-git-sync redesign,
 * 2026-06-18).
 *
 * A project syncs to EXACTLY ONE destination of a known kind — "github"
 * (connection-backed REST snapshot) or "git" (self-contained smart-HTTP remote).
 * This tiny store records that kind EXPLICITLY, so the panel renders the right
 * destination even if residue lingers in the other kind's per-project store
 * after a switch. It is the load-order authority: read the marker → render that
 * destination; absent → show the chooser.
 *
 * Mirrors `github-repo-target.ts`: one namespaced, versioned localStorage key
 * per project id, zero import-time side effects, guarded best-effort storage
 * access, and an injectable store so the Node unit gate drives an in-memory map
 * with no globals.
 *
 * No secret lives here — only a non-sensitive enum marker — so, like the
 * repo-target store, it needs no redacted view.
 */

/** Where a project syncs: a connection-backed GitHub repo, or a generic git remote. */
export type SyncDestinationKind = "github" | "git";

/** The slice of `Storage` we use — injectable so tests pass a fake. */
export interface SyncDestinationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Namespaced, versioned key prefix — one entry per project id. */
export const SYNC_DESTINATION_KEY_PREFIX = "galley.sync-destination.v1";

/** The full storage key for a given project id. */
export function syncDestinationKey(projectId: string): string {
  return `${SYNC_DESTINATION_KEY_PREFIX}.${projectId}`;
}

/** Resolve the guarded default storage (real `localStorage`, else null). */
function defaultStorage(): SyncDestinationStorage | null {
  try {
    if (typeof globalThis !== "undefined" && globalThis.localStorage) {
      return globalThis.localStorage as unknown as SyncDestinationStorage;
    }
  } catch {
    // Accessing localStorage can throw (blocked / sandboxed) — treat as absent.
  }
  return null;
}

/** Narrow an arbitrary stored string to a known kind, or null. */
function asKind(raw: string | null): SyncDestinationKind | null {
  return raw === "github" || raw === "git" ? raw : null;
}

/**
 * Load a project's saved destination kind, or null when nothing is stored /
 * storage is unavailable / the stored value is not a known kind. Fail-soft.
 */
export function loadSyncDestination(
  projectId: string,
  storage: SyncDestinationStorage | null = defaultStorage(),
): SyncDestinationKind | null {
  if (!storage) return null;
  try {
    return asKind(storage.getItem(syncDestinationKey(projectId)));
  } catch {
    return null;
  }
}

/** Persist a project's destination kind. Best-effort: a storage failure never throws. */
export function saveSyncDestination(
  projectId: string,
  kind: SyncDestinationKind,
  storage: SyncDestinationStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(syncDestinationKey(projectId), kind);
  } catch {
    // Best-effort (quota / private mode).
  }
}

/** Remove a project's stored destination kind entirely. */
export function clearSyncDestination(
  projectId: string,
  storage: SyncDestinationStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(syncDestinationKey(projectId));
  } catch {
    // Best-effort.
  }
}

/**
 * Derive the destination kind for an existing project that predates the marker
 * (one-time migration): a stored GitHub repo target wins, else a stored generic
 * git remote, else null (unconfigured → chooser). Matches the design's migration
 * order.
 *
 * Kept PURE — it takes plain presence booleans rather than reading the other
 * stores itself, so it stays Node-testable and the caller owns the store reads.
 */
export function deriveSyncDestinationKind(input: {
  hasGithubRepoTarget: boolean;
  hasGitRemote: boolean;
}): SyncDestinationKind | null {
  if (input.hasGithubRepoTarget) return "github";
  if (input.hasGitRemote) return "git";
  return null;
}
