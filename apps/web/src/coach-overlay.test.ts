import { describe, it, expect } from "vitest";
import {
  shouldShowCoachOverlay,
  dismissCoachOverlay,
  COACH_OVERLAY_KEY,
} from "./coach-overlay.js";

function fakeStore(seed?: Record<string, string>) {
  const m = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    getItem: (k: string): string | null => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string): void => void m.set(k, v),
  };
}

describe("coach overlay (onboarding M3)", () => {
  it("shows once on a fresh profile", () => {
    expect(shouldShowCoachOverlay(fakeStore())).toBe(true);
  });

  it("dismissal is permanent (any stored flag value counts)", () => {
    const store = fakeStore();
    dismissCoachOverlay(store);
    expect(shouldShowCoachOverlay(store)).toBe(false);
    expect(store.getItem(COACH_OVERLAY_KEY)).not.toBeNull();
    // A returning profile (flag pre-seeded to any value) never sees it again.
    expect(shouldShowCoachOverlay(fakeStore({ [COACH_OVERLAY_KEY]: "1" }))).toBe(false);
  });

  it("uses its OWN key, independent of the H5 first-run chooser", () => {
    // Dismissing the chooser must not suppress the coach, and vice versa — the
    // two cues are separately dismissible.
    expect(COACH_OVERLAY_KEY).toBe("galley.onboarding.coachOverlay.v1");
    const store = fakeStore({ "galley.onboarding.firstRunChooser.v1": "dismissed" });
    expect(shouldShowCoachOverlay(store)).toBe(true);
  });

  it("never shows when storage is unavailable (cannot remember a dismissal)", () => {
    expect(shouldShowCoachOverlay(null)).toBe(false);
    expect(() => dismissCoachOverlay(null)).not.toThrow();
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
    expect(shouldShowCoachOverlay(broken)).toBe(false);
    expect(() => dismissCoachOverlay(broken)).not.toThrow();
  });
});
