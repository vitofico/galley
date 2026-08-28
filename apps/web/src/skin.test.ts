import { describe, it, expect } from "vitest";
import { applySkin, resolveInitialSkin, setSkin, SKIN_STORAGE_KEY } from "./skin.js";

function fakeRoot() {
  const attrs = new Map<string, string>();
  return {
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
    get: (k: string) => attrs.get(k) ?? null,
  };
}
function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe("resolveInitialSkin", () => {
  it("defaults to studio when nothing is stored", () => {
    expect(resolveInitialSkin({ stored: null })).toBe("studio");
  });
  it("honors a valid stored skin", () => {
    expect(resolveInitialSkin({ stored: "press" })).toBe("press");
  });
  it("falls back to studio on a garbage stored value", () => {
    expect(resolveInitialSkin({ stored: "neon" })).toBe("studio");
  });
});

describe("applySkin", () => {
  it("studio removes the attribute (absence = default)", () => {
    const root = fakeRoot();
    root.setAttribute("data-skin", "press");
    applySkin("studio", root as unknown as HTMLElement);
    expect(root.get("data-skin")).toBeNull();
  });
  it("press sets data-skin", () => {
    const root = fakeRoot();
    applySkin("press", root as unknown as HTMLElement);
    expect(root.get("data-skin")).toBe("press");
  });
});

describe("setSkin", () => {
  it("applies and persists", () => {
    const root = fakeRoot();
    const storage = fakeStorage();
    setSkin("press", { root: root as unknown as HTMLElement, storage });
    expect(root.get("data-skin")).toBe("press");
    expect(storage.getItem(SKIN_STORAGE_KEY)).toBe("press");
  });
  it("never throws when storage rejects", () => {
    const root = fakeRoot();
    const storage = { getItem: () => null, setItem: () => { throw new Error("nope"); }, removeItem: () => {} };
    expect(() => setSkin("press", { root: root as unknown as HTMLElement, storage })).not.toThrow();
  });
});
