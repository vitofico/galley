import { describe, it, expect } from "vitest";
import {
  countWords,
  countChars,
  readingTimeMinutes,
  parseHeadings,
  countFiguresAndTables,
} from "./doc-stats.js";

/**
 * Unit tests for the PURE document-stats helpers (roadmap #12.7). No browser
 * needed for these — they operate on plain strings.
 *
 * Counting rules under test (documented in doc-stats.ts):
 *   - words  = number of maximal runs of non-whitespace characters.
 *   - chars  = number of Unicode code points (so astral chars count once).
 */

describe("countWords", () => {
  it("counts runs of non-whitespace", () => {
    expect(countWords("the quick brown fox")).toBe(4);
  });

  it("is zero for the empty string", () => {
    expect(countWords("")).toBe(0);
  });

  it("is zero for whitespace-only input", () => {
    expect(countWords("   \n\t  \r\n ")).toBe(0);
  });

  it("collapses runs of mixed whitespace between words", () => {
    expect(countWords("  one\t\ttwo\n\nthree   ")).toBe(3);
  });

  it("treats punctuation-attached tokens as single words", () => {
    expect(countWords("Hello, world! It's me.")).toBe(4);
  });
});

describe("countChars", () => {
  it("counts code points, not UTF-16 units", () => {
    // "a" + emoji (one code point, two UTF-16 units)
    expect(countChars("a😀")).toBe(2);
  });

  it("is zero for the empty string", () => {
    expect(countChars("")).toBe(0);
  });

  it("counts whitespace characters", () => {
    expect(countChars("a b")).toBe(3);
  });
});

describe("readingTimeMinutes", () => {
  it("is zero for zero words", () => {
    expect(readingTimeMinutes(0)).toBe(0);
  });

  it("uses ~200 wpm by default", () => {
    expect(readingTimeMinutes(400)).toBe(2);
  });

  it("rounds up partial minutes (ceil)", () => {
    expect(readingTimeMinutes(201)).toBe(2);
    expect(readingTimeMinutes(1)).toBe(1);
  });

  it("honors a custom wpm", () => {
    expect(readingTimeMinutes(300, 100)).toBe(3);
  });
});

describe("parseHeadings", () => {
  it("returns [] for a doc with no headings", () => {
    expect(parseHeadings("just some prose\nand more text")).toEqual([]);
  });

  it("parses a single level-1 heading", () => {
    const hs = parseHeadings("= Title\nbody");
    expect(hs).toEqual([{ level: 1, title: "Title", offset: 0, line: 1 }]);
  });

  it("parses nested levels by counting '='", () => {
    const src = "= A\n== B\n=== C";
    const hs = parseHeadings(src);
    expect(hs.map((h) => h.level)).toEqual([1, 2, 3]);
    expect(hs.map((h) => h.title)).toEqual(["A", "B", "C"]);
  });

  it("computes 1-based line numbers", () => {
    const src = "intro\n\n== Aim\ntext\n= End";
    const hs = parseHeadings(src);
    expect(hs.map((h) => h.line)).toEqual([3, 5]);
  });

  it("computes absolute UTF-16 offsets of the heading start", () => {
    const src = "intro\n== Aim";
    const hs = parseHeadings(src);
    // "intro\n" is 6 UTF-16 units, so the '=' starts at offset 6.
    expect(hs[0]!.offset).toBe(6);
  });

  it("offsets are UTF-16 units (astral chars count as 2)", () => {
    const src = "😀\n= H"; // emoji = 2 UTF-16 units, then "\n" = 1 → offset 3
    const hs = parseHeadings(src);
    expect(hs[0]!.offset).toBe(3);
  });

  it("requires whitespace after the '=' run", () => {
    // "==no space" is not a heading in Typst.
    expect(parseHeadings("==notaheading")).toEqual([]);
  });

  it("trims the title", () => {
    const hs = parseHeadings("==   Spaced   ");
    expect(hs[0]!.title).toBe("Spaced");
  });

  it("handles CRLF line endings", () => {
    const src = "= A\r\n== B\r\nbody";
    const hs = parseHeadings(src);
    expect(hs.map((h) => h.title)).toEqual(["A", "B"]);
    expect(hs.map((h) => h.level)).toEqual([1, 2]);
    expect(hs.map((h) => h.line)).toEqual([1, 2]);
    // "= A\r\n" is 5 UTF-16 units → second heading at offset 5.
    expect(hs[1]!.offset).toBe(5);
  });

  it("ignores leading-whitespace-indented '=' (must be line start)", () => {
    expect(parseHeadings("  = Indented")).toEqual([]);
  });
});

describe("countFiguresAndTables", () => {
  it("is {0,0} for prose with no figures or tables", () => {
    expect(countFiguresAndTables("just some prose\nand = a heading")).toEqual({
      figures: 0,
      tables: 0,
    });
  });

  it("counts a figure wrapping an image as a figure", () => {
    const src = `#figure(\n  image("plot.png"),\n  caption: [A plot],\n)`;
    expect(countFiguresAndTables(src)).toEqual({ figures: 1, tables: 0 });
  });

  it("counts a figure wrapping a table as a table (not a figure)", () => {
    const src = `#figure(\n  caption: [Means],\n  table(\n    columns: 2,\n    table.header[a][b],\n    [1], [2],\n  ),\n)`;
    expect(countFiguresAndTables(src)).toEqual({ figures: 0, tables: 1 });
  });

  it("counts a standalone table (no figure) as a table", () => {
    const src = `#align(center)[\n  #table(\n    columns: 3,\n    table.header[a][b][c],\n  )\n]`;
    expect(countFiguresAndTables(src)).toEqual({ figures: 0, tables: 1 });
  });

  it("does not miscount table.header / table.cell as extra tables", () => {
    const src = `#table(\n  columns: 2,\n  table.header[a][b],\n  table.cell[1], table.cell[2],\n)`;
    expect(countFiguresAndTables(src)).toEqual({ figures: 0, tables: 1 });
  });

  it("counts a mix of figures and tables", () => {
    const src = [
      `#figure(image("a.png"), caption: [A])`,
      `#figure(table(columns: 1, [x]), caption: [T1])`,
      `#table(columns: 1, [y])`,
      `#figure(image("b.png"), caption: [B])`,
    ].join("\n\n");
    expect(countFiguresAndTables(src)).toEqual({ figures: 2, tables: 2 });
  });

  it("ignores figure/table mentions inside line and block comments", () => {
    const src = `// see #figure(image("x")) below\n/* a table( in a block comment */\nplain prose`;
    expect(countFiguresAndTables(src)).toEqual({ figures: 0, tables: 0 });
  });

  it("ignores figure/table words inside string literals", () => {
    const src = `#text("a figure( and a table( in a string")`;
    expect(countFiguresAndTables(src)).toEqual({ figures: 0, tables: 0 });
  });

  it("requires a call paren — bare 'figure' / 'table' words don't count", () => {
    expect(countFiguresAndTables("the figure shows a table of values")).toEqual({
      figures: 0,
      tables: 0,
    });
  });

  it("does not match identifiers that merely end in figure/table", () => {
    const src = `#subfigure(image("x"))\n#mytable(1)`;
    expect(countFiguresAndTables(src)).toEqual({ figures: 0, tables: 0 });
  });

  it("tolerates whitespace between the name and the paren", () => {
    expect(countFiguresAndTables("#figure (image(\"x\"))")).toEqual({
      figures: 1,
      tables: 0,
    });
  });
});

/**
 * NOTE: a render test for <DocStats> is intentionally omitted. The root vitest
 * environment is `node` (no DOM) and `@testing-library/react` is not a project
 * dependency — adding either is forbidden by this slice's contract (frozen
 * configs, no new deps). The component is a thin presentational shell over the
 * helpers above; its outline data, offsets, and onJump payload are exactly the
 * `parseHeadings` output exercised here. Component rendering is covered by the
 * shell's Playwright e2e once the coordinator mounts it in the sweep.
 */
