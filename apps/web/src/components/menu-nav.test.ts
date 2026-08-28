import { describe, it, expect } from "vitest";
import { firstEnabledIndex, lastEnabledIndex, moveEnabledIndex } from "./menu-nav.js";

const on = { disabled: false };
const off = { disabled: true };

describe("menu-nav (pure keyboard helpers for the Export menu)", () => {
  it("firstEnabledIndex / lastEnabledIndex skip disabled items", () => {
    expect(firstEnabledIndex([off, on, on])).toBe(1);
    expect(lastEnabledIndex([on, on, off])).toBe(1);
    expect(firstEnabledIndex([])).toBe(-1);
    expect(lastEnabledIndex([off, off])).toBe(-1);
  });

  it("ArrowDown wraps and skips disabled items", () => {
    const items = [on, off, on];
    expect(moveEnabledIndex(items, 0, 1)).toBe(2); // skips the disabled middle
    expect(moveEnabledIndex(items, 2, 1)).toBe(0); // wraps
  });

  it("ArrowUp wraps and skips disabled items", () => {
    const items = [on, off, on];
    expect(moveEnabledIndex(items, 0, -1)).toBe(2); // wraps backwards
    expect(moveEnabledIndex(items, 2, -1)).toBe(0); // skips the disabled middle
  });

  it("an out-of-range index enters at the start (down) or end (up)", () => {
    const items = [on, on, on];
    expect(moveEnabledIndex(items, -1, 1)).toBe(0);
    expect(moveEnabledIndex(items, -1, -1)).toBe(2);
  });

  it("all-disabled or empty lists yield -1 (nothing to focus)", () => {
    expect(moveEnabledIndex([], 0, 1)).toBe(-1);
    expect(moveEnabledIndex([off, off], 0, 1)).toBe(-1);
  });
});
