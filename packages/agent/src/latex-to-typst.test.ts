/**
 * Roadmap #15.2: LaTeX → Typst common-subset structural converter. These tests
 * pin the wedge — deterministic mapping of the common document subset, verbatim
 * pass-through of inline math, and HONEST reporting of everything unconverted
 * (the agent loop repairs the rest). PURE, offline, dependency-free.
 */
import { describe, it, expect } from "vitest";
import { latexToTypst, escapeTypstString, escapeTypstComment } from "./latex-to-typst.js";

describe("latexToTypst — headings", () => {
  it("maps section/subsection/subsubsection to =/==/===", () => {
    const { typst } = latexToTypst(
      "\\section{Intro}\n\\subsection{Background}\n\\subsubsection{Detail}",
    );
    expect(typst).toContain("= Intro");
    expect(typst).toContain("== Background");
    expect(typst).toContain("=== Detail");
  });
});

describe("latexToTypst — inline markup", () => {
  it("maps textbf to *…*", () => {
    expect(latexToTypst("\\textbf{bold}").typst).toContain("*bold*");
  });

  it("maps textit and emph to _…_", () => {
    expect(latexToTypst("\\textit{a}").typst).toContain("_a_");
    expect(latexToTypst("\\emph{b}").typst).toContain("_b_");
  });

  it("maps texttt to backtick raw", () => {
    expect(latexToTypst("\\texttt{code}").typst).toContain("`code`");
  });

  it("widens the texttt fence so an interior backtick can't break out", () => {
    const { typst } = latexToTypst("\\texttt{a`b}");
    // A single-backtick span would close early at the interior `; we must emit a
    // longer fence (>=2 backticks) that preserves the interior backtick.
    expect(typst).toContain("``a`b``");
    // plain bodies still use the single-backtick form.
    expect(latexToTypst("\\texttt{x}").typst).toContain("`x`");
  });

  it("maps a line break \\\\ to a Typst line break", () => {
    const { typst } = latexToTypst("line one \\\\ line two");
    expect(typst).toContain("\\");
    expect(typst).toContain("line one");
    expect(typst).toContain("line two");
  });

  it("handles nested markup inside a heading", () => {
    const { typst } = latexToTypst("\\section{A \\textbf{B} C}");
    expect(typst).toContain("= A *B* C");
  });
});

describe("latexToTypst — lists", () => {
  it("maps itemize \\item to - bullets", () => {
    const src = "\\begin{itemize}\n\\item first\n\\item second\n\\end{itemize}";
    const { typst } = latexToTypst(src);
    expect(typst).toContain("- first");
    expect(typst).toContain("- second");
  });

  it("maps enumerate \\item to + bullets", () => {
    const src = "\\begin{enumerate}\n\\item one\n\\item two\n\\end{enumerate}";
    const { typst } = latexToTypst(src);
    expect(typst).toContain("+ one");
    expect(typst).toContain("+ two");
  });
});

describe("latexToTypst — math", () => {
  it("passes inline $...$ through verbatim", () => {
    const { typst } = latexToTypst("Euler: $e^{i\\pi} + 1 = 0$ done");
    expect(typst).toContain("$e^{i\\pi} + 1 = 0$");
  });

  it("does not escape special chars inside inline math", () => {
    const { typst } = latexToTypst("$a_b * c$");
    expect(typst).toContain("$a_b * c$");
  });

  it("maps display \\[...\\] to a Typst block equation", () => {
    const { typst } = latexToTypst("\\[ x^2 + y^2 = z^2 \\]");
    expect(typst).toContain("$ x^2 + y^2 = z^2 $");
  });

  it("maps an equation environment to a Typst block equation", () => {
    const { typst } = latexToTypst("\\begin{equation}\nE = mc^2\n\\end{equation}");
    expect(typst).toContain("$");
    expect(typst).toContain("E = mc^2");
  });

  it("lifts \\label out of an equation into a Typst post-block label (G6)", () => {
    const { typst } = latexToTypst(
      "\\begin{equation}\n  \\label{eq:gap}\n  E = mc^2\n\\end{equation}",
    );
    expect(typst).toBe("$ E = mc^2 $ <eq:gap>");
  });

  it("lifts \\label out of a \\[...\\] display block (G6)", () => {
    const { typst } = latexToTypst("\\[ x^2 = y \\label{eq:sq} \\]");
    expect(typst).toBe("$ x^2 = y $ <eq:sq>");
  });

  it("lifts \\label out of displaymath (G6)", () => {
    const { typst } = latexToTypst(
      "\\begin{displaymath}\nx = 1 \\label{eq.dot:1-a}\n\\end{displaymath}",
    );
    expect(typst).toBe("$ x = 1 $ <eq.dot:1-a>");
  });

  it("a label-free equation is byte-identical (G6 additive — no regression)", () => {
    const { typst } = latexToTypst("\\begin{equation}\nE = mc^2\n\\end{equation}");
    expect(typst).toBe("$ E = mc^2 $");
  });

  it("drops a label with an unsafe key rather than injecting it (G6 safety)", () => {
    const { typst } = latexToTypst("\\begin{equation}\nx \\label{bad>key}\n\\end{equation}");
    // The unsafe `>` key is NOT emitted as a label, but it IS still stripped
    // from the math body (it would otherwise be literal junk).
    expect(typst).toBe("$ x $");
    expect(typst).not.toContain("<bad>");
  });

  it("does NOT lift a label out of inline $...$ math (G6 scope — display only)", () => {
    const { typst } = latexToTypst("see $a = b \\label{x}$ here");
    // Inline math is untouched; the label stays inside the inline body.
    expect(typst).toContain("$a = b \\label{x}$");
  });
});

describe("latexToTypst — preamble & document", () => {
  it("strips the preamble before \\begin{document}", () => {
    const src = [
      "\\documentclass{article}",
      "\\usepackage{amsmath}",
      "\\begin{document}",
      "\\section{Body}",
      "\\end{document}",
    ].join("\n");
    const { typst } = latexToTypst(src);
    expect(typst).toContain("= Body");
    expect(typst).not.toContain("documentclass");
    expect(typst).not.toContain("usepackage");
    expect(typst).not.toContain("\\end{document}");
  });

  it("converts comments to Typst // (or drops them) without leaking %", () => {
    const { typst } = latexToTypst("real text % a trailing comment");
    expect(typst).toContain("real text");
    expect(typst).not.toContain("% a trailing comment");
  });
});

describe("latexToTypst — escaping plain text", () => {
  it("escapes Typst-special characters in plain runs", () => {
    const { typst } = latexToTypst("cost is #5 and a*b and x_y and @ref and a<b and `tick`");
    expect(typst).toContain("\\#5");
    expect(typst).toContain("a\\*b");
    expect(typst).toContain("x\\_y");
    expect(typst).toContain("\\@ref");
    expect(typst).toContain("a\\<b");
    expect(typst).toContain("\\`tick\\`");
  });
});

describe("latexToTypst — unconverted catalog (honest)", () => {
  it("records an unknown command and does not silently drop it", () => {
    const { typst, unconverted } = latexToTypst("before \\todo{fix me} after");
    const item = unconverted.find((u) => u.snippet.includes("todo"));
    expect(item).toBeDefined();
    expect(item!.kind).toBe("unknown-command");
    expect(item!.line).toBe(1);
    // The raw text survives somewhere (not silently lost).
    expect(typst).toContain("todo");
  });

  it("reports the correct 1-based line for an unknown command", () => {
    const src = "\\section{Title}\nplain line\n\\unknownmacro{x}";
    const { unconverted } = latexToTypst(src);
    const item = unconverted.find((u) => u.snippet.includes("unknownmacro"));
    expect(item).toBeDefined();
    expect(item!.line).toBe(3);
  });

  it("records a tabular environment as unconverted", () => {
    const src = "\\begin{tabular}{ll}\na & b \\\\\nc & d \\\\\n\\end{tabular}";
    const { unconverted } = latexToTypst(src);
    const item = unconverted.find((u) => u.kind === "environment" || u.snippet.includes("tabular"));
    expect(item).toBeDefined();
    expect(item!.snippet).toContain("tabular");
  });

  it("records \\cite as unconverted and leaves a marker", () => {
    const { typst, unconverted } = latexToTypst("As shown \\cite{smith2020}.");
    expect(unconverted.some((u) => u.snippet.includes("cite"))).toBe(true);
    expect(typst).toContain("smith2020");
  });
});

describe("latexToTypst — edge cases", () => {
  it("returns empty typst and no unconverted for empty input", () => {
    const { typst, unconverted } = latexToTypst("");
    expect(typst.trim()).toBe("");
    expect(unconverted).toEqual([]);
  });

  it("passes plain prose through unchanged (no special chars)", () => {
    const { typst } = latexToTypst("Just some ordinary words.");
    expect(typst).toContain("Just some ordinary words.");
  });
});

// ---------------------------------------------------------------------------
// G3: verbatim → Typst raw block
// ---------------------------------------------------------------------------
describe("latexToTypst — verbatim → raw block (G3)", () => {
  it("wraps a verbatim body in a fenced raw block, content literal", () => {
    const src = "\\begin{verbatim}\nfor d in 3 4 5; do\n  run.py --degree $d\ndone\n\\end{verbatim}";
    const { typst, unconverted } = latexToTypst(src);
    expect(typst).toBe("```\nfor d in 3 4 5; do\n  run.py --degree $d\ndone\n```");
    // The body is LITERAL — no math escaping, no inline conversion.
    expect(typst).toContain("--degree $d"); // raw `$`, NOT `\$`
    // Not recorded as unconverted.
    expect(unconverted.filter((u) => u.kind === "environment")).toHaveLength(0);
  });

  it("treats lstlisting the same as verbatim", () => {
    const src = "\\begin{lstlisting}\nint x = #5;\n\\end{lstlisting}";
    const { typst, unconverted } = latexToTypst(src);
    expect(typst).toBe("```\nint x = #5;\n```");
    expect(unconverted.filter((u) => u.kind === "environment")).toHaveLength(0);
  });

  it("preserves an empty verbatim body as an empty raw block", () => {
    const { typst } = latexToTypst("\\begin{verbatim}\n\\end{verbatim}");
    expect(typst).toBe("```\n\n```");
  });

  it("guards a body containing a triple-backtick run with a longer fence", () => {
    // The body itself contains ``` — the fence must be LONGER than any backtick
    // run inside so the body cannot break out of the raw block.
    const src = "\\begin{verbatim}\nmd: ```code```\n\\end{verbatim}";
    const { typst } = latexToTypst(src);
    expect(typst).toBe("````\nmd: ```code```\n````");
  });

  it("guards an even longer backtick run with a still-longer fence", () => {
    const src = "\\begin{verbatim}\n````\n\\end{verbatim}";
    const { typst } = latexToTypst(src);
    expect(typst).toBe("`````\n````\n`````");
  });
});

// ---------------------------------------------------------------------------
// G3: figure / table floats → #figure(...)
// ---------------------------------------------------------------------------
describe("latexToTypst — figure/table → #figure (G3)", () => {
  it("converts a figure with includegraphics + caption + label", () => {
    const src = [
      "\\begin{figure}[t]",
      "  \\centering",
      "  \\includegraphics[width=0.7\\linewidth]{figures/gap}",
      "  \\caption{Histogram of values.}",
      "  \\label{fig:gap}",
      "\\end{figure}",
    ].join("\n");
    const { typst, unconverted } = latexToTypst(src);
    expect(typst).toBe(
      '#figure(\n  image("figures/gap"),\n  caption: [Histogram of values.],\n) <fig:gap>',
    );
    expect(unconverted.filter((u) => u.kind === "environment")).toHaveLength(0);
  });

  it("strips the includegraphics optional [...] options from the path", () => {
    const src = "\\begin{figure}\n\\includegraphics[scale=0.5]{a/b.png}\n\\end{figure}";
    const { typst } = latexToTypst(src);
    expect(typst).toContain('image("a/b.png")');
    expect(typst).not.toContain("scale=0.5");
  });

  it("runs inline conversion on the caption text", () => {
    const src = [
      "\\begin{figure}",
      "  \\includegraphics{x.png}",
      "  \\caption{A \\textbf{bold} caption with $x^2$.}",
      "\\end{figure}",
    ].join("\n");
    const { typst } = latexToTypst(src);
    expect(typst).toContain("caption: [A *bold* caption with $x^2$.]");
  });

  it("emits a figure with no caption and no label cleanly", () => {
    const src = "\\begin{figure}\n\\includegraphics{x.png}\n\\end{figure}";
    const { typst } = latexToTypst(src);
    expect(typst).toBe('#figure(\n  image("x.png"),\n)');
  });

  it("converts a table float with includegraphics", () => {
    const src = [
      "\\begin{table}",
      "  \\includegraphics{t.png}",
      "  \\caption{Fitted constants.}",
      "\\end{table}",
    ].join("\n");
    const { typst } = latexToTypst(src);
    expect(typst).toBe('#figure(\n  image("t.png"),\n  caption: [Fitted constants.],\n)');
  });

  it("routes the image path through escapeTypstString (no injection)", () => {
    const src = '\\begin{figure}\n\\includegraphics{a"b.png}\n\\end{figure}';
    const { typst } = latexToTypst(src);
    expect(typst).toContain('image("a\\"b.png")');
  });

  it("falls back to a comment for a figure WITHOUT includegraphics", () => {
    // A tabular-only table/figure has no image body → keep the comment behavior
    // and still record it unconverted (do not emit an empty #figure).
    const src = [
      "\\begin{table}",
      "  \\begin{tabular}{ll}a & b\\\\\\end{tabular}",
      "  \\caption{No image here.}",
      "\\end{table}",
    ].join("\n");
    const { typst, unconverted } = latexToTypst(src);
    expect(typst).not.toContain("#figure");
    expect(typst).toContain("// \\begin{table}");
    expect(unconverted.filter((u) => u.kind === "environment")).toHaveLength(1);
  });

  it("keeps align as a reported comment (out of scope — agent repairs math)", () => {
    const src = "\\begin{align}\nx &= y \\\\\n\\end{align}";
    const { typst, unconverted } = latexToTypst(src);
    expect(typst).toContain("// \\begin{align}");
    expect(unconverted.filter((u) => u.kind === "environment")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// #22.2 SEC-22.2-7: unmatched environments must not be quadratic
// ---------------------------------------------------------------------------
describe("latexToTypst — unmatched environments are bounded (SEC-22.2-7)", () => {
  // Measure the converter's *work* (not wall-clock) by counting operations via
  // input scaling: a hostile pile of UNMATCHED `\begin{env}` lines used to cost
  // O(k·n) — each opener scanning to EOF. With the per-env pairing table the
  // total cost is linear, so doubling the input must NOT super-linearly inflate
  // the work. We assert completion + linear scaling, not a timer (non-flaky).
  function elapsed(k: number): number {
    // All the SAME env name — the worst case (the old forward scan re-walked the
    // whole file for each of the k unmatched openers).
    const tex = Array.from({ length: k }, () => "\\begin{equation}").join("\n");
    const t0 = performance.now();
    const { typst } = latexToTypst(tex);
    const dt = performance.now() - t0;
    expect(typst).toBeTypeOf("string"); // completed, no throw/hang
    return dt;
  }

  it("converts thousands of unmatched same-name begins without blowing up", () => {
    // All the SAME env name — the worst case for the old O(k·n) forward scan.
    // Use a NON-math env so each unmatched opener is reported (and kept verbatim).
    const k = 8000;
    const tex = Array.from({ length: k }, () => "\\begin{tabular}").join("\n");
    const { typst, unconverted } = latexToTypst(tex);
    expect(typst).toBeTypeOf("string");
    // Each unmatched opener is treated as its own one-line (unconverted) env.
    expect(unconverted.length).toBe(k);
  });

  it("scales roughly linearly, not quadratically, in the unmatched count", () => {
    // Warm up the JIT, then compare 2N vs N. A quadratic algorithm would make
    // the ratio ~4x; linear should stay well under. Generous bound to stay
    // non-flaky on a loaded CI box while still catching an O(k²) regression.
    elapsed(2000);
    const small = Math.max(elapsed(4000), 0.5);
    const big = elapsed(8000); // 2x the input
    expect(big / small).toBeLessThan(8); // linear ⇒ ~2x; quadratic ⇒ ~4-16x
  });

  // DISTINCT unmatched env names: the GPT-round gap. A per-name lazy full-file
  // rescan would rescan the whole document once PER unique name → O(k·n) again.
  // The single global marker scan must keep this near-linear in k.
  function elapsedDistinct(k: number): number {
    const tex = Array.from({ length: k }, (_, i) => `\\begin{e${i}}`).join("\n");
    const t0 = performance.now();
    const { typst, unconverted } = latexToTypst(tex);
    const dt = performance.now() - t0;
    expect(typst).toBeTypeOf("string"); // completed, no throw/hang
    // Each distinct unmatched opener is its own one-line (unconverted) env.
    expect(unconverted.length).toBe(k);
    return dt;
  }

  it("converts thousands of unmatched DISTINCT-name begins without blowing up", () => {
    // k DISTINCT names — the case the same-name memo did NOT cover. With a global
    // marker scan this is O(n + markers), not O(k·n) (1000 names × 1000 lines).
    elapsedDistinct(4000);
  });

  it("scales linearly in the count of DISTINCT unmatched env names", () => {
    // The regression guard for the GPT-round finding: each unique name must NOT
    // trigger a fresh full-document scan. Quadratic ⇒ ~4x for a 2x input.
    elapsedDistinct(2000); // warm up
    const small = Math.max(elapsedDistinct(4000), 0.5);
    const big = elapsedDistinct(8000); // 2x the input
    expect(big / small).toBeLessThan(8); // linear ⇒ ~2x; quadratic ⇒ ~4-16x
  });

  it("a valid matched environment still converts identically", () => {
    // Byte-for-byte guard: the memo must not change valid-input output.
    const { typst } = latexToTypst("\\begin{itemize}\n\\item one\n\\item two\n\\end{itemize}");
    expect(typst).toBe("- one\n- two");
  });

  it("nested distinct envs resolve their ends correctly (global /g extraction)", () => {
    // A `quote` env wrapping a `verbatim` env: the global marker scan must index
    // BOTH names so `findEnvEnd("quote", …)` pairs with the OUTER `\end{quote}`
    // (line 5), not the inner `\end{verbatim}` — exactly as the forward scan did.
    const tex = "\\begin{quote}\n\\begin{verbatim}\ncode\n\\end{verbatim}\ntext\n\\end{quote}";
    const { typst } = latexToTypst(tex);
    // `quote` is non-list/non-math → the whole block (through \end{quote}) is kept
    // verbatim as comments, proving the outer end was found.
    expect(typst).toContain("// \\begin{quote}");
    expect(typst).toContain("// \\end{quote}");
    expect(typst).toContain("// \\begin{verbatim}");
  });

  it("nested same-name environments pair innermost-first (matches forward scan)", () => {
    const tex = "\\begin{equation}\n\\begin{equation}\nx\n\\end{equation}\n\\end{equation}";
    const { typst } = latexToTypst(tex);
    // Outer equation env wraps the whole block as a single `$ … $` (math env).
    expect(typst.startsWith("$ ")).toBe(true);
    expect(typst.endsWith(" $")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #22.2 SEC-22.2-8: generated Typst output is escaped
// ---------------------------------------------------------------------------
describe("escapeTypstString / escapeTypstComment (SEC-22.2-8)", () => {
  it("escapes quotes and backslashes for string literals", () => {
    expect(escapeTypstString('a"b')).toBe('a\\"b');
    expect(escapeTypstString("a\\b")).toBe("a\\\\b");
    // Backslash escaped BEFORE quote so an injected `\"` does not double-escape.
    expect(escapeTypstString('\\"')).toBe('\\\\\\"');
  });

  it("is a no-op for strings with no special characters", () => {
    expect(escapeTypstString("/figures/diagram.typ")).toBe("/figures/diagram.typ");
  });

  it("neutralizes block-comment delimiters", () => {
    expect(escapeTypstComment("end */ #panic()")).toBe("end * / #panic()");
    expect(escapeTypstComment("/* nested")).toBe("/ * nested");
  });

  it("is a no-op for comment bodies with no delimiter", () => {
    expect(escapeTypstComment("smith2020")).toBe("smith2020");
  });

  it("a hostile cite arg cannot break out of the TODO comment", () => {
    const { typst } = latexToTypst("\\cite{a */ #read(\"/etc/passwd\")}");
    // The injected `*/` is neutralized — no comment-closing `*/` precedes the payload.
    const marker = typst.slice(typst.indexOf("/* TODO"));
    expect(marker.indexOf("*/")).toBe(marker.lastIndexOf("*/")); // exactly one close
    expect(marker.includes("* /")).toBe(true); // the injected one was neutralized
  });
});
