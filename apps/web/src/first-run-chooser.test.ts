import { describe, it, expect } from "vitest";
import {
  shouldShowFirstRunChooser,
  dismissFirstRunChooser,
  FIRST_RUN_CHOOSER_KEY,
} from "./first-run-chooser.js";

function fakeStore(seed?: Record<string, string>) {
  const m = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    getItem: (k: string): string | null => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string): void => void m.set(k, v),
  };
}

describe("first-run chooser (H5 onboarding)", () => {
  it("shows on a fresh profile", () => {
    expect(shouldShowFirstRunChooser(fakeStore())).toBe(true);
  });

  it("dismissal is permanent (any stored flag value counts)", () => {
    const store = fakeStore();
    dismissFirstRunChooser(store);
    expect(shouldShowFirstRunChooser(store)).toBe(false);
    expect(store.getItem(FIRST_RUN_CHOOSER_KEY)).not.toBeNull();
    expect(shouldShowFirstRunChooser(fakeStore({ [FIRST_RUN_CHOOSER_KEY]: "1" }))).toBe(false);
  });

  it("never shows when storage is unavailable (cannot remember a dismissal)", () => {
    expect(shouldShowFirstRunChooser(null)).toBe(false);
    expect(() => dismissFirstRunChooser(null)).not.toThrow();
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
    expect(shouldShowFirstRunChooser(broken)).toBe(false);
    expect(() => dismissFirstRunChooser(broken)).not.toThrow();
  });
});
