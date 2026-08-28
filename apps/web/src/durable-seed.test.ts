import { describe, it, expect } from "vitest";
import {
  setDurableSeed,
  takeDurableSeed,
  shouldSeedEinsteinDemo,
  markEinsteinDemoSeeded,
  EINSTEIN_SEEDED_KEY,
} from "./durable-seed.js";

function fakeStore(seed?: Record<string, string>) {
  const m = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    map: m,
    getItem: (k: string): string | null => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string): void => void m.set(k, v),
    removeItem: (k: string): void => void m.delete(k),
  };
}

describe("durable seed (consume-once)", () => {
  it("round-trips a stashed seed", () => {
    const store = fakeStore();
    setDurableSeed("proj-1", { kind: "einstein", name: "Annus Mirabilis — 1905" }, store);
    expect(takeDurableSeed("proj-1", store)).toEqual({
      kind: "einstein",
      name: "Annus Mirabilis — 1905",
    });
  });

  it("is consume-once: a second take returns null", () => {
    const store = fakeStore();
    setDurableSeed("proj-1", { kind: "blank", name: "Draft" }, store);
    expect(takeDurableSeed("proj-1", store)).not.toBeNull();
    expect(takeDurableSeed("proj-1", store)).toBeNull();
  });

  it("returns null for an unknown project", () => {
    expect(takeDurableSeed("missing", fakeStore())).toBeNull();
  });

  it("drops a malformed record without throwing (and consumes it)", () => {
    const store = fakeStore({ "galley.seed.proj-1": "{not json" });
    expect(takeDurableSeed("proj-1", store)).toBeNull();
    expect(store.getItem("galley.seed.proj-1")).toBeNull();
  });

  it("rejects a record with an unknown kind", () => {
    const store = fakeStore({
      "galley.seed.proj-1": JSON.stringify({ kind: "bogus", name: "x" }),
    });
    expect(takeDurableSeed("proj-1", store)).toBeNull();
  });

  it("degrades to null without storage", () => {
    expect(takeDurableSeed("proj-1", null)).toBeNull();
    expect(() => setDurableSeed("proj-1", { kind: "blank", name: "x" }, null)).not.toThrow();
  });
});

describe("Einstein seed-once flag", () => {
  it("seeds on a fresh profile, then never again", () => {
    const store = fakeStore();
    expect(shouldSeedEinsteinDemo(store)).toBe(true);
    markEinsteinDemoSeeded(store);
    expect(shouldSeedEinsteinDemo(store)).toBe(false);
    expect(store.getItem(EINSTEIN_SEEDED_KEY)).not.toBeNull();
  });

  it("stays seeded even if the demo project is later deleted (flag persists)", () => {
    const store = fakeStore({ [EINSTEIN_SEEDED_KEY]: "1" });
    expect(shouldSeedEinsteinDemo(store)).toBe(false);
  });

  it("never seeds when storage is unavailable (cannot remember it)", () => {
    expect(shouldSeedEinsteinDemo(null)).toBe(false);
    expect(() => markEinsteinDemoSeeded(null)).not.toThrow();
  });
});
