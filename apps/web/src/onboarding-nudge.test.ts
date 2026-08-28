import { describe, it, expect } from "vitest";
import {
  shouldShowPaletteNudge,
  dismissPaletteNudge,
  PALETTE_NUDGE_KEY,
} from "./onboarding-nudge.js";

function fakeStore(seed?: Record<string, string>) {
  const m = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    map: m,
    getItem: (k: string): string | null => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string): void => void m.set(k, v),
  };
}

describe("palette nudge (#19.4 onboarding)", () => {
  it("shows on a fresh profile", () => {
    expect(shouldShowPaletteNudge(fakeStore())).toBe(true);
  });

  it("dismissal is permanent (any stored flag value counts)", () => {
    const store = fakeStore();
    dismissPaletteNudge(store);
    expect(shouldShowPaletteNudge(store)).toBe(false);
    expect(store.getItem(PALETTE_NUDGE_KEY)).not.toBeNull();
    // Already-dismissed stores (old/other values) stay dismissed.
    expect(shouldShowPaletteNudge(fakeStore({ [PALETTE_NUDGE_KEY]: "1" }))).toBe(false);
  });

  it("never shows when storage is unavailable (cannot remember a dismissal)", () => {
    expect(shouldShowPaletteNudge(null)).toBe(false);
    expect(() => dismissPaletteNudge(null)).not.toThrow();
  });

  it("a throwing storage degrades to hidden, never an exception", () => {
    const broken = {
      getItem: () => {
        throw new Error("nope");
      },
      setItem: () => {
        throw new Error("nope");
      },
    };
    expect(shouldShowPaletteNudge(broken)).toBe(false);
    expect(() => dismissPaletteNudge(broken)).not.toThrow();
  });
});
