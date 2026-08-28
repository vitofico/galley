/**
 * The pure, framework-free resolution of the "unified" (home-route) project id —
 * extracted from `unified-root.tsx` so it can be imported WITHOUT pulling the
 * editor's React tree into a chunk (the F13 app-root `AgentBackgroundHosts` reads
 * it to decide the foregrounded project). `unified-root.tsx` re-exports these so
 * its existing importers are unchanged.
 */

/** localStorage key holding the default unified project id (a stable identity). */
export const UNIFIED_PROJECT_KEY = "galley.unified.projectId";

/**
 * SYNCHRONOUS fast-path resolution that never mints: an explicit route id wins
 * (`/p/<id>` — the library opens a specific project that way; the legacy `?id=` is
 * honored for un-redirected callers), else the persisted default from localStorage.
 * Returns `null` when none is available, so the caller falls back to the IndexedDB
 * registry (reopen the most-recent project) BEFORE minting a brand-new one — a
 * browser where localStorage doesn't persist (private mode, blocked/cleared storage)
 * otherwise spawns a fresh random-named project on every reload.
 */
export function fastProjectId(explicit: string | undefined): string | null {
  if (explicit) return explicit;
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("id");
    if (fromUrl) return fromUrl;
  } catch {
    /* no window.location */
  }
  try {
    const stored = localStorage.getItem(UNIFIED_PROJECT_KEY);
    if (stored) return stored;
  } catch {
    /* storage unavailable */
  }
  return null;
}
