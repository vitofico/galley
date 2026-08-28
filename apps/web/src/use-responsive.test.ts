import { describe, it, expect } from "vitest";
import { DEFAULT_BREAKPOINT, isNarrow } from "./use-responsive.js";

/**
 * #11.9 — responsive/tabbed layout. apps/web vitest runs under Node (no jsdom),
 * so only the PURE width→narrow helper is exercised here. The hook and the
 * <TabBar> component are kept thin over this helper and verified by the
 * typecheck step of the Docker gate.
 */

describe("DEFAULT_BREAKPOINT", () => {
  it("is 820px — the width below which the multi-column grid collapses to tabs", () => {
    expect(DEFAULT_BREAKPOINT).toBe(820);
  });
});

describe("isNarrow", () => {
  it("is true strictly below the breakpoint", () => {
    expect(isNarrow(819)).toBe(true);
    expect(isNarrow(0)).toBe(true);
    expect(isNarrow(640)).toBe(true);
  });

  it("is false at the breakpoint (boundary is inclusive of wide)", () => {
    expect(isNarrow(820)).toBe(false);
  });

  it("is false above the breakpoint", () => {
    expect(isNarrow(821)).toBe(false);
    expect(isNarrow(1440)).toBe(false);
  });

  it("honours a custom breakpoint", () => {
    expect(isNarrow(500, 600)).toBe(true);
    expect(isNarrow(600, 600)).toBe(false);
    expect(isNarrow(700, 600)).toBe(false);
  });

  it("treats non-finite/negative widths as not narrow (defensive)", () => {
    expect(isNarrow(Number.NaN)).toBe(false);
    expect(isNarrow(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isNarrow(-1)).toBe(true);
  });
});
