/**
 * One-time first-run coach overlay (onboarding M3) — pure storage logic, a twin
 * of `onboarding-nudge.ts` / `first-run-chooser.ts`. A brand-new local boot
 * lands on the three-pane shell (editor · preview · agent) with no orientation;
 * this gates a calm, NON-BLOCKING overlay that names each pane once, then is
 * dismissed permanently. It never overlays the editor's pointer surface (the
 * component paints `pointer-events: none`, dismissing on Escape or any click),
 * so it can't intercept an edit — the same "never a modal" posture as the ⌘K
 * nudge and the H5 chooser.
 *
 * Pure + storage-edge: an injectable Storage slice so the Node unit gate passes a
 * Map-backed fake; the browser default degrades to "never show" when storage is
 * unavailable (a one-time cue that can't remember being dismissed must not nag on
 * every load).
 */

/** localStorage key recording that the first-run coach overlay has been seen/dismissed. */
export const COACH_OVERLAY_KEY = "galley.onboarding.coachOverlay.v1";

/** The slice of `Storage` we use — injectable so tests pass a fake. */
export interface CoachStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Resolve a default storage (real `localStorage` in the browser, else null). */
function defaultStorage(): CoachStorage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Access can throw (privacy mode) — treat as unavailable.
  }
  return null;
}

/**
 * Whether the coach overlay should show. True only when storage is AVAILABLE and
 * the dismissed flag is absent — without storage the dismissal couldn't persist,
 * so the cue stays off rather than reappearing on every load.
 */
export function shouldShowCoachOverlay(store: CoachStorage | null = defaultStorage()): boolean {
  if (!store) return false;
  try {
    return store.getItem(COACH_OVERLAY_KEY) === null;
  } catch {
    return false;
  }
}

/** Permanently dismiss the coach overlay (on the ✓ / Escape / a click anywhere). */
export function dismissCoachOverlay(store: CoachStorage | null = defaultStorage()): void {
  if (!store) return;
  try {
    store.setItem(COACH_OVERLAY_KEY, "dismissed");
  } catch {
    // best-effort
  }
}
