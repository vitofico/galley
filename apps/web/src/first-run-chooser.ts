/**
 * One-time first-run chooser (corrections H5) — pure storage logic, twin of
 * `onboarding-nudge.ts`. A brand-new local boot seeds a near-blank `= Untitled`
 * starter and buries the 7 templates + the 1905 demo behind an unlabeled `⊞`
 * glyph, so a Typst novice lands on an empty page with no visible way in. This
 * gates a calm, NON-BLOCKING first-run banner (mirrors the ⌘K nudge — never a
 * modal, so it can't intercept the editor) that surfaces "browse templates" and
 * "open the 1905 demo" once, then is dismissed permanently.
 *
 * Pure + storage-edge: an injectable Storage slice so the Node unit gate passes a
 * Map-backed fake; the browser default degrades to "never show" when storage is
 * unavailable (a one-time cue that can't remember being dismissed must not nag on
 * every load).
 */

/** localStorage key recording that the first-run chooser has been seen/dismissed. */
export const FIRST_RUN_CHOOSER_KEY = "galley.onboarding.firstRunChooser.v1";

/** The slice of `Storage` we use — injectable so tests pass a fake. */
export interface ChooserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Resolve a default storage (real `localStorage` in the browser, else null). */
function defaultStorage(): ChooserStorage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Access can throw (privacy mode) — treat as unavailable.
  }
  return null;
}

/**
 * Whether the first-run chooser should show. True only when storage is AVAILABLE
 * and the dismissed flag is absent — without storage the dismissal couldn't
 * persist, so the cue stays off rather than nagging on every load.
 */
export function shouldShowFirstRunChooser(store: ChooserStorage | null = defaultStorage()): boolean {
  if (!store) return false;
  try {
    return store.getItem(FIRST_RUN_CHOOSER_KEY) === null;
  } catch {
    return false;
  }
}

/** Permanently dismiss the chooser (on first action OR an explicit dismiss). */
export function dismissFirstRunChooser(store: ChooserStorage | null = defaultStorage()): void {
  if (!store) return;
  try {
    store.setItem(FIRST_RUN_CHOOSER_KEY, "dismissed");
  } catch {
    // best-effort
  }
}
