/**
 * One-time ⌘K onboarding nudge (#19.4, spec §6) — pure storage logic for the
 * small "Press ⌘K" pill near the actions cluster. The pill shows until the
 * command palette is FIRST opened (any trigger: shortcut, button, or the nudge
 * itself), then is dismissed permanently via a localStorage flag.
 *
 * Pure + storage-edge like `local-profile.ts`: an injectable Storage-slice so
 * the Node unit gate passes a Map-backed fake; the browser default degrades to
 * "never show" when storage is unavailable (a nudge that can't remember being
 * dismissed must not nag on every load).
 */

/** localStorage key recording that the palette has been discovered. */
export const PALETTE_NUDGE_KEY = "galley.onboarding.paletteNudge.v1";

/** The slice of `Storage` we use — injectable so tests pass a fake. */
export interface NudgeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Resolve a default storage (real `localStorage` in the browser, else null). */
function defaultStorage(): NudgeStorage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Access can throw (privacy mode) — treat as unavailable.
  }
  return null;
}

/**
 * Whether the ⌘K nudge should show. True only when storage is AVAILABLE and the
 * dismissed flag is absent — without storage the dismissal couldn't persist, so
 * the nudge stays off rather than nagging forever.
 */
export function shouldShowPaletteNudge(store: NudgeStorage | null = defaultStorage()): boolean {
  if (!store) return false;
  try {
    return store.getItem(PALETTE_NUDGE_KEY) === null;
  } catch {
    return false;
  }
}

/** Permanently dismiss the nudge (called on the palette's first open). */
export function dismissPaletteNudge(store: NudgeStorage | null = defaultStorage()): void {
  if (!store) return;
  try {
    store.setItem(PALETTE_NUDGE_KEY, "dismissed");
  } catch {
    // best-effort
  }
}
