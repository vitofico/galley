import { describe, it, expect } from "vitest";
import {
  parseTransform,
  parseAstTextLeaves,
  parseSvgTextRuns,
  buildPreviewSourceMap,
  buildProjectPreviewSourceMap,
  orderFilesByDocumentOrder,
  lookupPreviewRegion,
  lookupSourceAtPoint,
  rangeLength,
} from "./preview-source-map.js";
import type { PreviewSourceMap } from "@galley/shared";

// Fixtures distilled from a real typst.ts 0.7.0 compile of:
//   = Title
//   Hello *world* and a formula $a + b$.
//
//   Second paragraph here, with more words.
// (captured during the E4 follow-up; see docs/research/span-svg-mapping.md). The
// SVG below keeps the exact transform/foreignObject shape the renderer emits, so
// the geometry parser is exercised against the genuine structure, not a mock.
const AST_FIXTURE = `---
path: main.typ
ast:
  s: <span style='color:#7dcfff'>Marked::Markup</span>
  c:
  - s: <span style='color:#7dcfff'>Marked::Heading</span> &lt;1:0~1:7&gt;
    c:
    - s: <span style='color:#7dcfff'>Marked::HeadingMarker</span> &lt;1:0~1:1&gt;
    - s: <span style='color:#7dcfff'>Marked::Markup</span> &lt;1:2~1:7&gt;
      c:
      - s: <span style='color:#7dcfff'>Marked::Text</span> &lt;1:2~1:7&gt;
  - s: <span style='color:#7dcfff'>Marked::Text</span> &lt;2:0~2:5&gt;
  - s: <span style='color:#7dcfff'>Marked::Strong</span> &lt;2:6~2:13&gt;
    c:
    - s: <span style='color:#7dcfff'>Marked::Star</span> &lt;2:6~2:7&gt;
    - s: <span style='color:#7dcfff'>Marked::Markup</span> &lt;2:7~2:12&gt;
      c:
      - s: <span style='color:#7dcfff'>Marked::Text</span> &lt;2:7~2:12&gt;
    - s: <span style='color:#7dcfff'>Marked::Star</span> &lt;2:12~2:13&gt;
  - s: <span style='color:#7dcfff'>Marked::Text</span> &lt;2:14~2:27&gt;
  - s: <span style='color:#7dcfff'>Marked::Text</span> &lt;4:0~4:39&gt;`;

// A faithful slice of the real SVG page tree: two text runs on page 0 with the
// genuine `translate`/`scale` chain and `foreignObject`/`tsel` structure.
const SVG_FIXTURE = `<svg class="typst-doc" viewBox="0 0 596.000 842.000"><style>.x{}</style><defs class="glyph"><path id="g1"/></defs><g class="typst-page" transform="translate(0, 0)" data-page-width="596" data-page-height="842"><g class="typst-group"><g transform="translate(70.866,70.866)"><g class="typst-group"><g transform="translate(0.000,9.933)"><g class="typst-text" fill="#000" transform="scale(0.0154,-0.0154)"><use x="0" y="0" href="#g1"/><g transform="scale(16,-16)"><foreignObject x="0" y="-55.88" width="134.13" height="62.50"><h5:div class="tsel">Title</h5:div></foreignObject></g></g></g></g></g><g transform="translate(70.866,89.049)"><g class="typst-group"><g transform="translate(0.000,7.513)"><g class="typst-text" fill="#000" transform="scale(0.011,-0.011)"><use x="0" y="0" href="#g1"/><g transform="scale(16,-16)"><foreignObject x="0" y="-55.88" width="153.69" height="62.50"><h5:div class="tsel">Hello </h5:div></foreignObject></g></g></g></g></g></g></svg>`;

describe("parseTransform", () => {
  it("returns identity for an absent/empty transform", () => {
    expect(parseTransform(undefined)).toEqual([1, 0, 0, 1, 0, 0]);
    expect(parseTransform("")).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("parses a translate", () => {
    expect(parseTransform("translate(70.866, 70.866)")).toEqual([
      1, 0, 0, 1, 70.866, 70.866,
    ]);
  });

  it("parses a scale (and a bare single-arg scale)", () => {
    expect(parseTransform("scale(0.0154,-0.0154)")).toEqual([
      0.0154, 0, 0, -0.0154, 0, 0,
    ]);
    expect(parseTransform("scale(2)")).toEqual([2, 0, 0, 2, 0, 0]);
  });

  it("composes a translate then a scale left-to-right", () => {
    // translate(10,20) then scale(2,3): a point (1,1) → (10+2, 20+3) = (12,23).
    const t = parseTransform("translate(10,20) scale(2,3)");
    expect(t[4]).toBe(10);
    expect(t[5]).toBe(20);
    expect(t[0]).toBe(2);
    expect(t[3]).toBe(3);
  });

  it("ignores an unrecognized transform function (treats as identity)", () => {
    expect(parseTransform("rotate(45)")).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

describe("parseAstTextLeaves", () => {
  it("extracts text-bearing leaves in document order with their ranges", () => {
    const leaves = parseAstTextLeaves(AST_FIXTURE);
    // Heading text, "Hello", "world", "and a formula", and the second paragraph.
    expect(
      leaves.map((l) => `${l.kind} ${l.start.line}:${l.start.column}`),
    ).toEqual(["Text 1:2", "Text 2:0", "Text 2:7", "Text 2:14", "Text 4:0"]);
    // Ranges are 1-based line, 0-based column.
    expect(leaves[0]).toMatchObject({
      start: { line: 1, column: 2 },
      end: { line: 1, column: 7 },
    });
  });

  it("skips structural (non-text) nodes like Heading/Strong/Star", () => {
    const leaves = parseAstTextLeaves(AST_FIXTURE);
    expect(
      leaves.every((l) => l.kind === "Text" || l.kind === "MathText"),
    ).toBe(true);
  });

  it("fails soft on empty / non-string input", () => {
    expect(parseAstTextLeaves("")).toEqual([]);
    expect(parseAstTextLeaves(null)).toEqual([]);
    expect(parseAstTextLeaves(undefined)).toEqual([]);
    expect(parseAstTextLeaves("not an ast at all")).toEqual([]);
  });
});

describe("parseSvgTextRuns", () => {
  it("recovers each run's page, document-space bbox, and tsel text", () => {
    const runs = parseSvgTextRuns(SVG_FIXTURE);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.text).toBe("Title");
    expect(runs[1]!.text).toBe("Hello");
    expect(runs.every((r) => r.page === 0)).toBe(true);
  });

  it("places the title near the page's top-left margin (70.866pt) with sane size", () => {
    const [title] = parseSvgTextRuns(SVG_FIXTURE);
    // Margin is 70.866pt; the title's left edge sits at the margin.
    expect(title!.rect.x).toBeCloseTo(70.866, 1);
    // "Title" at ~16pt: width ~33pt, height ~15pt (0.0154 * 16 * extent).
    expect(title!.rect.width).toBeGreaterThan(20);
    expect(title!.rect.width).toBeLessThan(50);
    expect(title!.rect.height).toBeGreaterThan(10);
    expect(title!.rect.height).toBeLessThan(20);
  });

  it("orders runs top-to-bottom (the title sits above the body line)", () => {
    const [title, hello] = parseSvgTextRuns(SVG_FIXTURE);
    expect(title!.rect.y).toBeLessThan(hello!.rect.y);
  });

  it("fails soft on empty / non-string / non-SVG input", () => {
    expect(parseSvgTextRuns("")).toEqual([]);
    expect(parseSvgTextRuns(null)).toEqual([]);
    expect(parseSvgTextRuns("<svg></svg>")).toEqual([]);
  });
});

describe("buildPreviewSourceMap", () => {
  it("zips AST leaves to SVG runs in order, yielding source→region entries", () => {
    const map = buildPreviewSourceMap(AST_FIXTURE, SVG_FIXTURE, [
      { widthPt: 596, heightPt: 842 },
    ]);
    // min(5 leaves, 2 runs) = 2 entries.
    expect(map.entries).toHaveLength(2);
    // First entry: the heading text range maps to the "Title" bbox.
    expect(map.entries[0]!.start).toEqual({ line: 1, column: 2 });
    expect(map.entries[0]!.rect.x).toBeCloseTo(70.866, 1);
    // Entries are sorted by source position.
    expect(map.entries[0]!.start.line).toBeLessThanOrEqual(
      map.entries[1]!.start.line,
    );
    expect(map.pages).toEqual([{ widthPt: 596, heightPt: 842 }]);
  });

  it("returns an empty map (no throw) when either input is missing", () => {
    expect(buildPreviewSourceMap(null, SVG_FIXTURE).entries).toEqual([]);
    expect(buildPreviewSourceMap(AST_FIXTURE, null).entries).toEqual([]);
    expect(buildPreviewSourceMap("", "").entries).toEqual([]);
  });
});

describe("lookupPreviewRegion", () => {
  const map = buildPreviewSourceMap(AST_FIXTURE, SVG_FIXTURE);

  it("returns the containing entry for a cursor inside a range", () => {
    // Cursor at line 1, col 4 — inside the heading text range 1:2~1:7.
    const hit = lookupPreviewRegion(map, { line: 1, column: 4 });
    expect(hit).toBeDefined();
    expect(hit!.start).toEqual({ line: 1, column: 2 });
  });

  it("returns the nearest entry when the cursor is between ranges", () => {
    // Cursor on line 1 col 0 (the heading marker, before the text range): the
    // nearest entry is still the heading text.
    const hit = lookupPreviewRegion(map, { line: 1, column: 0 });
    expect(hit!.start).toEqual({ line: 1, column: 2 });
  });

  it("returns undefined for an empty/absent map", () => {
    expect(
      lookupPreviewRegion(undefined, { line: 1, column: 0 }),
    ).toBeUndefined();
    expect(
      lookupPreviewRegion({ entries: [], pages: [] }, { line: 1, column: 0 }),
    ).toBeUndefined();
  });
});

describe("lookupSourceAtPoint (inverse sync)", () => {
  const map = buildPreviewSourceMap(AST_FIXTURE, SVG_FIXTURE, [
    { widthPt: 596, heightPt: 842 },
  ]);
  // The two real entries: "Title" at (~70.9, ~13) and "Hello" below it. Capture
  // their rects so the point tests are anchored to the genuine geometry.
  const title = map.entries.find((e) => e.start.line === 1)!;
  const hello = map.entries.find((e) => e.start.line === 2)!;

  it("returns the source start for a point inside a run's bbox", () => {
    // Center of the title's bbox → the title's source start (1:2).
    const cx = title.rect.x + title.rect.width / 2;
    const cy = title.rect.y + title.rect.height / 2;
    expect(lookupSourceAtPoint(map, { x: cx, y: cy })).toEqual({
      line: 1,
      column: 2,
    });
  });

  it("resolves a point inside the second run to that run's source", () => {
    const cx = hello.rect.x + hello.rect.width / 2;
    const cy = hello.rect.y + hello.rect.height / 2;
    expect(lookupSourceAtPoint(map, { x: cx, y: cy })).toEqual(hello.start);
  });

  it("returns null for a point in empty space far from every run", () => {
    // Bottom-right corner of the page: nowhere near the top-margin text.
    expect(lookupSourceAtPoint(map, { x: 500, y: 800 })).toBeNull();
  });

  it("falls back to the nearest run for a point just outside a bbox (within the gap)", () => {
    // A few points to the left of the title's left edge, same row: nearest is the
    // title (coarse fallback is acceptable per the E4 memo).
    const cy = title.rect.y + title.rect.height / 2;
    expect(
      lookupSourceAtPoint(map, { x: title.rect.x - 5, y: cy }),
    ).toEqual(title.start);
  });

  it("does not fall back across a wide gap (returns null beyond maxGapPt)", () => {
    const cy = title.rect.y + title.rect.height / 2;
    // 200pt to the right of the title — well beyond the default 24pt gap.
    expect(
      lookupSourceAtPoint(map, { x: title.rect.x + title.rect.width + 200, y: cy }),
    ).toBeNull();
  });

  it("prefers the tightest (smallest-area) enclosing run when rects overlap", () => {
    const overlap: PreviewSourceMap = {
      pages: [],
      entries: [
        {
          start: { line: 10, column: 0 },
          end: { line: 10, column: 80 },
          page: 0,
          rect: { x: 0, y: 0, width: 100, height: 100 },
        },
        {
          start: { line: 10, column: 5 },
          end: { line: 10, column: 9 },
          page: 0,
          rect: { x: 40, y: 40, width: 20, height: 20 },
        },
      ],
    };
    // (50,50) is inside both; the inner (smaller-area) run wins.
    expect(lookupSourceAtPoint(overlap, { x: 50, y: 50 })).toEqual({
      line: 10,
      column: 5,
    });
  });

  it("returns null for an empty/absent map or a non-finite point", () => {
    expect(lookupSourceAtPoint(undefined, { x: 0, y: 0 })).toBeNull();
    expect(
      lookupSourceAtPoint({ entries: [], pages: [] }, { x: 0, y: 0 }),
    ).toBeNull();
    expect(lookupSourceAtPoint(map, { x: NaN, y: 0 })).toBeNull();
  });
});

describe("text-anchored alignment (drift repro, fix/preview-backlink)", () => {
  // Source: one heading + two body runs. The rendered SVG additionally contains
  // a GENERATED run (e.g. a numbered-citation "[1]" or a ToC entry) that has NO
  // corresponding source leaf, sitting BETWEEN the two body runs. Positional zip
  // would shift every later pairing by one; text-anchored alignment must skip the
  // generated run and keep the real pairings aligned.
  //
  //   Source:
  //     1: = Title          → Text 1:2~1:7  ("Title")
  //     2: Alpha            → Text 2:0~2:5  ("Alpha")
  //     3: Bravo            → Text 3:0~3:5  ("Bravo")
  const SOURCE = "= Title\nAlpha\nBravo\n";
  const AST = `---
path: main.typ
ast:
  s: <span>Marked::Markup</span>
  c:
  - s: <span>Marked::Heading</span> &lt;1:0~1:7&gt;
    c:
    - s: <span>Marked::Text</span> &lt;1:2~1:7&gt;
  - s: <span>Marked::Text</span> &lt;2:0~2:5&gt;
  - s: <span>Marked::Text</span> &lt;3:0~3:5&gt;`;

  // Helper: build a typst-text run group with the genuine transform/foreignObject
  // shape, parameterized by a vertical offset (so runs order top-to-bottom) and
  // its visible tsel text.
  const run = (ty: number, text: string) =>
    `<g transform="translate(70.866,${ty})"><g class="typst-text" fill="#000" transform="scale(0.0154,-0.0154)"><g transform="scale(16,-16)"><foreignObject x="0" y="-55.88" width="100" height="62.50"><h5:div class="tsel">${text}</h5:div></foreignObject></g></g></g>`;

  // Runs in render order: Title, then a GENERATED "[1]" run with no leaf, then
  // Alpha, Bravo. The generated run is the drift trigger.
  const SVG_WITH_GENERATED = `<svg class="typst-doc"><g class="typst-page" transform="translate(0,0)" data-page-width="596" data-page-height="842">${run(
    20,
    "Title",
  )}${run(40, "[1]")}${run(60, "Alpha")}${run(80, "Bravo")}</g></svg>`;

  it("does NOT let a generated run in the middle shift later pairings", () => {
    const map = buildPreviewSourceMap(AST, SVG_WITH_GENERATED, [], SOURCE);
    // 3 real leaves should align to their 3 matching runs (Title/Alpha/Bravo);
    // the "[1]" run is generated and must be skipped, not consume a leaf.
    expect(map.entries).toHaveLength(3);
    const byLine = (l: number) => map.entries.find((e) => e.start.line === l)!;

    // Click on the "Alpha" run (ty=60) must resolve to source line 2, not line 3.
    const alpha = byLine(2);
    const cAlpha = lookupSourceAtPoint(map, {
      x: alpha.rect.x + alpha.rect.width / 2,
      y: alpha.rect.y + alpha.rect.height / 2,
    });
    expect(cAlpha).toEqual({ line: 2, column: 0 });

    // Click on the "Bravo" run (ty=80) must resolve to source line 3.
    const bravo = byLine(3);
    const cBravo = lookupSourceAtPoint(map, {
      x: bravo.rect.x + bravo.rect.width / 2,
      y: bravo.rect.y + bravo.rect.height / 2,
    });
    expect(cBravo).toEqual({ line: 3, column: 0 });
  });

  it("aligns the Bravo run to the Bravo bbox (the lowest run), proving no drift", () => {
    const map = buildPreviewSourceMap(AST, SVG_WITH_GENERATED, [], SOURCE);
    const bravo = map.entries.find((e) => e.start.line === 3)!;
    // Bravo is rendered at ty=80 — the lowest of the four runs. Its bbox.y must be
    // the largest among all entries (positional zip would have mis-anchored it).
    const maxY = Math.max(...map.entries.map((e) => e.rect.y));
    expect(bravo.rect.y).toBeCloseTo(maxY, 5);
  });
});

describe("multi-file text-anchored alignment (cross-file drift, fix/preview-backlink)", () => {
  // File A (main) renders "Alpha"; File B renders "Bravo". A GENERATED run "[1]"
  // is interleaved BETWEEN them in render order. Positional zip with main-first
  // concatenation drifts across the file boundary so a click on Bravo resolved
  // into file A. Text-anchored alignment must attribute Bravo's run to file B.
  const SRC_A = "Alpha\n";
  const SRC_B = "Bravo\n";
  const AST_A = `---
path: main.typ
ast:
  s: <span>Marked::Markup</span>
  c:
  - s: <span>Marked::Text</span> &lt;1:0~1:5&gt;`;
  const AST_B = `---
path: parts/b.typ
ast:
  s: <span>Marked::Markup</span>
  c:
  - s: <span>Marked::Text</span> &lt;1:0~1:5&gt;`;

  const run = (ty: number, text: string) =>
    `<g transform="translate(70.866,${ty})"><g class="typst-text" fill="#000" transform="scale(0.0154,-0.0154)"><g transform="scale(16,-16)"><foreignObject x="0" y="-55.88" width="100" height="62.50"><h5:div class="tsel">${text}</h5:div></foreignObject></g></g></g>`;

  const SVG = `<svg class="typst-doc"><g class="typst-page" transform="translate(0,0)" data-page-width="596" data-page-height="842">${run(
    20,
    "Alpha",
  )}${run(40, "[1]")}${run(60, "Bravo")}</g></svg>`;

  it("resolves a click on file B's run to file B (not file A)", () => {
    const map = buildProjectPreviewSourceMap(
      [
        { astText: AST_A, filePath: "/main.typ", sourceText: SRC_A },
        { astText: AST_B, filePath: "/parts/b.typ", sourceText: SRC_B },
      ],
      SVG,
      [{ widthPt: 596, heightPt: 842 }],
    );
    expect(map.entries).toHaveLength(2);
    // Locate the Bravo run by its geometry (lowest run, ty=60).
    const bravo = map.entries.reduce((lo, e) => (e.rect.y > lo.rect.y ? e : lo));
    const hit = lookupSourceAtPoint(map, {
      x: bravo.rect.x + bravo.rect.width / 2,
      y: bravo.rect.y + bravo.rect.height / 2,
    });
    expect(hit).toEqual({ line: 1, column: 0, filePath: "/parts/b.typ" });
  });
});

describe("alignment perf/fuzz guard (bounded, fix/preview-backlink)", () => {
  it("stays bounded on a pathological all-generated run stream", () => {
    // Build a huge SVG of runs that match NO source leaf (all generated), plus a
    // huge AST of leaves that never appear in the SVG. A naive O(n²) resync would
    // hang; the bounded lookahead must finish quickly.
    const N = 5000;
    const SOURCE = Array.from({ length: N }, (_, i) => `leaf${i}`).join("\n") + "\n";
    const astLines = Array.from(
      { length: N },
      (_, i) =>
        `  - s: <span>Marked::Text</span> &lt;${i + 1}:0~${i + 1}:5&gt;`,
    ).join("\n");
    const AST = `---\npath: main.typ\nast:\n  s: <span>Marked::Markup</span>\n  c:\n${astLines}`;
    const run = (text: string) =>
      `<g transform="translate(70.866,20)"><g class="typst-text" transform="scale(0.0154,-0.0154)"><g transform="scale(16,-16)"><foreignObject x="0" y="-55.88" width="100" height="62.50"><h5:div class="tsel">${text}</h5:div></foreignObject></g></g></g>`;
    const runs = Array.from({ length: N }, (_, i) => run(`GEN${i}`)).join("");
    const SVG = `<svg class="typst-doc"><g class="typst-page" transform="translate(0,0)">${runs}</g></svg>`;

    const t0 = Date.now();
    const map = buildPreviewSourceMap(AST, SVG, [], SOURCE);
    const dt = Date.now() - t0;
    // Nothing matches, so the map is best-effort (possibly empty) but MUST return.
    expect(Array.isArray(map.entries)).toBe(true);
    // Bounded: comfortably under a generous ceiling (would be seconds if O(n²)).
    expect(dt).toBeLessThan(2000);
  });
});

describe("rangeLength", () => {
  it("measures single-line range length and treats multi-line as unbounded", () => {
    expect(rangeLength({ line: 2, column: 7 }, { line: 2, column: 12 })).toBe(
      5,
    );
    expect(rangeLength({ line: 1, column: 0 }, { line: 3, column: 0 })).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe("parseAstTextLeaves filePath stamping (B14)", () => {
  it("stamps every leaf with the supplied file path", () => {
    const leaves = parseAstTextLeaves(AST_FIXTURE, "/parts/intro.typ");
    expect(leaves.length).toBeGreaterThan(0);
    expect(leaves.every((l) => l.filePath === "/parts/intro.typ")).toBe(true);
  });

  it("omits filePath entirely when none is supplied (backward compat)", () => {
    const leaves = parseAstTextLeaves(AST_FIXTURE);
    expect(leaves.every((l) => !("filePath" in l))).toBe(true);
  });
});

describe("buildProjectPreviewSourceMap (B14 reverse-nav across files)", () => {
  // A two-file project whose rendered SVG (SVG_FIXTURE: "Title" then "Hello")
  // draws content from two distinct source files: the main file owns the heading,
  // an imported part owns the body run. Each per-file AST has ONE text leaf, so
  // the positional zip aligns leaf #0→run #0 (Title) and leaf #1→run #1 (Hello).
  const MAIN_AST = `---
path: main.typ
ast:
  s: <span>Marked::Markup</span>
  c:
  - s: <span>Marked::Text</span> &lt;1:2~1:7&gt;`;
  const PART_AST = `---
path: parts/intro.typ
ast:
  s: <span>Marked::Markup</span>
  c:
  - s: <span>Marked::Text</span> &lt;2:0~2:5&gt;`;

  it("tags each entry with the file its AST leaf came from", () => {
    const map = buildProjectPreviewSourceMap(
      [
        { astText: MAIN_AST, filePath: "/main.typ" },
        { astText: PART_AST, filePath: "/parts/intro.typ" },
      ],
      SVG_FIXTURE,
      [{ widthPt: 596, heightPt: 842 }],
    );
    expect(map.entries).toHaveLength(2);
    const heading = map.entries.find((e) => e.start.line === 1)!;
    const body = map.entries.find((e) => e.start.line === 2)!;
    expect(heading.filePath).toBe("/main.typ");
    expect(body.filePath).toBe("/parts/intro.typ");
  });

  it("lets lookupSourceAtPoint resolve a click to the IMPORTED file (the bug)", () => {
    const map = buildProjectPreviewSourceMap(
      [
        { astText: MAIN_AST, filePath: "/main.typ" },
        { astText: PART_AST, filePath: "/parts/intro.typ" },
      ],
      SVG_FIXTURE,
      [{ widthPt: 596, heightPt: 842 }],
    );
    const body = map.entries.find((e) => e.start.line === 2)!;
    const cx = body.rect.x + body.rect.width / 2;
    const cy = body.rect.y + body.rect.height / 2;
    // The click lands on the second run, which the source map attributes to the
    // imported file — the position carries its `filePath` so the handler can
    // switch files before jumping (B14). Pre-fix this was unresolvable.
    expect(lookupSourceAtPoint(map, { x: cx, y: cy })).toEqual({
      line: 2,
      column: 0,
      filePath: "/parts/intro.typ",
    });
  });

  it("single-file (no filePath) result is byte-for-byte the legacy shape", () => {
    // One source given WITHOUT a path → entries carry no filePath, matching the
    // existing single-file buildPreviewSourceMap exactly. lookupSourceAtPoint then
    // returns a bare SourceLineCol (no filePath key) as before.
    const projectMap = buildProjectPreviewSourceMap(
      [{ astText: AST_FIXTURE }],
      SVG_FIXTURE,
      [{ widthPt: 596, heightPt: 842 }],
    );
    const legacy = buildPreviewSourceMap(AST_FIXTURE, SVG_FIXTURE, [
      { widthPt: 596, heightPt: 842 },
    ]);
    expect(projectMap).toEqual(legacy);
    expect(projectMap.entries.every((e) => !("filePath" in e))).toBe(true);
    const title = projectMap.entries.find((e) => e.start.line === 1)!;
    const hit = lookupSourceAtPoint(projectMap, {
      x: title.rect.x + title.rect.width / 2,
      y: title.rect.y + title.rect.height / 2,
    });
    expect(hit).toEqual({ line: 1, column: 2 });
    expect(hit && "filePath" in hit).toBe(false);
  });

  it("fails soft to an empty map on empty input", () => {
    expect(buildProjectPreviewSourceMap([], SVG_FIXTURE).entries).toEqual([]);
    expect(
      buildProjectPreviewSourceMap(
        [{ astText: null, filePath: "/main.typ" }],
        SVG_FIXTURE,
      ).entries,
    ).toEqual([]);
  });
});

describe("anchored alignment survives a duplicated generated block (fix/preview-backref)", () => {
  // A `#outline` ToC renders every heading's text AGAIN, on its own early page,
  // and that ToC run PREFIX-matches the real heading leaf. The old two-cursor
  // resync consumed the heading leaf at the ToC's location and desynced for the
  // rest of the document (whole sections dropped). The anchored aligner must keep
  // the body mapped to its real (later) runs regardless of the ToC duplicate.
  const SOURCE =
    "= Section One Heading\nfirst body sentence here\nsecond body sentence here\n";
  const AST = `---
path: main.typ
ast:
  s: <span>Marked::Markup</span>
  c:
  - s: <span>Marked::Heading</span> &lt;1:0~1:21&gt;
    c:
    - s: <span>Marked::Text</span> &lt;1:2~1:21&gt;
  - s: <span>Marked::Text</span> &lt;2:0~2:24&gt;
  - s: <span>Marked::Text</span> &lt;3:0~3:25&gt;`;
  const run = (ty: number, text: string) =>
    `<g transform="translate(70.866,${ty})"><g class="typst-text" transform="scale(0.0154,-0.0154)"><g transform="scale(16,-16)"><foreignObject x="0" y="-55.88" width="100" height="62.50"><h5:div class="tsel">${text}</h5:div></foreignObject></g></g></g>`;
  // page 0: the ToC entry (a prefix-superset of the heading text + a page number).
  // page 1: the REAL heading, then the two body sentences.
  const SVG =
    `<svg class="typst-doc">` +
    `<g class="typst-page" transform="translate(0,0)" data-page-height="100">${run(20, "Section One Heading 1")}</g>` +
    `<g class="typst-page" transform="translate(0,100)" data-page-height="100">${run(120, "Section One Heading")}${run(140, "first body sentence here")}${run(160, "second body sentence here")}</g>` +
    `</svg>`;

  it("maps the body sentences to their real page-1 runs, not the ToC page", () => {
    const map = buildPreviewSourceMap(AST, SVG, [], SOURCE);
    const first = map.entries.find((e) => e.start.line === 2)!;
    const second = map.entries.find((e) => e.start.line === 3)!;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // Both body runs are on page 1 (y ≥ 100), never the ToC page 0.
    expect(first.page).toBe(1);
    expect(second.page).toBe(1);
    // And clicking each body run resolves to its own line (no drift).
    expect(
      lookupSourceAtPoint(map, {
        x: first.rect.x + first.rect.width / 2,
        y: first.rect.y + first.rect.height / 2,
      }),
    ).toEqual({ line: 2, column: 0 });
    expect(
      lookupSourceAtPoint(map, {
        x: second.rect.x + second.rect.width / 2,
        y: second.rect.y + second.rect.height / 2,
      }),
    ).toEqual({ line: 3, column: 0 });
  });
});

describe("orderFilesByDocumentOrder (fix/preview-backref)", () => {
  it("reconstructs include order from a main that #includes its parts", () => {
    const files = [
      { path: "/brownian.typ", text: "body" },
      { path: "/main.typ", text: '#include "/photoelectric.typ"\n#include "/brownian.typ"\n' },
      { path: "/photoelectric.typ", text: "body" },
    ];
    const ordered = orderFilesByDocumentOrder("/main.typ", files).map((f) => f.path);
    expect(ordered).toEqual(["/main.typ", "/photoelectric.typ", "/brownian.typ"]);
  });

  it("resolves relative includes against the including file's directory", () => {
    const files = [
      { path: "/parts/b.typ", text: "" },
      { path: "/main.typ", text: '#include "parts/a.typ"\n' },
      { path: "/parts/a.typ", text: '#include "b.typ"\n' },
    ];
    const ordered = orderFilesByDocumentOrder("/main.typ", files).map((f) => f.path);
    expect(ordered).toEqual(["/main.typ", "/parts/a.typ", "/parts/b.typ"]);
  });

  it("appends files never reached by an include, in input order, and is cycle-safe", () => {
    const files = [
      { path: "/main.typ", text: '#include "/a.typ"\n' },
      { path: "/a.typ", text: '#include "/main.typ"\n' }, // cycle back to main
      { path: "/orphan.typ", text: "" },
      { path: "/refs.bib", text: "" },
    ];
    const ordered = orderFilesByDocumentOrder("/main.typ", files).map((f) => f.path);
    expect(ordered).toEqual(["/main.typ", "/a.typ", "/orphan.typ", "/refs.bib"]);
  });
});
