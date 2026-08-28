/**
 * Roadmap #15.1 — Markdown → Typst core (the import wedge).
 *
 * A PURE, offline, framework-free deterministic converter from CommonMark-ish
 * Markdown to Typst source. Import is lossy by nature: anything we cannot map
 * faithfully is surfaced as an `UnmappedConstruct` rather than silently dropped.
 * These tests pin the common-subset mapping and the honesty contract.
 */
import { describe, it, expect } from "vitest";
import { markdownToTypst } from "./md-to-typst.js";

describe("markdownToTypst — empty / trivial", () => {
  it("maps empty input to empty typst with no unmapped constructs", () => {
    expect(markdownToTypst("")).toEqual({ typst: "", unmapped: [] });
  });

  it("maps whitespace-only input to empty typst with no unmapped constructs", () => {
    expect(markdownToTypst("   \n\n  ")).toEqual({ typst: "", unmapped: [] });
  });
});

describe("markdownToTypst — headings", () => {
  it("maps ATX headings #..###### to =..======", () => {
    const md = "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6";
    const { typst, unmapped } = markdownToTypst(md);
    expect(typst).toBe(
      "= H1\n\n== H2\n\n=== H3\n\n==== H4\n\n===== H5\n\n====== H6",
    );
    expect(unmapped).toEqual([]);
  });

  it("does not treat 7 hashes as a heading", () => {
    const { typst } = markdownToTypst("####### too many");
    // Falls through to a paragraph; the leading hashes are escaped literal text.
    expect(typst).not.toMatch(/^=/);
    expect(typst).toContain("too many");
  });
});

describe("markdownToTypst — inline emphasis and code", () => {
  it("maps **bold** and __bold__ to *bold*", () => {
    expect(markdownToTypst("**a** and __b__").typst).toBe("*a* and *b*");
  });

  it("maps *em* and _em_ to _em_", () => {
    expect(markdownToTypst("*a* and _b_").typst).toBe("_a_ and _b_");
  });

  it("maps inline `code` to Typst raw `code`", () => {
    expect(markdownToTypst("call `foo()` now").typst).toBe("call `foo()` now");
  });

  it("does not escape Typst specials inside inline code", () => {
    // Inside raw, # $ * _ must survive verbatim.
    expect(markdownToTypst("`a*b_c#d$`").typst).toBe("`a*b_c#d$`");
  });
});

describe("markdownToTypst — links", () => {
  it("maps [text](url) to #link(\"url\")[text]", () => {
    expect(markdownToTypst("see [Galley](https://x.dev) here").typst).toBe(
      'see #link("https://x.dev")[Galley] here',
    );
  });
});

describe("markdownToTypst — fenced code blocks", () => {
  it("maps a fenced block with a lang tag to a Typst raw block", () => {
    const md = "```js\nconst x = 1;\n```";
    const { typst, unmapped } = markdownToTypst(md);
    expect(typst).toBe("```js\nconst x = 1;\n```");
    expect(unmapped).toEqual([]);
  });

  it("preserves Typst specials verbatim inside a fenced block", () => {
    const md = "```\na # b $ c * d\n```";
    expect(markdownToTypst(md).typst).toBe("```\na # b $ c * d\n```");
  });

  // SEC: a crafted fenced body must never break out of the emitted Typst raw
  // block into active `#set`/`#show` Typst. The emitted fence is chosen strictly
  // longer than any backtick run in the body (same open/close), mirroring
  // latex-to-typst.ts:renderRawBlock.
  it("widens the fence so a ```-line in a ~~~ body cannot break out", () => {
    const md = "~~~\n```\n#set page(fill: red)\n~~~";
    // The 3-backtick body line is contained by a 4-backtick fence; the #set
    // line stays inert inside the raw block.
    expect(markdownToTypst(md).typst).toBe(
      "````\n```\n#set page(fill: red)\n````",
    );
  });

  it("escalates the fence past the longest backtick run in the body", () => {
    const md = "~~~\n````\n#show heading: it => it\n~~~";
    expect(markdownToTypst(md).typst).toBe(
      "`````\n````\n#show heading: it => it\n`````",
    );
  });

  it("strips backticks from the lang line so it can't carry a stray fence", () => {
    const md = "~~~ ```typst\n#set text(red)\n~~~";
    const { typst } = markdownToTypst(md);
    // The opening line is a clean fence + lang with no embedded backtick run
    // that could terminate the block.
    expect(typst).toBe("```typst\n#set text(red)\n```");
  });

  it("keeps a hostile lang tag (spaces/#set) on the opener line, never active", () => {
    // A lang tag carrying active-looking Typst stays as raw content on the
    // opening fence line — Typst parses the lang token then treats the rest as
    // raw — so it can't begin a standalone active `#set` line. (No backticks to
    // form a stray fence either.)
    const md = "~~~ typst #set page(fill: red)\nbody\n~~~";
    const { typst } = markdownToTypst(md);
    expect(typst).toBe("```typst #set page(fill: red)\nbody\n```");
    // The `#set` is never alone at column 0 (which would be active Typst).
    for (const line of typst.split("\n")) {
      if (line.startsWith("#set")) throw new Error(`active #set escaped: ${line}`);
    }
  });

  it("never lets a #-led line escape a raw block (fuzz)", () => {
    // A `~~~` outer fence captures backtick lines as body (a `~~~` body line
    // would close the source block, which is correct CommonMark, not a
    // breakout). Each crafted body hides a `#set`/`#show` after a backtick run.
    const bodies = [
      "```\n#set page(fill: red)",
      "````typst\n#show: x => x",
      "```\n```\n#set text(red)",
      "```````\n#set page(width: 1pt)",
      "a\n```\n#set page(width: 1pt)\nb",
    ];
    for (const body of bodies) {
      const md = `~~~\n${body}\n~~~`;
      const out = markdownToTypst(md).typst;
      const lines = out.split("\n");
      // First line is an all-backtick fence (run only); last line is identical.
      const fenceRun = lines[0]!.match(/^`+/)?.[0] ?? "";
      expect(fenceRun.length).toBeGreaterThanOrEqual(3);
      expect(lines[0]).toBe(fenceRun); // no lang here, so fence === whole line
      expect(lines[lines.length - 1]).toBe(fenceRun);
      // No interior line opens with the fence (which would close it early and
      // expose following lines as active Typst).
      for (const line of lines.slice(1, -1)) {
        expect(line.startsWith(fenceRun)).toBe(false);
      }
    }
  });
});

describe("markdownToTypst — lists", () => {
  it("maps unordered list markers -/*/+ to -", () => {
    const md = "- one\n* two\n+ three";
    expect(markdownToTypst(md).typst).toBe("- one\n- two\n- three");
  });

  it("maps ordered list 1. to +", () => {
    const md = "1. one\n2. two\n3. three";
    expect(markdownToTypst(md).typst).toBe("+ one\n+ two\n+ three");
  });

  it("applies inline mapping inside list items", () => {
    expect(markdownToTypst("- **bold** item").typst).toBe("- *bold* item");
  });

  // G2: nested lists. Markdown nests by indentation; Typst nests by indentation
  // too, so we preserve the structure (normalized to two spaces per level).
  it("nests an indented sub-list under its parent (2-space indent)", () => {
    const md = "- a\n  - b\n  - c\n- d";
    expect(markdownToTypst(md).typst).toBe("- a\n  - b\n  - c\n- d");
  });

  it("normalizes a 4-space indent to one nesting level", () => {
    const md = "- a\n    - b";
    expect(markdownToTypst(md).typst).toBe("- a\n  - b");
  });

  it("nests an ordered sub-list under an unordered item (and deeper)", () => {
    const md = "- a\n  1. b\n    - c";
    expect(markdownToTypst(md).typst).toBe("- a\n  + b\n    - c");
  });

  it("pops back out to a shallower level", () => {
    const md = "- a\n  - b\n- c";
    expect(markdownToTypst(md).typst).toBe("- a\n  - b\n- c");
  });
});

describe("markdownToTypst — math (G2)", () => {
  // Policy mirrors latex-to-typst: math is PASSED THROUGH (we never translate
  // LaTeX math into Typst math), but the body is neutralized so a crafted `#`/`$`
  // can't go active inside the emitted Typst math.
  it("passes inline $...$ math through as Typst math", () => {
    expect(markdownToTypst("Let $x^2$ here").typst).toBe("Let $x^2$ here");
  });

  it("neutralizes # and $ inside inline math", () => {
    expect(markdownToTypst("$a#b$").typst).toBe("$a\\#b$");
  });

  it("treats $5 and $10 as currency text, not math", () => {
    // The body would end with a space → not inline math; both dollars escape.
    expect(markdownToTypst("$5 and $10").typst).toBe("\\$5 and \\$10");
  });

  it("keeps an unterminated $ as an escaped literal", () => {
    expect(markdownToTypst("a $ b").typst).toBe("a \\$ b");
  });

  it("converts a single-line $$...$$ display block to Typst display math", () => {
    expect(markdownToTypst("$$x^2$$").typst).toBe("$ x^2 $");
  });

  it("converts a multi-line $$ display block to Typst display math", () => {
    expect(markdownToTypst("$$\nx^2 + y^2\n$$").typst).toBe("$ x^2 + y^2 $");
  });

  it("neutralizes a # inside a display block", () => {
    expect(markdownToTypst("$$a#b$$").typst).toBe("$ a\\#b $");
  });

  it("escapes a stray $ inside a display body so it can't close the math early", () => {
    // Security: a `$` within the body must not terminate the emitted Typst math
    // and let following content go active — it is neutralized to `\$`.
    expect(markdownToTypst("$$a$b$$").typst).toBe("$ a\\$b $");
  });
});

describe("markdownToTypst — blockquotes", () => {
  it("maps a > blockquote to a Typst #quote block", () => {
    expect(markdownToTypst("> hello").typst).toBe("#quote[hello]");
  });

  it("applies inline mapping inside a blockquote", () => {
    expect(markdownToTypst("> a **b**").typst).toBe("#quote[a *b*]");
  });
});

describe("markdownToTypst — horizontal rule", () => {
  it("maps --- to #line(length: 100%)", () => {
    expect(markdownToTypst("---").typst).toBe("#line(length: 100%)");
  });
});

describe("markdownToTypst — paragraphs and breaks", () => {
  it("preserves paragraph separation (blank line between)", () => {
    expect(markdownToTypst("para one\n\npara two").typst).toBe(
      "para one\n\npara two",
    );
  });

  it("maps a hard line break (two trailing spaces) to a Typst linebreak", () => {
    const { typst } = markdownToTypst("line one  \nline two");
    expect(typst).toBe("line one \\\nline two");
  });
});

describe("markdownToTypst — escaping Typst specials in text runs", () => {
  it("escapes #, $, *, _, @, <, backslash and backtick in plain text", () => {
    const md = "a # b $ c \\\\ d @ e < f";
    const { typst } = markdownToTypst(md);
    // Each special char gets a leading backslash so it round-trips literally.
    expect(typst).toBe("a \\# b \\$ c \\\\ d \\@ e \\< f");
  });
});

describe("markdownToTypst — honest unmapped reporting", () => {
  it("records a pipe table as an UnmappedConstruct with the right line", () => {
    const md = "intro\n\n| a | b |\n| - | - |\n| 1 | 2 |";
    const { unmapped } = markdownToTypst(md);
    expect(unmapped.length).toBeGreaterThanOrEqual(1);
    const table = unmapped.find((u) => u.kind === "table");
    expect(table).toBeDefined();
    // The first table row is on line 3 (1-based).
    expect(table?.line).toBe(3);
    expect(table?.snippet).toContain("| a | b |");
  });

  it("records an image as an UnmappedConstruct", () => {
    const md = "![alt](pic.png)";
    const { unmapped } = markdownToTypst(md);
    const img = unmapped.find((u) => u.kind === "image");
    expect(img).toBeDefined();
    expect(img?.line).toBe(1);
  });

  it("does not report unmapped constructs for fully-supported input", () => {
    const md = "# Title\n\nSome **bold** text.\n\n- a\n- b";
    expect(markdownToTypst(md).unmapped).toEqual([]);
  });
});
