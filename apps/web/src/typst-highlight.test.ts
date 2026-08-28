import { describe, it, expect } from "vitest";
import { StringStream } from "@codemirror/language";
import { typstLanguage } from "./typst-highlight.js";

/**
 * These tests drive the `StreamLanguage` tokenizer directly: we pull the
 * normalised stream parser off the language, feed it representative Typst
 * source line-by-line, and assert the token name emitted at each position.
 *
 * Token names are the keys of the parser's `tokenTable` (which maps them to
 * `@lezer/highlight` tags). Asserting the name keeps the test independent of
 * how the tags are themed.
 */

// The public `StreamLanguage` keeps the normalised parser on `.streamParser`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parser: any = (typstLanguage as any).streamParser;

interface Tok {
  text: string;
  tag: string | null;
}

/** Tokenise a whole (multi-line) document, carrying state across lines. */
function tokenizeDoc(doc: string): Tok[][] {
  const state = parser.startState();
  const lines = doc.split("\n");
  const out: Tok[][] = [];
  for (const line of lines) {
    const stream = new StringStream(line, 2, 2);
    const toks: Tok[] = [];
    let guard = 0;
    if (line.length === 0) {
      // Blank line: many parsers expose `blankLine`; advance state if present.
      if (parser.blankLine) parser.blankLine(state, 2);
      out.push(toks);
      continue;
    }
    while (!stream.eol()) {
      const start = stream.pos;
      const tag = parser.token(stream, state) ?? null;
      if (stream.pos === start) {
        // Defensive: never loop forever if a branch fails to advance.
        stream.next();
      }
      toks.push({ text: stream.current(), tag });
      stream.start = stream.pos;
      if (++guard > 10000) throw new Error("tokenizer did not terminate");
    }
    out.push(toks);
  }
  return out;
}

/** Convenience: flatten a single-line tokenise. */
function tokenizeLine(line: string): Tok[] {
  return tokenizeDoc(line)[0] ?? [];
}

/** Index into a tokenised document, asserting the line exists. */
function lineAt(lines: Tok[][], i: number): Tok[] {
  const l = lines[i];
  if (!l) throw new Error(`no tokens for line ${i}`);
  return l;
}

/** Find the tag of the first token whose text contains `needle`. */
function tagOf(toks: Tok[], needle: string): string | null | undefined {
  return toks.find((t) => t.text.includes(needle))?.tag;
}

describe("typst-highlight — StreamLanguage tokenizer", () => {
  it("highlights ATX-style headings by level", () => {
    expect(tagOf(tokenizeLine("= Title"), "Title")).toBe("heading");
    expect(tagOf(tokenizeLine("== Sub"), "Sub")).toBe("heading");
    expect(tagOf(tokenizeLine("=== Deep"), "Deep")).toBe("heading");
    // A bare `=` not at line start is not a heading.
    expect(tagOf(tokenizeLine("a = b"), "=")).not.toBe("heading");
  });

  it("highlights strong and emphasis", () => {
    expect(tagOf(tokenizeLine("a *bold* b"), "*bold*")).toBe("strong");
    expect(tagOf(tokenizeLine("a _it_ b"), "_it_")).toBe("emphasis");
  });

  it("highlights inline math", () => {
    expect(tagOf(tokenizeLine("x $a + b$ y"), "$a + b$")).toBe("math");
  });

  it("carries BLOCK math across multiple lines", () => {
    const doc = "intro\n$\nsum_i x_i\n$\noutro";
    const lines = tokenizeDoc(doc);
    // Opening `$` on its own line.
    expect(tagOf(lineAt(lines, 1), "$")).toBe("math");
    // The inner line is still math even though it contains no `$`.
    expect(tagOf(lineAt(lines, 2), "sum_i")).toBe("math");
    // Closing `$`.
    expect(tagOf(lineAt(lines, 3), "$")).toBe("math");
    // After the block, normal content resumes (not math).
    expect(tagOf(lineAt(lines, 4), "outro")).not.toBe("math");
  });

  it("highlights code-mode keywords after #", () => {
    expect(tagOf(tokenizeLine("#let x = 1"), "let")).toBe("keyword");
    expect(tagOf(tokenizeLine("#set par(leading: 1em)"), "set")).toBe("keyword");
    expect(tagOf(tokenizeLine("#show heading: it => it"), "show")).toBe("keyword");
    expect(tagOf(tokenizeLine("#if x { } #else { }"), "if")).toBe("keyword");
    expect(tagOf(tokenizeLine("#for i in r { }"), "for")).toBe("keyword");
    expect(tagOf(tokenizeLine("#import \"x.typ\""), "import")).toBe("keyword");
  });

  it("highlights function-call names after # as functions", () => {
    const toks = tokenizeLine("#image(\"a.png\")");
    expect(tagOf(toks, "image")).toBe("function");
  });

  it("highlights strings inside code", () => {
    const toks = tokenizeLine("#import \"template.typ\"");
    expect(tagOf(toks, "\"template.typ\"")).toBe("string");
  });

  it("highlights inline raw with backticks", () => {
    expect(tagOf(tokenizeLine("use `code` here"), "`code`")).toBe("raw");
  });

  it("carries a fenced raw block across lines (with language tag)", () => {
    const doc = "before\n```rust\nfn main() {}\n```\nafter";
    const lines = tokenizeDoc(doc);
    // Fence open line is raw.
    expect(tagOf(lineAt(lines, 1), "```rust")).toBe("raw");
    // Inner code line is raw even though it has no backticks.
    expect(tagOf(lineAt(lines, 2), "fn main")).toBe("raw");
    // Closing fence is raw.
    expect(tagOf(lineAt(lines, 3), "```")).toBe("raw");
    // After the fence, normal content resumes.
    expect(tagOf(lineAt(lines, 4), "after")).not.toBe("raw");
  });

  it("treats an escaped dollar as escape, not the start of math", () => {
    const toks = tokenizeLine("price \\$5 only");
    expect(tagOf(toks, "\\$")).toBe("escape");
    // The rest of the line is NOT swallowed as math.
    expect(tagOf(toks, "only")).not.toBe("math");
  });

  it("treats escaped hash and backslash as escapes", () => {
    expect(tagOf(tokenizeLine("a \\# b"), "\\#")).toBe("escape");
    expect(tagOf(tokenizeLine("a \\\\ b"), "\\\\")).toBe("escape");
  });

  it("highlights labels and references", () => {
    expect(tagOf(tokenizeLine("see <my-label> ok"), "<my-label>")).toBe("labelName");
    expect(tagOf(tokenizeLine("see @my-ref ok"), "@my-ref")).toBe("labelName");
  });

  it("highlights list markers at line start", () => {
    expect(tagOf(tokenizeLine("- item"), "-")).toBe("list");
    expect(tagOf(tokenizeLine("+ item"), "+")).toBe("list");
    expect(tagOf(tokenizeLine("1. item"), "1.")).toBe("list");
  });

  it("highlights line and block comments", () => {
    expect(tagOf(tokenizeLine("// a comment"), "comment")).toBe("comment");
    const block = tokenizeDoc("/* multi\nline */ x");
    expect(tagOf(lineAt(block, 0), "multi")).toBe("comment");
    expect(tagOf(lineAt(block, 1), "line")).toBe("comment");
  });
});
