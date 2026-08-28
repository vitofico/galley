import { describe, it, expect } from "vitest";
import {
  pngPageName,
  planRasterExport,
  packPngTar,
  splitSvgPages,
  stripForeignObjects,
  buildRasterExport,
  DEFAULT_RASTER_SCALE,
  type RasterizeDeps,
} from "./export-raster.js";

// A single-page combined SVG in the typst.ts shape the engine emits (mirrors
// packages/compiler/src/preview-source-map.test.ts SVG_FIXTURE: a
// `<svg class="typst-doc" viewBox>` with shared <defs>/<style> + one
// `<g class="typst-page" transform=translate data-page-width data-page-height>`).
const ONE_PAGE_SVG =
  `<svg class="typst-doc" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 596 842">` +
  `<style>.x{}</style><defs class="glyph"><path id="g1"/></defs>` +
  `<g class="typst-page" transform="translate(0, 0)" data-page-width="596" data-page-height="842">` +
  `<g class="typst-text"><use href="#g1"/>` +
  `<foreignObject x="0" y="0" width="10" height="10"><h5:div class="tsel">Hi</h5:div></foreignObject>` +
  `</g></g></svg>`;

// A two-page combined SVG: a second typst-page group stacked below the first.
const TWO_PAGE_SVG =
  `<svg class="typst-doc" xmlns="http://www.w3.org/2000/svg" ` +
  `xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 596 1684">` +
  `<style>.x{}</style><defs class="glyph"><path id="g1"/></defs>` +
  `<g class="typst-page" transform="translate(0, 0)" data-page-width="596" data-page-height="842">` +
  `<g class="typst-text"><use xlink:href="#g1"/></g></g>` +
  `<g class="typst-page" transform="translate(0, 842)" data-page-width="596" data-page-height="842">` +
  `<g class="typst-text"><use xlink:href="#g1"/></g></g></svg>`;

describe("pngPageName", () => {
  it("is 1-based and zero-free", () => {
    expect(pngPageName(0)).toBe("page-1.png");
    expect(pngPageName(1)).toBe("page-2.png");
    expect(pngPageName(11)).toBe("page-12.png");
  });
});

describe("planRasterExport (single-vs-tar decision)", () => {
  it("one page → a single .png", () => {
    expect(planRasterExport(1)).toEqual({ kind: "png", filename: "document.png" });
  });

  it("zero/negative defensively → a single .png (never an empty tar)", () => {
    expect(planRasterExport(0).kind).toBe("png");
  });

  it("multi-page → a .tar of honest page-N.png names", () => {
    const plan = planRasterExport(3);
    expect(plan).toEqual({
      kind: "tar",
      filename: "document-pages.tar",
      pageNames: ["page-1.png", "page-2.png", "page-3.png"],
    });
  });

  it("honors a custom base name", () => {
    expect(planRasterExport(1, "report")).toEqual({ kind: "png", filename: "report.png" });
    expect(planRasterExport(2, "report").filename).toBe("report-pages.tar");
  });
});

describe("packPngTar (reuses the bundle's writeUstar)", () => {
  it("packs each page as page-N.png with the raw bytes embedded", () => {
    const a = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]); // fake PNG-ish bytes
    const b = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 2]);
    const tar = packPngTar([a, b]);
    // ustar archives are 512-byte block multiples (headers + padded data + 2 end).
    expect(tar.length % 512).toBe(0);
    const text = new TextDecoder("latin1").decode(tar);
    expect(text).toContain("page-1.png");
    expect(text).toContain("page-2.png");
    // The literal page bytes survive into the archive body.
    expect([...tar]).toContain(a[4]!); // distinctive trailing byte of page 1
  });

  it("is deterministic — identical input yields byte-identical output", () => {
    const pngs = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];
    const t1 = packPngTar(pngs);
    const t2 = packPngTar(pngs.map((p) => p.slice()));
    expect([...t1]).toEqual([...t2]);
  });
});

describe("stripForeignObjects (standalone-SVG sanitizer)", () => {
  it("removes foreignObject overlays but keeps the visible glyph geometry", () => {
    const out = stripForeignObjects(ONE_PAGE_SVG);
    expect(out).not.toContain("foreignObject");
    expect(out).not.toContain("tsel");
    expect(out).toContain('id="g1"');
    expect(out).toContain('href="#g1"');
  });

  it("strips <script> (an Image-loaded SVG never runs it)", () => {
    const withScript = `<svg><script>alert(1)</script><path/></svg>`;
    const out = stripForeignObjects(withScript);
    expect(out).not.toContain("<script");
    expect(out).toContain("<path/>");
  });

  it("normalizes &nbsp; to its XML-defined numeric form (strict-XML parse safety)", () => {
    const out = stripForeignObjects(`<svg><text>a&nbsp;b</text></svg>`);
    expect(out).not.toContain("&nbsp;");
    expect(out).toContain("&#160;");
  });

  it("is a no-op when there is nothing to sanitize", () => {
    const plain = `<svg><path/></svg>`;
    expect(stripForeignObjects(plain)).toBe(plain);
  });
});

describe("splitSvgPages (combined typst-doc SVG → per-page standalone SVGs)", () => {
  it("returns one self-contained page for a single-page doc", () => {
    const pages = splitSvgPages(ONE_PAGE_SVG);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.widthPt).toBe(596);
    expect(pages[0]!.heightPt).toBe(842);
    // The page SVG keeps the shared defs (glyph the <use> references) …
    expect(pages[0]!.svg).toContain('id="g1"');
    // … and crops to this page's box via a viewBox.
    expect(pages[0]!.svg).toContain('viewBox="0 0 596 842"');
    // … and is a standalone <svg> with a namespace.
    expect(pages[0]!.svg.startsWith("<svg")).toBe(true);
    expect(pages[0]!.svg).toContain("xmlns=");
    // … with the canvas-tainting foreignObjects stripped (still renders the same).
    expect(pages[0]!.svg).not.toContain("foreignObject");
  });

  it("splits a two-page doc into two pages with their own offset viewBoxes", () => {
    const pages = splitSvgPages(TWO_PAGE_SVG);
    expect(pages).toHaveLength(2);
    expect(pages.map((p) => p.index)).toEqual([0, 1]);
    // Page 1 is at y=0; page 2 is translated to y=842 and cropped there.
    expect(pages[0]!.svg).toContain('viewBox="0 0 596 842"');
    expect(pages[1]!.svg).toContain('viewBox="0 842 596 842"');
    // Each page carries the shared defs.
    expect(pages[0]!.svg).toContain('id="g1"');
    expect(pages[1]!.svg).toContain('id="g1"');
    // Each page wraps exactly one typst-page group (no sibling bleed-through).
    expect((pages[0]!.svg.match(/class="typst-page"/g) ?? [])).toHaveLength(1);
    expect((pages[1]!.svg.match(/class="typst-page"/g) ?? [])).toHaveLength(1);
    // The xlink namespace (used by <use xlink:href>) is carried onto each page so
    // the standalone SVG parses as strict XML (regression: a dropped xmlns:xlink
    // aborts the parse → the Image fails to load → no PNG).
    expect(pages[0]!.svg).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(pages[1]!.svg).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
  });

  it("fails soft: an unrecognized SVG shape → one whole-doc page (never empty)", () => {
    const plain = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200"><rect/></svg>`;
    const pages = splitSvgPages(plain);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.widthPt).toBe(100);
    expect(pages[0]!.heightPt).toBe(200);
    expect(pages[0]!.svg).toBe(plain);
  });

  it("returns [] for a non-svg string", () => {
    expect(splitSvgPages("not an svg")).toEqual([]);
  });
});

describe("buildRasterExport (orchestration via injected seam)", () => {
  // A deterministic fake seam: records calls and returns the requested size as
  // bytes so we can assert scale + per-page rasterization without a browser.
  function fakeDeps(): RasterizeDeps & { calls: { svg: string; w: number; h: number }[] } {
    const calls: { svg: string; w: number; h: number }[] = [];
    return {
      calls,
      rasterize: async (svg, w, h) => {
        calls.push({ svg, w, h });
        return new Uint8Array([w & 0xff, h & 0xff]);
      },
    };
  }

  it("one page → a single image/png with the document.png name", async () => {
    const deps = fakeDeps();
    const out = await buildRasterExport(ONE_PAGE_SVG, deps);
    expect(out.filename).toBe("document.png");
    expect(out.type).toBe("image/png");
    expect(deps.calls).toHaveLength(1);
    // Default scale applied to the page's point box.
    expect(deps.calls[0]!.w).toBe(Math.round(596 * DEFAULT_RASTER_SCALE));
    expect(deps.calls[0]!.h).toBe(Math.round(842 * DEFAULT_RASTER_SCALE));
  });

  it("two pages → an application/x-tar named document-pages.tar packing both PNGs", async () => {
    const deps = fakeDeps();
    const out = await buildRasterExport(TWO_PAGE_SVG, deps);
    expect(out.filename).toBe("document-pages.tar");
    expect(out.type).toBe("application/x-tar");
    expect(deps.calls).toHaveLength(2);
    const text = new TextDecoder("latin1").decode(out.bytes);
    expect(text).toContain("page-1.png");
    expect(text).toContain("page-2.png");
  });

  it("respects a custom scale", async () => {
    const deps = fakeDeps();
    await buildRasterExport(ONE_PAGE_SVG, deps, { scale: 1 });
    expect(deps.calls[0]!.w).toBe(596);
    expect(deps.calls[0]!.h).toBe(842);
  });

  it("throws on an empty render rather than downloading nothing", async () => {
    const deps = fakeDeps();
    await expect(buildRasterExport("not an svg", deps)).rejects.toThrow(/nothing to rasterize/);
    expect(deps.calls).toHaveLength(0);
  });
});
