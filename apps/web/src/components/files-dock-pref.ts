/**
 * Persistence for the user's EXPLICIT Files-dock open/closed choice.
 *
 * The Files dock auto-collapses on a first laptop-width run so the preview can
 * render near physical size (see `shouldBootFilesClosed` in dock-state.ts). Once
 * the user toggles the dock — opening OR closing it from the rail — that choice
 * becomes sticky and overrides the auto-collapse on every later boot, at any
 * width. This module stores that single tri-state bit:
 *
 *   `true`  → user explicitly CLOSED Files (stay closed everywhere)
 *   `false` → user explicitly OPENED Files (stay open everywhere)
 *   `null`  → no explicit choice yet (let the width-based default decide)
 *
 * Kept separate from the panes-collapse flag (which can't tell "default open"
 * from "user reopened it") and guarded like the other localStorage seams so a
 * missing/locked store degrades to "no explicit choice".
 */

export const FILES_DOCK_PREF_KEY = "galley.filesDock.explicit";

/** Read the explicit choice, or `null` when none has been recorded. */
export function readFilesDockPref(): boolean | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(FILES_DOCK_PREF_KEY);
    if (raw === "closed") return true;
    if (raw === "open") return false;
    return null;
  } catch {
    return null;
  }
}

/** Record an explicit open/closed choice (`closed === true` means closed). */
export function writeFilesDockPref(closed: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(FILES_DOCK_PREF_KEY, closed ? "closed" : "open");
  } catch {
    /* ignore quota / privacy-mode failures */
  }
}
