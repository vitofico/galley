import { describe, it, expect } from "vitest";
import { diagnosticsToRanges, diagnosticToPos } from "./diagnostics-extension.js";
import type { Diagnostic } from "@galley/shared";

/**
 * Unit tests for the PURE span->offset mapper. No browser/CM view needed.
 *
 * `Diagnostic.span` carries 1-based line/column positions (UTF-16 columns), per
 * `@galley/shared` (`SourcePosition`). `diagnosticsToRanges` converts those into
 * absolute UTF-16 offsets into `docText`, the units CodeMirror uses. The span's
 * canonical `offset`/`endOffset` are deliberately NOT trusted here: this mapper
 * is the line/column path the contract specifies, so it derives offsets purely
 * from the document text + line/column.
 */

// Helper: build a Diagnostic with a 1-based line/column span. The `offset`
// fields are required by the type but irrelevant to the line/column mapper;
// set them to nonsense to prove they're not used.
function diag(
  severity: "error" | "warning",
  start: [number, number] | null,
  end?: [number, number],
): Diagnostic {
  if (start === null) return { severity, message: "no span" };
  const [sl, sc] = start;
  const [el, ec] = end ?? start;
  return {
    severity,
    message: `${severity} @ ${sl}:${sc}`,
    span: {
      offset: -999,
      endOffset: -999,
      start: { line: sl, column: sc },
      end: { line: el, column: ec },
    },
  };
}

const DOC = "hello world\nsecond line\nthird";
//            0123456789..        ^ line 2 starts at offset 12
//  line 1: "hello world" offsets 0..10 (len 11), newline at 11
//  line 2: "second line" offsets 12..22 (len 11), newline at 23
//  line 3: "third"       offsets 24..28

describe("diagnosticsToRanges", () => {
  it("maps a single-line span to absolute offsets", () => {
    // line 1, columns 1..6 -> "hello" -> offsets 0..5
    const r = diagnosticsToRanges(DOC, [diag("error", [1, 1], [1, 6])]);
    expect(r).toEqual([{ from: 0, to: 5, severity: "error" }]);
  });

  it("maps a span on a later line using the line offset", () => {
    // line 2, columns 1..7 -> "second" -> offsets 12..18
    const r = diagnosticsToRanges(DOC, [diag("warning", [2, 1], [2, 7])]);
    expect(r).toEqual([{ from: 12, to: 18, severity: "warning" }]);
  });

  it("maps a multi-line span across line boundaries", () => {
    // line 1 col 7 ("world") to line 2 col 7 ("second")
    // from = 6, to = 12 + 6 = 18
    const r = diagnosticsToRanges(DOC, [diag("error", [1, 7], [2, 7])]);
    expect(r).toEqual([{ from: 6, to: 18, severity: "error" }]);
  });

  it("skips diagnostics with no span", () => {
    const r = diagnosticsToRanges(DOC, [diag("error", null)]);
    expect(r).toEqual([]);
  });

  it("clamps columns past the end of a line to the line length", () => {
    // line 3 "third" is 5 chars; col 99 clamps to end of doc (offset 29)
    const r = diagnosticsToRanges(DOC, [diag("warning", [3, 1], [3, 99])]);
    expect(r).toEqual([{ from: 24, to: 29, severity: "warning" }]);
  });

  it("clamps lines past the end of the document", () => {
    // line 99 does not exist -> clamp to last line; produce a safe range
    const r = diagnosticsToRanges(DOC, [diag("error", [99, 1], [99, 3])]);
    expect(r).toHaveLength(1);
    const only = r[0]!;
    expect(only.from).toBeGreaterThanOrEqual(0);
    expect(only.to).toBeLessThanOrEqual(DOC.length);
    expect(only.from).toBeLessThanOrEqual(only.to);
    expect(only.severity).toBe("error");
  });

  it("preserves order and severity for multiple diagnostics", () => {
    const r = diagnosticsToRanges(DOC, [
      diag("error", [1, 1], [1, 6]),
      diag("warning", [2, 1], [2, 7]),
    ]);
    expect(r).toEqual([
      { from: 0, to: 5, severity: "error" },
      { from: 12, to: 18, severity: "warning" },
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(diagnosticsToRanges(DOC, [])).toEqual([]);
  });

  it("drops zero/negative-width ranges (from >= to) safely", () => {
    // an empty span (start == end) yields no paintable range
    const r = diagnosticsToRanges(DOC, [diag("error", [1, 3], [1, 3])]);
    expect(r).toEqual([]);
  });

  it("handles a span starting at column 1 of an empty document", () => {
    const r = diagnosticsToRanges("", [diag("error", [1, 1], [1, 5])]);
    // empty doc: everything clamps to offset 0; nothing to paint
    expect(r).toEqual([]);
  });
});

describe("diagnosticToPos (jump target)", () => {
  it("maps a diagnostic's start line/column to an absolute offset", () => {
    // line 2, column 1 → offset 12 (start of "second line" in DOC).
    expect(diagnosticToPos(DOC, diag("error", [2, 1]))).toBe(12);
    // line 1, column 3 → offset 2.
    expect(diagnosticToPos(DOC, diag("warning", [1, 3]))).toBe(2);
  });

  it("returns null for a span-less diagnostic", () => {
    expect(diagnosticToPos(DOC, diag("error", null))).toBeNull();
  });

  it("clamps an out-of-range line into the document", () => {
    const pos = diagnosticToPos(DOC, diag("error", [99, 1]));
    expect(pos).not.toBeNull();
    expect(pos!).toBeGreaterThanOrEqual(0);
    expect(pos!).toBeLessThanOrEqual(DOC.length);
  });
});
