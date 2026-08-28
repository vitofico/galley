import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  type EditorPrefs,
  DEFAULT_PREFS,
  EDITOR_PREFS_KEY,
  loadPrefs,
  savePrefs,
  editorPrefsExtensions,
} from "./editor-prefs.js";

/**
 * Unit tests for persisted editor prefs.
 *
 * `loadPrefs`/`savePrefs` are exercised against a tiny in-memory localStorage
 * shim installed per-test, plus a "no window" case (storage absent) to prove SSR
 * safety. `editorPrefsExtensions` is checked for shape only — actual CM rendering
 * is e2e (coordinator-owned).
 */

// --- minimal localStorage shim -------------------------------------------------
function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

const g = globalThis as { localStorage?: Storage };
let savedStorage: Storage | undefined;

beforeEach(() => {
  savedStorage = g.localStorage;
  g.localStorage = makeStorage();
});

afterEach(() => {
  if (savedStorage === undefined) delete g.localStorage;
  else g.localStorage = savedStorage;
});

describe("DEFAULT_PREFS", () => {
  it("matches the current editor rendering (13.5px, no wrap)", () => {
    // BYTE-FOR-BYTE INVARIANT: these must reproduce styles.css today.
    expect(DEFAULT_PREFS).toEqual({ fontSize: 13.5, lineWrap: false });
  });
});

describe("loadPrefs", () => {
  it("returns defaults when nothing is stored", () => {
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it("returns a fresh object, not a shared reference to DEFAULT_PREFS", () => {
    const a = loadPrefs();
    expect(a).not.toBe(DEFAULT_PREFS);
    a.fontSize = 99;
    expect(DEFAULT_PREFS.fontSize).toBe(13.5);
  });

  it("returns defaults when stored value is malformed JSON", () => {
    g.localStorage!.setItem(EDITOR_PREFS_KEY, "{not json");
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it("fills missing fields from defaults", () => {
    g.localStorage!.setItem(EDITOR_PREFS_KEY, JSON.stringify({ fontSize: 18 }));
    expect(loadPrefs()).toEqual({ fontSize: 18, lineWrap: false });
  });

  it("ignores wrong-typed fields", () => {
    g.localStorage!.setItem(
      EDITOR_PREFS_KEY,
      JSON.stringify({ fontSize: "big", lineWrap: "yes" }),
    );
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it("clamps an out-of-range font size", () => {
    g.localStorage!.setItem(EDITOR_PREFS_KEY, JSON.stringify({ fontSize: 999 }));
    expect(loadPrefs().fontSize).toBe(32);
    g.localStorage!.setItem(EDITOR_PREFS_KEY, JSON.stringify({ fontSize: 1 }));
    expect(loadPrefs().fontSize).toBe(8);
  });
});

describe("savePrefs / round-trip", () => {
  it("round-trips a full prefs object", () => {
    const p: EditorPrefs = { fontSize: 16, lineWrap: true };
    savePrefs(p);
    expect(loadPrefs()).toEqual(p);
  });

  it("persists under the stable key", () => {
    savePrefs({ fontSize: 20, lineWrap: false });
    expect(g.localStorage!.getItem(EDITOR_PREFS_KEY)).not.toBeNull();
  });
});

describe("no-window / SSR safety", () => {
  it("loadPrefs returns defaults with no localStorage", () => {
    delete g.localStorage;
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it("savePrefs is a no-op (does not throw) with no localStorage", () => {
    delete g.localStorage;
    expect(() => savePrefs({ fontSize: 16, lineWrap: true })).not.toThrow();
  });
});

describe("editorPrefsExtensions", () => {
  it("returns an array (Extension) for default prefs", () => {
    const ext = editorPrefsExtensions(DEFAULT_PREFS);
    expect(Array.isArray(ext)).toBe(true);
    expect((ext as unknown[]).length).toBe(2);
  });

  it("omits line wrapping when lineWrap is false (empty slot)", () => {
    const ext = editorPrefsExtensions({ fontSize: 13.5, lineWrap: false });
    const arr = ext as unknown[];
    // First slot is the wrap slot: [] when off.
    expect(Array.isArray(arr[0])).toBe(true);
    expect((arr[0] as unknown[]).length).toBe(0);
  });

  it("includes a wrapping extension when lineWrap is true", () => {
    const ext = editorPrefsExtensions({ fontSize: 13.5, lineWrap: true });
    const arr = ext as unknown[];
    // First slot is now a non-empty extension (not the empty-array slot).
    expect(arr[0]).toBeTruthy();
    expect(Array.isArray(arr[0])).toBe(false);
  });

  it("constructs without throwing for various font sizes", () => {
    expect(() => editorPrefsExtensions({ fontSize: 8, lineWrap: false })).not.toThrow();
    expect(() => editorPrefsExtensions({ fontSize: 24, lineWrap: true })).not.toThrow();
  });
});
