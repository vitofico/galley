import { describe, it, expect } from "vitest";
import { staleRenderNotice } from "./preview-stale-notice.js";

describe("staleRenderNotice (L4)", () => {
  it("announces the stale render + error count when a page is shown under errors", () => {
    expect(staleRenderNotice({ hasRender: true, errorCount: 3 })).toBe(
      "Showing last good render · 3 errors",
    );
  });

  it("uses the singular for exactly one error", () => {
    expect(staleRenderNotice({ hasRender: true, errorCount: 1 })).toBe(
      "Showing last good render · 1 error",
    );
  });

  it("returns null when the latest compile is clean (no errors), so a fresh render shows nothing", () => {
    expect(staleRenderNotice({ hasRender: true, errorCount: 0 })).toBeNull();
  });

  it("returns null when there is no rendered page to be stale (empty preview)", () => {
    // errorCount>0 but nothing on screen → the empty-state placeholder owns the
    // messaging ("Couldn't compile — N errors"), not this edge banner.
    expect(staleRenderNotice({ hasRender: false, errorCount: 2 })).toBeNull();
  });

  it("returns null when there is neither a render nor errors", () => {
    expect(staleRenderNotice({ hasRender: false, errorCount: 0 })).toBeNull();
  });
});
