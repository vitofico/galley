/**
 * M9 — the one-time transient-storage warning gate (pure storage logic).
 *
 * A private/incognito (or otherwise non-persisted) origin has TRANSIENT storage:
 * the browser may clear IndexedDB on close, so the local-first promise silently
 * doesn't hold. The #23.1 durability nudge deliberately fires only when storage
 * is ALSO near its cap (`storage-durability.ts`), and the strengthened cue is
 * otherwise buried in the opt-in save-status popover — so a FRESH incognito user
 * who never opens it gets no proactive warning. This gate drives a calm, one-time
 * dismissible TOP-LEVEL banner that warns such a user up front (operator-approved
 * — it intentionally escalates the passive cue to a banner for transient origins).
 *
 * Pure + storage-edge like `onboarding-nudge.ts` / `local-profile.ts`: an
 * injectable Storage-slice so the Node unit gate passes a Map-backed fake, and
 * the browser default degrades to "never show" when storage is unavailable (a
 * warning that can't remember being dismissed must not nag on every load).
 */
import type { PersistState } from "./storage-durability.js";

/** localStorage key recording that the transient-storage warning was dismissed. */
export const TRANSIENT_WARNING_KEY = "galley.persistence.transientWarning.v1";

/** The slice of `Storage` we use — injectable so tests pass a fake. */
export interface WarningStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Resolve a default storage (real `localStorage` in the browser, else null). */
function defaultStorage(): WarningStorage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Access can throw (privacy mode) — treat as unavailable.
  }
  return null;
}

/**
 * Whether the transient-storage warning should show. True ONLY when the origin
 * is `transient`, storage is AVAILABLE (so a dismissal can persist), and the
 * dismissed flag is absent. Any other `persistState` (`persisted`/`unsupported`/
 * not-yet-resolved `null`) → false, so a healthy or undetermined env shows
 * nothing (additive). Without storage → false (can't remember a dismissal, so
 * don't nag forever).
 */
export function shouldWarnTransientStorage(
  persistState: PersistState | null,
  store: WarningStorage | null = defaultStorage(),
): boolean {
  if (persistState !== "transient") return false;
  if (!store) return false;
  try {
    return store.getItem(TRANSIENT_WARNING_KEY) === null;
  } catch {
    return false;
  }
}

/** Persist that the user dismissed the warning so it never shows again. */
export function dismissTransientWarning(store: WarningStorage | null = defaultStorage()): void {
  if (!store) return;
  try {
    store.setItem(TRANSIENT_WARNING_KEY, "1");
  } catch {
    // Storage write can throw (quota/privacy) — a failed persist just means the
    // banner may reappear next load; never throw into the dismiss handler.
  }
}
