import { describe, it, expect } from "vitest";
import { crossFileRefDiagnostics } from "@galley/agent";
import type { Diagnostic, SourceSpan } from "@galley/shared";
import { dropPackagePathRefs } from "./ref-lint.js";

/**
 * Unit tests for `dropPackagePathRefs` (#13 follow-up) — the shell-side filter
 * that removes the agent-core's `@namespace/…` package-path FALSE POSITIVES from
 * the broken-ref lint, while leaving genuine unknown-reference warnings intact.
 */

/** Build a single-doc ref-lint diagnostic set the way the shells do. */
function lint(source: string): Diagnostic[] {
  return crossFileRefDiagnostics([{ path: "", text: source }], []);
}

describe("dropPackagePathRefs", () => {
  it("drops an @preview package import that the lexer mis-reads as a ref", () => {
    const source = '#import "@preview/cetz:0.2.2"\n= Needs a package';
    // The raw lint flags `@preview` (the scanner stops the name at `/`).
    const raw = lint(source);
    expect(raw.some((d) => d.message.includes("@preview"))).toBe(true);
    // The filter removes it — the ref token is immediately followed by `/`.
    const filtered = dropPackagePathRefs(source, raw);
    expect(filtered.some((d) => d.message.includes("@preview"))).toBe(false);
    expect(filtered).toHaveLength(0);
  });

  it("keeps a genuine unknown cross-reference", () => {
    const source = "See @missingref for details.";
    const raw = lint(source);
    expect(raw).toHaveLength(1);
    const filtered = dropPackagePathRefs(source, raw);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.message).toContain("@missingref");
  });

  it("keeps a real ref but drops a package path in the same doc", () => {
    const source = '#import "@preview/cetz:0.2.2"\nSee @missingref.';
    const filtered = dropPackagePathRefs(source, lint(source));
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.message).toContain("@missingref");
  });

  it("passes through diagnostics with no span untouched", () => {
    const spanless: Diagnostic = { severity: "error", message: "boom" };
    expect(dropPackagePathRefs("anything", [spanless])).toEqual([spanless]);
  });

  it("does not drop a ref that ends the document (no trailing char)", () => {
    const source = "Trailing @loose";
    const filtered = dropPackagePathRefs(source, lint(source));
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.message).toContain("@loose");
  });

  it("ignores a `/` that is not adjacent to the ref token", () => {
    // The ref name ends at the space; the `/` two chars later must not match.
    const source = "See @ref and a / slash.";
    const filtered = dropPackagePathRefs(source, lint(source));
    expect(filtered.some((d) => d.message.includes("@ref"))).toBe(true);
  });

  // Defensive: a hand-built span with a known endOffset followed by `/`.
  it("drops by endOffset adjacency precisely", () => {
    const source = "xx@pkg/yy";
    const span: SourceSpan = {
      offset: 2,
      endOffset: 6, // just past `@pkg` -> source[6] === "/"
      start: { line: 1, column: 3 },
      end: { line: 1, column: 7 },
    };
    const d: Diagnostic = { severity: "warning", message: "unknown reference @pkg", span };
    expect(dropPackagePathRefs(source, [d])).toHaveLength(0);
  });
});
