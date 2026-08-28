/**
 * Persisted editor preferences (roadmap #11.5).
 *
 * Two user-facing knobs — font size and line wrapping — persisted in
 * `localStorage` and projected into CodeMirror as an extension array.
 *
 * BYTE-FOR-BYTE DEFAULT INVARIANT: the DEFAULTS below reproduce the editor's
 * CURRENT rendering, so a coordinator can wire `editorPrefsExtensions(loadPrefs())`
 * into the editor shells with ZERO visual change when no preference is set.
 *
 *   - `fontSize: 13.5` matches `.cm-editor { font-size: 13.5px }` in styles.css.
 *     The theme below sets the same selector (`&` → `.cm-editor`) to the same
 *     value, so at the default the rendered font size is unchanged.
 *   - `lineWrap: false` matches today's editor, which does NOT add
 *     `EditorView.lineWrapping` (CodeMirror's default is no soft-wrap).
 */
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

export interface EditorPrefs {
  /** Editor font size in CSS pixels. */
  fontSize: number;
  /** Soft-wrap long lines instead of horizontal scroll. */
  lineWrap: boolean;
}

/**
 * Defaults chosen to reproduce the editor's current rendering (see file header).
 * `fontSize` mirrors `.cm-editor { font-size: 13.5px }` in styles.css; `lineWrap`
 * mirrors the current no-wrap behaviour.
 */
export const DEFAULT_PREFS: EditorPrefs = {
  fontSize: 13.5,
  lineWrap: false,
};

/** Sensible bounds so a corrupted/hostile stored value can't break layout. */
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;

/** Stable localStorage key. Namespaced to avoid collisions. */
export const EDITOR_PREFS_KEY = "galley.editor.prefs.v1";

/** True when a usable `localStorage` is present (SSR / sandboxed = false). */
function hasStorage(): boolean {
  try {
    return typeof globalThis !== "undefined" && !!globalThis.localStorage;
  } catch {
    // Accessing localStorage can throw (e.g. blocked by the browser).
    return false;
  }
}

/** Coerce arbitrary parsed JSON into a valid, bounded `EditorPrefs`. */
function normalize(raw: unknown): EditorPrefs {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_PREFS };
  const obj = raw as Record<string, unknown>;

  let fontSize = DEFAULT_PREFS.fontSize;
  if (typeof obj.fontSize === "number" && Number.isFinite(obj.fontSize)) {
    fontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, obj.fontSize));
  }

  const lineWrap =
    typeof obj.lineWrap === "boolean" ? obj.lineWrap : DEFAULT_PREFS.lineWrap;

  return { fontSize, lineWrap };
}

/**
 * Load persisted prefs, falling back to {@link DEFAULT_PREFS} when nothing is
 * stored, storage is unavailable, or the stored value is malformed. Always
 * returns a fresh object (never a shared reference to the defaults).
 */
export function loadPrefs(): EditorPrefs {
  if (!hasStorage()) return { ...DEFAULT_PREFS };
  try {
    const stored = globalThis.localStorage.getItem(EDITOR_PREFS_KEY);
    if (stored == null) return { ...DEFAULT_PREFS };
    return normalize(JSON.parse(stored));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/**
 * Persist prefs. No-op (never throws) when storage is unavailable or write
 * fails (quota, private mode, etc.).
 */
export function savePrefs(prefs: EditorPrefs): void {
  if (!hasStorage()) return;
  try {
    globalThis.localStorage.setItem(EDITOR_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Best-effort: a failed persist must not break the editor.
  }
}

/**
 * Project prefs into CodeMirror extensions.
 *
 * Returns `[ lineWrap ? lineWrapping : [], theme(fontSize) ]`. At the defaults
 * this reproduces current rendering: no wrapping, and a font-size theme equal to
 * the stylesheet's 13.5px (so wiring it changes nothing visible).
 *
 * SELECTOR NOTE (#19.7 fix): the theme scopes the rule as `&.cm-editor` —
 * CodeMirror mounts its style modules BEFORE the document's stylesheets
 * (style-mod inserts at `head.firstChild`, deliberately, so page CSS can
 * override the library), and a bare `&` compiles to a single generated class
 * with the SAME (0,1,0) specificity as styles.css's `.cm-editor { font-size:
 * 13.5px }` — which therefore always won, silently masking the preference.
 * `&.cm-editor` compiles to `.ɵx.cm-editor` (0,2,0), so a chosen size actually
 * renders; at the 13.5px default both rules agree, byte-for-byte as before.
 */
export function editorPrefsExtensions(prefs: EditorPrefs): Extension {
  return [
    prefs.lineWrap ? EditorView.lineWrapping : [],
    EditorView.theme({
      "&.cm-editor": { fontSize: prefs.fontSize + "px" },
    }),
  ];
}
