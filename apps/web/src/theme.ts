/**
 * Theme controller for the dark "press" mode (#11.6).
 *
 * Design constraints (Architect ruling):
 *  - Importing this module has ZERO side effects: it touches no DOM and never
 *    reads `prefers-color-scheme` at module-evaluation time. The DOM is only
 *    mutated when a caller explicitly invokes `applyTheme` / `setTheme` /
 *    `toggleTheme`. This keeps a dark-OS user on the unchanged light default
 *    until the (coordinator-mounted) toggle wires the feature in.
 *  - Light is the *absence* of a `data-theme` attribute, so the byte-for-byte
 *    light theme in styles.css is the default. Dark sets `data-theme="dark"`,
 *    which the override block in theme.css keys off of.
 *
 * The functions are framework-light and unit-testable: the DOM root and storage
 * are injectable, so they can be exercised under the Node test environment with
 * plain doubles.
 */

export type ThemeMode = "light" | "dark";

/** localStorage key the chosen mode is persisted under. */
export const STORAGE_KEY = "galley.theme";

/** The minimal storage surface this module needs (a subset of `Storage`). */
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The minimal element surface `applyTheme` needs (a subset of `HTMLElement`). */
interface ThemeRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

const DATA_ATTR = "data-theme";

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark";
}

/**
 * Resolve the mode to start in. PURE — performs no DOM/storage access; the
 * caller supplies the already-read stored value and OS preference.
 *
 * Order: a valid stored value wins; otherwise fall back to the OS preference
 * (`prefersDark ? "dark" : "light"`).
 */
export function resolveInitialTheme(opts: {
  stored: string | null;
  prefersDark: boolean;
}): ThemeMode {
  if (isThemeMode(opts.stored)) return opts.stored;
  return opts.prefersDark ? "dark" : "light";
}

/**
 * Lazily resolve the default document root. Guarded so the module never assumes
 * a DOM exists; callers in a DOM-less context must pass an explicit root.
 */
function defaultRoot(): ThemeRoot {
  const doc = (globalThis as { document?: { documentElement?: ThemeRoot } }).document;
  if (!doc || !doc.documentElement) {
    throw new Error("applyTheme: no document available; pass an explicit root");
  }
  return doc.documentElement;
}

/**
 * Reflect `mode` onto `root` (default `document.documentElement`):
 *  - "dark"  → setAttribute("data-theme", "dark")
 *  - "light" → removeAttribute("data-theme")  (absence-of-attribute default)
 */
export function applyTheme(mode: ThemeMode, root?: HTMLElement): void {
  const target: ThemeRoot = root ?? defaultRoot();
  if (mode === "dark") {
    target.setAttribute(DATA_ATTR, "dark");
  } else {
    target.removeAttribute(DATA_ATTR);
  }
}

/** Options for the persisting controllers. Both default to the ambient DOM. */
export interface SetThemeOptions {
  root?: HTMLElement;
  storage?: ThemeStorage;
}

function defaultStorage(): ThemeStorage | null {
  const s = (globalThis as { localStorage?: ThemeStorage }).localStorage;
  return s ?? null;
}

/**
 * Apply `mode` and persist it under `STORAGE_KEY`. Storage failures are
 * swallowed (private-mode / disabled storage) so theming never throws on the
 * UI path; the visual change still applies.
 */
export function setTheme(mode: ThemeMode, opts: SetThemeOptions = {}): void {
  applyTheme(mode, opts.root);
  const storage = opts.storage ?? defaultStorage();
  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, mode);
    } catch {
      /* persistence is best-effort */
    }
  }
}

/**
 * Flip `current` to the opposite mode, apply + persist it, and return the new
 * mode (so a caller holding React state can update without re-reading the DOM).
 */
export function toggleTheme(current: ThemeMode, opts: SetThemeOptions = {}): ThemeMode {
  const next: ThemeMode = current === "dark" ? "light" : "dark";
  setTheme(next, opts);
  return next;
}
