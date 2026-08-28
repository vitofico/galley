import { describe, it, expect } from "vitest";
import type { Diagnostic, SourceSpan } from "@galley/shared";
import { quickFixForDiagnostic, quickFixAvailable } from "./quick-fix.js";

/**
 * Unit tests for the PURE quick-fix payload builder (roadmap #11.4b).
 *
 * This module is the pure CORE of the ambient quick-fix: given a diagnostic
 * plus the source it points into, it builds a SCOPED, natural-language agent
 * request (a `QuickFix`) the coordinator can hand to the existing agent run.
 * It NEVER invokes the agent, applies anything, or auto-fixes.
 */

/**
 * Build a SourceSpan from a source string and a substring to locate.
 * Computes UTF-16 offsets + 1-based line/column for `start` and `end`
 * (end exclusive), matching `@galley/shared`'s SourceSpan contract.
 */
function spanFor(source: string, needle: string): SourceSpan {
  const offset = source.indexOf(needle);
  if (offset < 0) throw new Error(`needle not found: ${needle}`);
  const endOffset = offset + needle.length;
  const posAt = (idx: number) => {
    const before = source.slice(0, idx);
    const line = before.split("\n").length;
    const lastNl = before.lastIndexOf("\n");
    const column = idx - lastNl; // 1-based: char after the newline is col 1
    return { line, column };
  };
  return {
    offset,
    endOffset,
    start: posAt(offset),
    end: posAt(endOffset),
  };
}

const SOURCE = [
  "= Title",
  "",
  "Some intro paragraph.",
  "#let x = unknownfn(3)",
  "More text below.",
  "Even more context lines here.",
  "Final line.",
].join("\n");

describe("quickFixAvailable", () => {
  it("is true when the diagnostic has a span", () => {
    const diag: Diagnostic = {
      severity: "error",
      message: "unknown function",
      span: spanFor(SOURCE, "unknownfn"),
    };
    expect(quickFixAvailable(diag)).toBe(true);
  });

  it("is false when the diagnostic has no span", () => {
    const diag: Diagnostic = {
      severity: "error",
      message: "missing main file",
    };
    expect(quickFixAvailable(diag)).toBe(false);
  });
});

describe("quickFixForDiagnostic", () => {
  it("builds a non-empty request quoting the message", () => {
    const diag: Diagnostic = {
      severity: "error",
      message: "unknown function `unknownfn`",
      span: spanFor(SOURCE, "unknownfn"),
    };
    const fix = quickFixForDiagnostic(diag, SOURCE);
    expect(typeof fix.request).toBe("string");
    expect(fix.request.length).toBeGreaterThan(0);
    expect(fix.request).toContain("unknown function `unknownfn`");
  });

  it("quotes the line/column from the span in the request", () => {
    const span = spanFor(SOURCE, "unknownfn");
    const diag: Diagnostic = {
      severity: "error",
      message: "unknown function",
      span,
    };
    const fix = quickFixForDiagnostic(diag, SOURCE);
    expect(fix.request).toContain(String(span.start.line));
    expect(fix.request).toContain(String(span.start.column));
  });

  it("includes the offending snippet (the spanned line) in the request and context", () => {
    const diag: Diagnostic = {
      severity: "error",
      message: "unknown function",
      span: spanFor(SOURCE, "unknownfn"),
    };
    const fix = quickFixForDiagnostic(diag, SOURCE);
    expect(fix.contextSnippet).toContain("#let x = unknownfn(3)");
    expect(fix.request).toContain("#let x = unknownfn(3)");
  });

  it("includes hints when present", () => {
    const diag: Diagnostic = {
      severity: "error",
      message: "unknown function",
      span: spanFor(SOURCE, "unknownfn"),
      hints: ["did you mean `unknown`?", "check your imports"],
    };
    const fix = quickFixForDiagnostic(diag, SOURCE);
    expect(fix.request).toContain("did you mean `unknown`?");
    expect(fix.request).toContain("check your imports");
  });

  it("omits a hints section when there are no hints", () => {
    const diag: Diagnostic = {
      severity: "error",
      message: "unknown function",
      span: spanFor(SOURCE, "unknownfn"),
    };
    const fix = quickFixForDiagnostic(diag, SOURCE);
    // With no hints, the word "hint" should not leak into the request.
    expect(fix.request.toLowerCase()).not.toContain("hint");
  });

  it("respects contextLines: more lines yields a longer snippet", () => {
    const diag: Diagnostic = {
      severity: "error",
      message: "unknown function",
      span: spanFor(SOURCE, "unknownfn"),
    };
    const few = quickFixForDiagnostic(diag, SOURCE, { contextLines: 0 });
    const many = quickFixForDiagnostic(diag, SOURCE, { contextLines: 3 });
    expect(few.contextSnippet.split("\n").length).toBeLessThan(
      many.contextSnippet.split("\n").length,
    );
    // contextLines: 0 → just the offending line itself.
    expect(few.contextSnippet).toBe("#let x = unknownfn(3)");
  });

  it("defaults to 2 context lines on each side", () => {
    const diag: Diagnostic = {
      severity: "error",
      message: "unknown function",
      span: spanFor(SOURCE, "unknownfn"),
    };
    const fix = quickFixForDiagnostic(diag, SOURCE);
    // The offending line is line 4 (1-based); ±2 → lines 2..6 → 5 lines.
    const lines = fix.contextSnippet.split("\n");
    expect(lines.length).toBe(5);
    expect(lines[0]).toBe(""); // line 2 (blank)
    expect(lines[lines.length - 1]).toBe("Even more context lines here."); // line 6
  });

  it("handles a multi-line span (snippet covers every spanned line)", () => {
    const multiSource = [
      "intro",
      "#table(",
      "  columns: 2,",
      "  bad-arg: 1,",
      ")",
      "outro",
    ].join("\n");
    const span = spanFor(multiSource, "#table(\n  columns: 2,\n  bad-arg: 1,\n)");
    const diag: Diagnostic = {
      severity: "error",
      message: "unexpected argument",
      span,
    };
    const fix = quickFixForDiagnostic(diag, multiSource, { contextLines: 0 });
    expect(fix.contextSnippet).toContain("#table(");
    expect(fix.contextSnippet).toContain("bad-arg: 1,");
    expect(fix.contextSnippet).toContain(")");
    // All four spanned lines present, no surrounding context.
    expect(fix.contextSnippet.split("\n").length).toBe(4);
  });

  it("returns the original diagnostic unchanged on the QuickFix", () => {
    const diag: Diagnostic = {
      severity: "warning",
      message: "deprecated",
      span: spanFor(SOURCE, "unknownfn"),
    };
    const fix = quickFixForDiagnostic(diag, SOURCE);
    expect(fix.diagnostic).toBe(diag);
  });

  it("instructs the agent to keep all other content unchanged", () => {
    const diag: Diagnostic = {
      severity: "error",
      message: "unknown function",
      span: spanFor(SOURCE, "unknownfn"),
    };
    const fix = quickFixForDiagnostic(diag, SOURCE);
    expect(fix.request.toLowerCase()).toContain("unchanged");
  });
});
