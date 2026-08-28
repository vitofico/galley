/**
 * Focus / Zen mode persistence (#18.5).
 *
 * A cheap, self-contained boolean: when ON, the shell hides its distraction
 * panels (the agent panel — and in the project shell, the file pane) for a
 * focused editor+preview view. Default OFF → the layout is byte-for-byte the
 * current one (the shell omits the `data-focus` attribute entirely).
 *
 * Importing this module has ZERO side effects (mirrors theme.ts): storage is
 * only touched on an explicit call, so the default stays untouched until the
 * topbar toggle wires it in.
 */

/** localStorage key the focus-mode flag is persisted under. */
export const FOCUS_MODE_KEY = "galley.focusMode";

/** The minimal storage surface this module needs (a subset of `Storage`). */
export interface FocusStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): FocusStorage | null {
  const s = (globalThis as { localStorage?: FocusStorage }).localStorage;
  return s ?? null;
}

/**
 * Read the persisted focus-mode flag. Returns `false` (the byte-for-byte
 * default) when unset, invalid, or storage is unavailable.
 */
export function loadFocusMode(storage?: FocusStorage | null): boolean {
  const s = storage === undefined ? defaultStorage() : storage;
  if (!s) return false;
  try {
    return s.getItem(FOCUS_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist the focus-mode flag. Best-effort — storage failures are swallowed. */
export function saveFocusMode(on: boolean, storage?: FocusStorage | null): void {
  const s = storage === undefined ? defaultStorage() : storage;
  if (!s) return;
  try {
    s.setItem(FOCUS_MODE_KEY, on ? "1" : "0");
  } catch {
    /* persistence is best-effort */
  }
}
