import { describe, it, expect } from "vitest";
import { splitKeyStepPx, splitterAria, SPLIT_STEP_PX } from "./split-keyboard.js";

describe("splitKeyStepPx (L9)", () => {
  it("maps Left/Right to a signed pixel nudge", () => {
    expect(splitKeyStepPx("ArrowLeft")).toBe(-SPLIT_STEP_PX);
    expect(splitKeyStepPx("ArrowRight")).toBe(SPLIT_STEP_PX);
  });

  it("honors a custom step", () => {
    expect(splitKeyStepPx("ArrowLeft", 10)).toBe(-10);
    expect(splitKeyStepPx("ArrowRight", 10)).toBe(10);
  });

  it("returns 0 for keys it doesn't handle (so the handler no-ops, no preventDefault)", () => {
    for (const k of ["ArrowUp", "ArrowDown", "Enter", " ", "a", "Tab"]) {
      expect(splitKeyStepPx(k)).toBe(0);
    }
  });
});

describe("splitterAria (L9)", () => {
  it("reports the left pane's share as valuenow, with min/max from the min-fr clamp", () => {
    // left=1, right=1, minFr=0.18 → now 50%, min 9%, max 91%.
    expect(splitterAria(1, 1, 0.18)).toEqual({ now: 50, min: 9, max: 91 });
  });

  it("tracks an uneven split", () => {
    // left=0.62, right=1.5 (the rail editor|center default) → ~29% left.
    const a = splitterAria(0.62, 1.5, 0.18);
    expect(a.now).toBe(29);
    expect(a.min).toBeLessThan(a.now);
    expect(a.max).toBeGreaterThan(a.now);
  });

  it("is safe for a degenerate joint", () => {
    expect(splitterAria(0, 0, 0.18)).toEqual({ now: 50, min: 0, max: 100 });
  });
});
