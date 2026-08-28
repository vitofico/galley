/**
 * React hook over {@link EditorPrefs}: a `[prefs, setPrefs]` pair that is
 * persisted to `localStorage` on every change. Initialised from {@link loadPrefs}
 * so a returning user gets their saved prefs, and a first-time user gets the
 * defaults (which reproduce current rendering).
 */
import { useCallback, useState } from "react";
import {
  type EditorPrefs,
  loadPrefs,
  savePrefs,
} from "./editor-prefs.js";

/**
 * Returns `[prefs, setPrefs]`. `setPrefs` accepts a partial patch (merged over
 * the current prefs) or a full updater function, and persists the result.
 */
export function useEditorPrefs(): [
  EditorPrefs,
  (patch: Partial<EditorPrefs> | ((prev: EditorPrefs) => EditorPrefs)) => void,
] {
  // Lazy initialiser: read storage once on mount.
  const [prefs, setPrefsState] = useState<EditorPrefs>(() => loadPrefs());

  const setPrefs = useCallback(
    (patch: Partial<EditorPrefs> | ((prev: EditorPrefs) => EditorPrefs)) => {
      setPrefsState((prev) => {
        const next =
          typeof patch === "function" ? patch(prev) : { ...prev, ...patch };
        savePrefs(next);
        return next;
      });
    },
    [],
  );

  return [prefs, setPrefs];
}
