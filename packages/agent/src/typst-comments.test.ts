/**
 * First-boot lint fix (#20.2): `stripTypstComments` blanks Typst comments (and
 * raw-block content) so the lexical `@ref`/`<label>` scan never sees them —
 * while PRESERVING every offset (same length, same newlines), so spans computed
 * against the stripped text are valid in the original.
 */
import { describe, it, expect } from "vitest";
import { stripTypstComments } from "./typst-comments.js";

describe("stripTypstComments", () => {
  it("preserves length and newlines exactly", () => {
    const src = "a // comment @x\nb /* c\nd */ e\n`raw @y`\n";
    const out = stripTypstComments(src);
    expect(out.length).toBe(src.length);
    for (let i = 0; i < src.length; i++) {
      if (src[i] === "\n") expect(out[i]).toBe("\n");
    }
  });

  it("blanks a line comment to the end of the line", () => {
    const src = "keep // gone @ref\nnext";
    const out = stripTypstComments(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain("@ref");
    expect(out.startsWith("keep ")).toBe(true);
    expect(out.endsWith("\nnext")).toBe(true);
  });

  it("blanks a block comment, including across lines", () => {
    const out = stripTypstComments("a /* @x\n@y */ b");
    expect(out).toBe("a      \n      b");
  });

  it("handles nested block comments (Typst nests them)", () => {
    const out = stripTypstComments("a /* outer /* inner */ still */ b");
    expect(out).not.toContain("inner");
    expect(out).not.toContain("still");
    expect(out.endsWith(" b")).toBe(true);
    expect(out.startsWith("a ")).toBe(true);
  });

  it("does NOT treat // inside a string as a comment", () => {
    const src = '#link("https://example.org") @broken';
    const out = stripTypstComments(src);
    expect(out).toContain("@broken"); // the ref after the URL string survives
    expect(out).toContain("https://example.org"); // string content untouched
  });

  it("blanks inline raw content (`…`)", () => {
    const out = stripTypstComments("see `@not-a-ref` here");
    expect(out).not.toContain("@not-a-ref");
    expect(out).toContain("see");
    expect(out).toContain("here");
  });

  it("blanks fenced raw content (```…```), across lines", () => {
    const out = stripTypstComments("a\n```typst\n@x in fence\n```\nb @real");
    expect(out).not.toContain("@x");
    expect(out).toContain("@real");
  });

  it("leaves plain markup (and real refs/labels) untouched", () => {
    const src = "Intro <intro> see @intro and @missing here";
    expect(stripTypstComments(src)).toBe(src);
  });

  it("an unterminated block comment blanks to EOF without throwing", () => {
    const out = stripTypstComments("a /* never closed @x");
    expect(out).not.toContain("@x");
    expect(out.length).toBe("a /* never closed @x".length);
  });
});
