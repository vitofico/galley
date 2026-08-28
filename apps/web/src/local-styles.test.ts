import { describe, it, expect } from "vitest";
import { CANONICAL_TOKENS, negotiate } from "./style-manifest.js";
import { detectStyleability } from "./style-manifest.js";
import {
  loadLocalStyles,
  saveLocalStyle,
  deleteLocalStyle,
  deriveCapabilities,
  toStyle,
  LOCAL_STYLES_KEY,
  type LocalStyleEntry,
} from "./local-styles.js";

/** A tiny Map-backed Storage-like fake (the two methods we use), like the profile test. */
function fakeStore(seed?: Record<string, string>) {
  const m = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    map: m,
    getItem: (k: string): string | null => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string): void => void m.set(k, v),
  };
}

// A vanilla, appearance-only style (mirrors the academic built-in): exports the
// entry `doc` + the four palette tokens and nothing else → provides no helpers.
const VANILLA = [
  '#let accent = rgb("#000000")',
  '#let ink = rgb("#211c17")',
  '#let ink-soft = rgb("#6a6155")',
  '#let rule = rgb("#d8cdb8")',
  "#let doc(title: none, body, ..extra) = { body }",
].join("\n");

// A helper-providing style: same ABI plus two semantic helpers (`problem`,
// `solution`) a pset-style document would import from /style.typ.
const HELPERY = [
  VANILLA,
  "#let problem(body) = block(body)",
  "#let solution(body) = block(body)",
].join("\n");

describe("deriveCapabilities", () => {
  it("returns [] for a vanilla appearance-only style (entry + tokens only)", () => {
    expect(deriveCapabilities(VANILLA)).toEqual([]);
  });

  it("excludes the entry `doc` and the four palette tokens", () => {
    // Every excluded name appears as a top-level #let in VANILLA, yet none leak.
    const caps = deriveCapabilities(VANILLA);
    for (const name of ["doc", ...CANONICAL_TOKENS]) {
      expect(caps).not.toContain(name);
    }
  });

  it("returns the leftover top-level exports as helpers (sorted, deduped)", () => {
    expect(deriveCapabilities(HELPERY)).toEqual(["problem", "solution"]);
  });

  it("only counts line-anchored top-level #let (ignores nested lets)", () => {
    const src = ["#let doc(body) = {", "  let inner = 1", "  body", "}"].join("\n");
    expect(deriveCapabilities(src)).toEqual([]);
  });

  it("handles hyphenated helper names", () => {
    expect(deriveCapabilities(`${VANILLA}\n#let fig-wide(body) = body`)).toEqual(["fig-wide"]);
  });
});

describe("saveLocalStyle / loadLocalStyles round-trip", () => {
  it("mints a local- id, derives capabilities, and persists under the documented key", () => {
    const store = fakeStore();
    const entry = saveLocalStyle(store, { name: "My Journal", text: HELPERY });
    expect(entry.id.startsWith("local-")).toBe(true);
    expect(entry.name).toBe("My Journal");
    expect(entry.text).toBe(HELPERY);
    expect(entry.capabilities).toEqual(["problem", "solution"]);
    expect(store.getItem(LOCAL_STYLES_KEY)).not.toBeNull();

    const loaded = loadLocalStyles(store);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(entry);
  });

  it("trims the given name", () => {
    const store = fakeStore();
    const entry = saveLocalStyle(store, { name: "  Spaced  ", text: VANILLA });
    expect(entry.name).toBe("Spaced");
  });

  it("appends newest-last and mints distinct ids", () => {
    const store = fakeStore();
    const a = saveLocalStyle(store, { name: "A", text: VANILLA });
    const b = saveLocalStyle(store, { name: "B", text: VANILLA });
    expect(a.id).not.toBe(b.id);
    const loaded = loadLocalStyles(store);
    expect(loaded.map((e) => e.name)).toEqual(["A", "B"]);
  });

  it("persists across a fresh load (reload simulation)", () => {
    const store = fakeStore();
    const saved = saveLocalStyle(store, { name: "Keep", text: HELPERY });
    // A brand-new module read from the same backing store still sees it.
    const reloaded = loadLocalStyles(fakeStore(Object.fromEntries(store.map)));
    expect(reloaded).toEqual([saved]);
  });

  it("returns [] for an absent or corrupt store", () => {
    expect(loadLocalStyles(fakeStore())).toEqual([]);
    expect(loadLocalStyles(fakeStore({ [LOCAL_STYLES_KEY]: "{not json" }))).toEqual([]);
    expect(loadLocalStyles(fakeStore({ [LOCAL_STYLES_KEY]: '{"not":"an array"}' }))).toEqual([]);
  });

  it("drops malformed entries on load", () => {
    const good: LocalStyleEntry = { id: "local-x", name: "Good", text: VANILLA, capabilities: [] };
    const store = fakeStore({
      [LOCAL_STYLES_KEY]: JSON.stringify([good, { id: "", name: "bad" }, 42, null]),
    });
    expect(loadLocalStyles(store)).toEqual([good]);
  });
});

describe("deleteLocalStyle", () => {
  it("removes the entry by id and persists the remainder", () => {
    const store = fakeStore();
    const a = saveLocalStyle(store, { name: "A", text: VANILLA });
    const b = saveLocalStyle(store, { name: "B", text: VANILLA });
    const remaining = deleteLocalStyle(store, a.id);
    expect(remaining.map((e) => e.id)).toEqual([b.id]);
    expect(loadLocalStyles(store).map((e) => e.id)).toEqual([b.id]);
  });

  it("is a no-op for an unknown id", () => {
    const store = fakeStore();
    const a = saveLocalStyle(store, { name: "A", text: VANILLA });
    expect(deleteLocalStyle(store, "local-nope").map((e) => e.id)).toEqual([a.id]);
  });
});

describe("toStyle (materialise a saved entry into a Style)", () => {
  it("builds a non-builtin canonical-ABI Style carrying the captured source", () => {
    const entry = saveLocalStyle(fakeStore(), { name: "Mine", text: HELPERY });
    const style = toStyle(entry);
    expect(style.manifest.builtin).toBe(false);
    expect(style.manifest.id).toBe(entry.id);
    expect(style.manifest.name).toBe("Mine");
    expect(style.manifest.entry).toBe("doc");
    expect(style.manifest.tokens).toEqual(["accent", "ink", "ink-soft", "rule"]);
    expect(style.manifest.capabilities).toEqual(["problem", "solution"]);
    expect(style.entryFile).toBe("/style.typ");
    expect(style.files).toEqual([{ path: "/style.typ", text: HELPERY }]);
  });

  it("negotiates correctly: a helper-doc accepts a captured style that provides them", () => {
    // Capture a helper-providing style, then ask a pset-style doc to swap to it.
    const entry = saveLocalStyle(fakeStore(), { name: "Journal", text: HELPERY });
    const style = toStyle(entry);
    const s = detectStyleability(
      '#import "/style.typ": doc, problem, solution\n#show: doc.with()',
    );
    expect(s.requiredCapabilities).toEqual(["problem", "solution"]);
    expect(negotiate(s.requiredCapabilities, style.manifest.capabilities).ok).toBe(true);
  });

  it("a vanilla captured style refuses a doc needing helpers it doesn't provide", () => {
    const entry = saveLocalStyle(fakeStore(), { name: "Plain", text: VANILLA });
    const style = toStyle(entry);
    const s = detectStyleability('#import "/style.typ": doc, theorem\n#show: doc.with()');
    const n = negotiate(s.requiredCapabilities, style.manifest.capabilities);
    expect(n).toEqual({ ok: false, missing: ["theorem"] });
  });
});
