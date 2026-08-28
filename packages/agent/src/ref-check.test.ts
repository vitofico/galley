/**
 * Roadmap #13 slice 3: broken-ref diagnostics core — pure, offline, framework-free.
 *
 * Composes the label index (`./labels.js`) with a caller-supplied set of known
 * citation keys to distinguish a genuinely-broken cross-reference (`@fig-1` with
 * no `<fig-1>` and not a cite key) from a legitimate citation (`@smith2020`).
 * `@name` shares the `@` sigil for both, so the label core alone over-reports.
 */
import { describe, it, expect } from "vitest";
import { refDiagnostics, unusedLabelDiagnostics } from "./ref-check.js";

describe("refDiagnostics", () => {
  it("returns no diagnostics for a doc with a real def + matching ref", () => {
    const src = "Intro <intro> see @intro here";
    expect(refDiagnostics(src, [])).toEqual([]);
  });

  it("returns no diagnostics for empty source", () => {
    expect(refDiagnostics("", [])).toEqual([]);
  });

  it("flags a ref to a missing label as a warning", () => {
    const src = "See @fig-1 here";
    const diags = refDiagnostics(src, []);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe("warning");
    expect(diags[0]!.message).toContain("fig-1");
  });

  it("does NOT flag a ref whose name is a citation key", () => {
    const src = "As shown by @smith2020 elsewhere";
    expect(refDiagnostics(src, ["smith2020"])).toEqual([]);
  });

  it("accepts a Set of citation keys", () => {
    const src = "As shown by @smith2020 elsewhere";
    expect(refDiagnostics(src, new Set(["smith2020"]))).toEqual([]);
  });

  it("accepts a generator of citation keys", () => {
    function* keys(): Generator<string> {
      yield "smith2020";
    }
    const src = "As shown by @smith2020 elsewhere";
    expect(refDiagnostics(src, keys())).toEqual([]);
  });

  it("flags one broken ref while leaving a valid cite and a valid label alone", () => {
    const src = "Fig <fig-1> see @fig-1 cite @smith2020 broken @missing end";
    const diags = refDiagnostics(src, ["smith2020"]);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain("missing");
  });

  it("flags every broken occurrence of the same missing name", () => {
    const src = "@x and @x again";
    const diags = refDiagnostics(src, []);
    expect(diags).toHaveLength(2);
  });

  it("produces a span with correct offsets covering the ref token", () => {
    const src = "See @fig-1 here";
    const diags = refDiagnostics(src, []);
    const span = diags[0]!.span!;
    // "@fig-1" starts at index 4, ends (exclusive) at 10.
    expect(span.offset).toBe(4);
    expect(span.endOffset).toBe(10);
    expect(src.slice(span.offset, span.endOffset)).toBe("@fig-1");
  });

  it("derives 1-based line/column on a multi-line doc", () => {
    const src = "line one\nline two @fig-1 end\n";
    const diags = refDiagnostics(src, []);
    const span = diags[0]!.span!;
    // "@fig-1" is on line 2; "line two " is 9 chars before it (column 1-based -> 10).
    expect(span.start.line).toBe(2);
    expect(span.start.column).toBe(10);
    expect(span.end.line).toBe(2);
    expect(span.end.column).toBe(16); // exclusive end, 10 + len("@fig-1")=6
    // Offsets are absolute into the whole source.
    expect(src.slice(span.offset, span.endOffset)).toBe("@fig-1");
  });

  it("does not mutate or depend on input order of citeKeys", () => {
    const src = "@a @b";
    expect(refDiagnostics(src, ["b", "a"])).toEqual([]);
  });
});

describe("unusedLabelDiagnostics", () => {
  it("returns no diagnostics when every label is referenced", () => {
    const src = "<intro> ... @intro";
    expect(unusedLabelDiagnostics(src)).toEqual([]);
  });

  it("flags a label that is defined but never referenced", () => {
    const src = "Heading <orphan> with no ref.";
    const diags = unusedLabelDiagnostics(src);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe("warning");
    expect(diags[0]!.message).toContain("orphan");
    const span = diags[0]!.span!;
    expect(src.slice(span.offset, span.endOffset)).toBe("<orphan>");
  });

  it("returns no diagnostics for empty source", () => {
    expect(unusedLabelDiagnostics("")).toEqual([]);
  });
});

// First-boot lint fix (#20.2): `@…` mentioned inside a Typst comment (or raw
// block) is TEXT, not a reference — the demo's main.typ has a header comment
// mentioning `@preview` and must boot warning-free.
describe("refDiagnostics ignores comments and raw blocks", () => {
  it("does not flag a @mention inside a line comment", () => {
    const src = "// pure Typst — no @preview packages here\nBody text.";
    expect(refDiagnostics(src, [])).toEqual([]);
  });

  it("does not flag a @mention inside a block comment", () => {
    const src = "before /* see @nothere\nand @also-not */ after";
    expect(refDiagnostics(src, [])).toEqual([]);
  });

  it("does not flag a @mention inside raw blocks", () => {
    const src = "inline `@raw-ref` and fenced:\n```\n@fenced-ref\n```\ndone";
    expect(refDiagnostics(src, [])).toEqual([]);
  });

  it("still flags a real broken ref outside the comment", () => {
    const src = "// harmless @preview mention\nSee @fig-1 here";
    const diags = refDiagnostics(src, []);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain("fig-1");
  });

  it("a ref AFTER a comment keeps its exact line/column (strip preserves offsets)", () => {
    const src = "// a comment line\nx @broken";
    const diags = refDiagnostics(src, []);
    expect(diags).toHaveLength(1);
    const span = diags[0]!.span!;
    expect(src.slice(span.offset, span.endOffset)).toBe("@broken");
    expect(span.start).toEqual({ line: 2, column: 3 });
  });

  it("a trailing comment does not hide a real broken ref earlier on the line", () => {
    const src = '@broken stuff // and a @commented mention';
    const diags = refDiagnostics(src, []);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain("@broken");
  });

  it("// inside a string is NOT a comment (URL case)", () => {
    const src = '#link("https://example.org") then @broken';
    const diags = refDiagnostics(src, []);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain("@broken");
  });

  it("a <label> inside a comment does not satisfy a real ref", () => {
    const src = "// <ghost> defined only in a comment\n@ghost";
    const diags = refDiagnostics(src, []);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain("@ghost");
  });

  it("a <label> inside a comment is not reported as unused", () => {
    const src = "// <ghost> only in a comment\nreal <used> @used";
    expect(unusedLabelDiagnostics(src)).toEqual([]);
  });
});

// The bug this fixes, at the diagnostic layer: a document whose only `@` is an
// escaped one in an email address must produce no diagnostics at all.
describe("refDiagnostics escaped at-sign", () => {
  it("reports nothing for an escaped email address", () => {
    expect(refDiagnostics("Contact: jane.doe\\@example.com", [])).toEqual([]);
  });

  it("still reports a genuinely broken ref in the same document", () => {
    const diags = refDiagnostics("mail jane\\@example.com, see @nope", []);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toBe("unknown reference @nope");
  });
});
