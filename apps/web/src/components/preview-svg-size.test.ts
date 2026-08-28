import { describe, it, expect } from "vitest";
import { scaleSvgToPhysicalPx } from "./preview-svg-size.js";

const ROOT =
  '<svg style="overflow: visible;" class="typst-doc" viewBox="0 0 420.000 596.000" width="420.000" height="596.000" data-width="420.000" data-height="596.000" xmlns="http://www.w3.org/2000/svg">';

describe("scaleSvgToPhysicalPx", () => {
  it("rewrites the root width/height from points to physical CSS px (× 96/72)", () => {
    const out = scaleSvgToPhysicalPx(`${ROOT}<g/></svg>`);
    // 420 pt → 560 px, 596 pt → 794.667 px.
    expect(out).toContain('width="560px"');
    expect(out).toContain('height="794.667px"');
  });

  it("leaves the point viewBox and data-* attributes untouched", () => {
    const out = scaleSvgToPhysicalPx(`${ROOT}<g/></svg>`);
    expect(out).toContain('viewBox="0 0 420.000 596.000"');
    // data-width/data-height keep their point values (matched attrs need a
    // leading space; `-width` does not).
    expect(out).toContain('data-width="420.000"');
    expect(out).toContain('data-height="596.000"');
  });

  it("does not touch inner content or other elements", () => {
    const inner = '<foreignObject x="0" y="0" width="100" height="20"><div>Hi</div></foreignObject>';
    const out = scaleSvgToPhysicalPx(`${ROOT}${inner}</svg>`);
    expect(out).toContain(inner);
  });

  it("is a no-op when the root has no unitless width/height", () => {
    const noDims = '<svg class="typst-doc" viewBox="0 0 420 596"><g/></svg>';
    expect(scaleSvgToPhysicalPx(noDims)).toBe(noDims);
  });

  it("is a no-op for input without an <svg> root", () => {
    expect(scaleSvgToPhysicalPx("<div>not svg</div>")).toBe("<div>not svg</div>");
  });

  it("leaves an already-px-sized root unchanged", () => {
    const px = '<svg viewBox="0 0 420 596" width="560px" height="794px"><g/></svg>';
    expect(scaleSvgToPhysicalPx(px)).toBe(px);
  });
});
