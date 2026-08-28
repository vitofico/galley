import { describe, it, expect } from "vitest";
import { tablistKeyTarget } from "./tablist-nav.js";

describe("tablistKeyTarget", () => {
  it("moves focus right/left with wraparound (horizontal tablist) — H7", () => {
    expect(tablistKeyTarget("ArrowRight", 0, 4)).toBe(1);
    expect(tablistKeyTarget("ArrowRight", 3, 4)).toBe(0); // wraps to first
    expect(tablistKeyTarget("ArrowLeft", 2, 4)).toBe(1);
    expect(tablistKeyTarget("ArrowLeft", 0, 4)).toBe(3); // wraps to last
  });

  it("jumps to the ends with Home/End", () => {
    expect(tablistKeyTarget("Home", 2, 4)).toBe(0);
    expect(tablistKeyTarget("End", 1, 4)).toBe(3);
  });

  it("returns null for non-navigation keys (lets them through)", () => {
    expect(tablistKeyTarget("Enter", 0, 4)).toBeNull();
    expect(tablistKeyTarget(" ", 0, 4)).toBeNull();
    expect(tablistKeyTarget("Tab", 0, 4)).toBeNull();
    expect(tablistKeyTarget("a", 0, 4)).toBeNull();
  });

  it("is a no-op on an empty/degenerate tablist", () => {
    expect(tablistKeyTarget("ArrowRight", 0, 0)).toBeNull();
    // A single tab wraps to itself (focus stays put, never goes out of range).
    expect(tablistKeyTarget("ArrowRight", 0, 1)).toBe(0);
    expect(tablistKeyTarget("ArrowLeft", 0, 1)).toBe(0);
    expect(tablistKeyTarget("End", 0, 1)).toBe(0);
  });
});
