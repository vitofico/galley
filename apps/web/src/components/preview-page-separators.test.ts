import { describe, it, expect } from "vitest";
import { insertPageSeparators } from "./preview-page-separators.js";

// Minimal multi-page SVG matching typst.ts 0.7's structure: flush-stacked
// `typst-page` groups under one root viewBox, with a shared glyph `<defs>`.
const page = (y: number) =>
  `<g class="typst-page" transform="translate(0, ${y})" data-page-width="420" data-page-height="596"><g class="typst-text"><foreignObject>x</foreignObject></g></g>`;
const threePage = `<svg class="typst-doc" viewBox="0 0 420 1788" width="560px" height="2384px"><defs class="glyph"></defs>${page(0)}${page(596)}${page(1192)}</svg>`;

describe("insertPageSeparators", () => {
  it("injects one seam per INTERNAL boundary (n pages → n-1 seams)", () => {
    const out = insertPageSeparators(threePage);
    const seams = out.match(/--preview-gutter/g) ?? [];
    expect(seams).toHaveLength(2); // 3 pages → 2 seams
  });

  it("places each seam band at the page boundary (in viewBox point units)", () => {
    const out = insertPageSeparators(threePage);
    // Gutter rects are centred on y=596 and y=1192 (the page tops after the first).
    expect(out).toContain('y="585"'); // 596 - GUTTER_HALF_PT(11)
    expect(out).toContain('y="1181"'); // 1192 - 11
    // Full document width.
    expect(out).toContain('width="420"');
    // Injected before the closing tag (so it paints atop the flush page fills).
    expect(out.indexOf("--preview-gutter")).toBeLessThan(out.lastIndexOf("</svg>"));
  });

  it("is a no-op for a single-page document (no seams)", () => {
    const onePage = `<svg viewBox="0 0 420 596">${page(0)}</svg>`;
    expect(insertPageSeparators(onePage)).toBe(onePage);
  });

  it("fails soft (returns input unchanged) on unparseable / empty input", () => {
    expect(insertPageSeparators("")).toBe("");
    expect(insertPageSeparators("<svg></svg>")).toBe("<svg></svg>");
    expect(insertPageSeparators("not an svg")).toBe("not an svg");
  });

  it("leaves the page content and viewBox untouched (only appends seams)", () => {
    const out = insertPageSeparators(threePage);
    // Every original page group survives verbatim.
    expect(out).toContain(page(0));
    expect(out).toContain(page(596));
    expect(out).toContain(page(1192));
    expect(out).toContain('viewBox="0 0 420 1788"');
  });
});
