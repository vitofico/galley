import { describe, it, expect } from "vitest";
import { previewScrollTarget } from "./preview-scroll.js";

/**
 * H2 — forward-sync scroll-visibility predicate. The vertical axis must stop
 * yanking the page when the cursor's region is already on screen, mirroring the
 * horizontal viewport guard.
 */
describe("previewScrollTarget", () => {
  it("returns null when the region's start is already within the viewport (no jack)", () => {
    // region at 100, viewport [0, 500] → visible → don't disturb the reader.
    expect(
      previewScrollTarget({ regionStart: 100, regionLength: 40, viewStart: 0, viewLength: 500 }),
    ).toBeNull();
  });

  it("scrolls (centered) when the region is BELOW the viewport", () => {
    // region at 2000, viewport [0, 500] → off-screen below → center it.
    const target = previewScrollTarget({
      regionStart: 2000,
      regionLength: 40,
      viewStart: 0,
      viewLength: 500,
    });
    expect(target).toBe(2000 - 250 + 20); // regionStart - viewLength/2 + regionLength/2
  });

  it("scrolls (centered) when the region is ABOVE the viewport", () => {
    // region at 10, viewport [600, 1100] → off-screen above → center it.
    const target = previewScrollTarget({
      regionStart: 10,
      regionLength: 40,
      viewStart: 600,
      viewLength: 500,
    });
    expect(target).toBe(Math.max(0, 10 - 250 + 20)); // clamped to 0
    expect(target).toBe(0);
  });

  it("treats the exact viewport edges as visible (inclusive guard)", () => {
    expect(
      previewScrollTarget({ regionStart: 0, regionLength: 10, viewStart: 0, viewLength: 500 }),
    ).toBeNull();
    expect(
      previewScrollTarget({ regionStart: 500, regionLength: 10, viewStart: 0, viewLength: 500 }),
    ).toBeNull();
  });

  it("never returns a negative scroll target", () => {
    const target = previewScrollTarget({
      regionStart: 5,
      regionLength: 2,
      viewStart: 900,
      viewLength: 500,
    });
    expect(target).not.toBeNull();
    expect(target!).toBeGreaterThanOrEqual(0);
  });
});
