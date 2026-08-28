import { describe, it, expect } from "vitest";
import { composeReviseRequest, selectionFromEditor } from "./revise-selection.js";

/**
 * Unit tests for the selection-scoped revise helpers (roadmap 11.8b).
 *
 * Two PURE pieces (no React/DOM):
 *   - `composeReviseRequest` builds a SCOPED agent request from a selected region
 *     + the user's instruction. It mirrors the #11.4b quick-fix payload builder
 *     but scopes the edit to an exact line range and quotes the region safely so
 *     Typst syntax in the selection can't be confused with the instruction. The
 *     run still flows through the normal scratch→diff→Accept gate (this module
 *     NEVER invokes the agent or applies an edit).
 *   - `selectionFromEditor` derives `{ from, to, text, startLine, endLine }` from
 *     a CodeMirror-like `{ doc, selection }` snapshot, so the line math is
 *     testable without a live `EditorView`.
 */

describe("composeReviseRequest", () => {
  it("scopes a single-line selection with its 1-based line and the instruction", () => {
    const request = composeReviseRequest({
      selectedText: "The cat sat on the mat.",
      startLine: 5,
      endLine: 5,
      instruction: "make it shorter",
    });

    // The instruction is carried verbatim.
    expect(request).toContain("make it shorter");
    // Single-line wording: "line 5", not a range.
    expect(request).toContain("line 5");
    expect(request).not.toMatch(/lines 5\b/);
    // The exact region is quoted.
    expect(request).toContain("The cat sat on the mat.");
    // The agent is told to leave the rest of the document unchanged.
    expect(request).toMatch(/only that region|only this region|rest of the document/i);
  });

  it("uses range wording for a multi-line selection", () => {
    const request = composeReviseRequest({
      selectedText: "First line.\nSecond line.\nThird line.",
      startLine: 12,
      endLine: 14,
      instruction: "tighten the prose",
    });

    expect(request).toContain("lines 12-14");
    expect(request).toContain("tighten the prose");
    expect(request).toContain("Second line.");
  });

  it("trims surrounding whitespace from the instruction", () => {
    const request = composeReviseRequest({
      selectedText: "Hello.",
      startLine: 1,
      endLine: 1,
      instruction: "   rephrase this   \n",
    });

    expect(request).toContain("rephrase this");
    expect(request).not.toContain("   rephrase this");
  });

  it("fences the region so backticks/fences inside it cannot break out", () => {
    const selectedText = "Here is code:\n```\n#let x = 1\n```\ndone";
    const request = composeReviseRequest({
      selectedText,
      startLine: 3,
      endLine: 7,
      instruction: "simplify",
    });

    // The whole region (including its inner ``` fence) survives verbatim.
    expect(request).toContain(selectedText);
    // The opening fence used to quote the region must be LONGER than any run of
    // backticks inside the region, so the inner ``` can't terminate it early.
    const openFence = request.slice(request.indexOf("`")).match(/^`+/)?.[0] ?? "";
    expect(openFence.length).toBeGreaterThanOrEqual(4);
  });

  it("is defensive when the instruction is empty (caller guards, but be total)", () => {
    const request = composeReviseRequest({
      selectedText: "Some text.",
      startLine: 2,
      endLine: 2,
      instruction: "",
    });

    // Still a usable, region-scoped request even with no instruction.
    expect(request).toContain("Some text.");
    expect(request).toContain("line 2");
    expect(typeof request).toBe("string");
    expect(request.length).toBeGreaterThan(0);
  });
});

describe("selectionFromEditor", () => {
  /** A minimal CodeMirror-like snapshot over a plain string. */
  function snapshot(source: string, from: number, to: number) {
    const lineAt = (offset: number) => {
      const clamped = Math.max(0, Math.min(offset, source.length));
      let number = 1;
      for (let i = 0; i < clamped; i++) if (source.charCodeAt(i) === 10) number++;
      return { number };
    };
    return {
      doc: {
        sliceString: (a: number, b: number) => source.slice(a, b),
        lineAt,
      },
      selection: { main: { from, to } },
    };
  }

  it("derives text and a 1-based line range for a single-line selection", () => {
    const source = "alpha\nbeta gamma delta\nepsilon";
    const from = source.indexOf("gamma");
    const to = from + "gamma".length;
    const sel = selectionFromEditor(snapshot(source, from, to));
    expect(sel).not.toBeNull();
    expect(sel!.text).toBe("gamma");
    expect(sel!.startLine).toBe(2);
    expect(sel!.endLine).toBe(2);
    expect(sel!.from).toBe(from);
    expect(sel!.to).toBe(to);
  });

  it("derives the spanning line range for a multi-line selection", () => {
    const source = "one\ntwo\nthree\nfour";
    const from = source.indexOf("two");
    const to = source.indexOf("three") + "three".length;
    const sel = selectionFromEditor(snapshot(source, from, to));
    expect(sel).not.toBeNull();
    expect(sel!.startLine).toBe(2);
    expect(sel!.endLine).toBe(3);
    expect(sel!.text).toBe("two\nthree");
  });

  it("returns null for an empty (collapsed) selection", () => {
    const source = "hello world";
    expect(selectionFromEditor(snapshot(source, 3, 3))).toBeNull();
  });

  it("normalizes a reversed selection (anchor after head)", () => {
    const source = "alpha beta";
    const sel = selectionFromEditor(snapshot(source, 9, 0));
    expect(sel).not.toBeNull();
    expect(sel!.from).toBe(0);
    expect(sel!.to).toBe(9);
    expect(sel!.text).toBe("alpha bet");
  });
});

describe("composeReviseRequest + selectionFromEditor (integration)", () => {
  it("the snapshot feeds straight into a scoped request", () => {
    const source = "Intro line.\nRevise me please.\nOutro line.";
    const from = source.indexOf("Revise");
    const to = from + "Revise me please.".length;
    const lineAt = (offset: number) => {
      let number = 1;
      for (let i = 0; i < offset; i++) if (source.charCodeAt(i) === 10) number++;
      return { number };
    };
    const sel = selectionFromEditor({
      doc: { sliceString: (a: number, b: number) => source.slice(a, b), lineAt },
      selection: { main: { from, to } },
    })!;
    const request = composeReviseRequest({
      selectedText: sel.text,
      startLine: sel.startLine,
      endLine: sel.endLine,
      instruction: "make it formal",
    });
    expect(request).toContain("Revise me please.");
    expect(request).toContain("line 2");
    expect(request).toContain("make it formal");
  });
});
