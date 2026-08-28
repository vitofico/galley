/**
 * Roadmap #22.2 — adversarial fuzz/property harness for the IMPORT-PARSER surface
 * (the hand-rolled, untrusted-input converters in `@galley/agent`).
 *
 * Threat model: a malicious `.tex` / `.md` / `.bib` / `.ris` that a user imports
 * must NOT hang the tab, exhaust CPU/stack (catastrophic backtracking, unbounded
 * recursion, billion-laughs-style expansion), or emit structurally-broken output.
 * Galley is local-first, so the blast radius is the user's own session — but a
 * hang/OOM on import is a real DoS.
 *
 * These cases are DETERMINISTIC (enumerated hostile inputs, never random) and FAST
 * (small-but-pathological inputs + a wall-clock bound), so the gate is reproducible.
 * Each asserts the parser FAILS SAFE: returns within a tight time budget, never
 * throws on garbage, and never produces unbounded output.
 *
 * The zip reader (`apps/web/src/components/import-project.ts`) has its own hostile
 * harness next to it (`import-project.fuzz.test.ts`) — it is the highest-risk
 * surface and lives in the web app.
 */
import { describe, it, expect } from "vitest";
import { latexToTypst } from "./latex-to-typst.js";
import { markdownToTypst } from "./md-to-typst.js";
import { parseBibtex, detectInputKind, toHayagriva, parseBibtex as _pb } from "./citation.js";
import { parseBibliography, citeKeysFromBibliography } from "./bibliography.js";
import { parseRis, importReferences, countRisRecords } from "./reference-import.js";
import { importLatexProject } from "./import-latex-project.js";

// ── Timing harness ───────────────────────────────────────────────────────────
// A hostile input must complete WELL under this bound. We use a generous 2s
// ceiling so the assertion fires on a true hang (seconds→minutes) without being
// flaky on a loaded CI box; in practice these all finish in single-digit ms.
const TIME_BUDGET_MS = 2000;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = Date.now();
  const value = fn();
  return { value, ms: Date.now() - t0 };
}

/** Run a sync parser on a hostile input and assert it is fast + non-throwing. */
function expectFastNoThrow<T>(label: string, fn: () => T): T {
  let out: T;
  const { value, ms } = timed(() => {
    out = fn();
    return out;
  });
  expect(ms, `${label} took ${ms}ms (budget ${TIME_BUDGET_MS}ms)`).toBeLessThan(
    TIME_BUDGET_MS,
  );
  return value;
}

// Repeat helper kept allocation-light for the big cases.
const rep = (s: string, n: number): string => s.repeat(n);

// ─────────────────────────────────────────────────────────────────────────────
// latexToTypst — deep nesting, unbalanced delimiters, pathological commands
// ─────────────────────────────────────────────────────────────────────────────
describe("fuzz: latexToTypst fails safe on hostile LaTeX", () => {
  it("deeply-nested wrap commands do not overflow the stack (#22.2 depth cap)", () => {
    // \textbf{\textbf{…{x}…}} — renderCommand recurses into convertInline on each
    // arg, so depth ~= nesting. BEFORE the #22.2 depth cap this threw an uncaught
    // RangeError ("Maximum call stack size exceeded") at depth ~5000, crashing the
    // otherwise-throwless import. Now it must return a string with the body
    // preserved and the truncation honestly reported — at a depth WELL past the
    // old stack limit.
    const depth = 50000;
    const tex = rep("\\textbf{", depth) + "needle" + rep("}", depth);
    const { typst, unconverted } = expectFastNoThrow("nested-textbf", () =>
      latexToTypst(tex),
    );
    expect(typeof typst).toBe("string");
    // Content survives (the inner text is not dropped) …
    expect(typst).toContain("needle");
    // … and the over-deep nesting is reported, not silently swallowed.
    expect(unconverted.some((u) => u.kind === "nesting-too-deep")).toBe(true);
  });

  it("deeply-nested braces with no command are linear", () => {
    const tex = rep("{", 50000) + "x" + rep("}", 50000);
    const { typst } = expectFastNoThrow("nested-braces", () => latexToTypst(tex));
    expect(typeof typst).toBe("string");
  });

  it("thousands of unmatched \\begin environments do not hang", () => {
    // Each unmatched \begin{env} scans to EOF in findEnvEnd; many of them must
    // stay bounded (this is the O(n·m) worst case we want to confirm is tolerable
    // at realistic sizes and capped by the wall-clock budget).
    const tex = rep("\\begin{foo}\n", 2000);
    const { typst, unconverted } = expectFastNoThrow("many-begin", () =>
      latexToTypst(tex),
    );
    expect(typeof typst).toBe("string");
    expect(Array.isArray(unconverted)).toBe(true);
  });

  it("unbalanced inline math / braces never throw", () => {
    for (const tex of [
      "$".repeat(10000),
      "\\textbf{" + "a".repeat(10000),
      "}".repeat(10000),
      "\\[" + "x".repeat(10000),
      rep("\\begin{itemize}\n\\item a\n", 1000), // unclosed nested lists
      rep("$x$", 20000), // many balanced inline-math spans
    ]) {
      const { typst } = expectFastNoThrow("unbalanced", () => latexToTypst(tex));
      expect(typeof typst).toBe("string");
    }
  });

  it("a pathological heading line with a huge body stays linear", () => {
    // The heading regex is /^\\(section|…)\*?\{([\s\S]*)\}\s*$/ — anchored, single
    // greedy group, so it is linear even with a massive body + trailing space run.
    const tex = "\\section{" + "a".repeat(200000) + "}" + " ".repeat(50000);
    expectFastNoThrow("huge-heading", () => latexToTypst(tex));
  });

  it("a giant document is processed without quadratic blowup", () => {
    const tex = rep("Some text with \\emph{markup} and $x_i$.\n", 20000);
    expectFastNoThrow("giant-doc", () => latexToTypst(tex));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// importLatexProject — directive-explosion (quadratic token replacement)
// ─────────────────────────────────────────────────────────────────────────────
describe("fuzz: importLatexProject token substitution is linear (#22.2)", () => {
  it("a .tex with thousands of \\input directives stays in budget", () => {
    // Each \input was substituted with a per-directive `typst.split(token).join()`
    // — O(directives × output_size), quadratic. A hostile main file with thousands
    // of directives could hang the import. The single-pass Map substitution must
    // process this in well under the budget.
    const N = 8000;
    let body = "\\documentclass{article}\n\\begin{document}\n";
    for (let k = 0; k < N; k++) body += `\\input{chap${k}}\n`;
    body += "\\end{document}\n";
    const files = [{ path: "main.tex", text: body }];
    // Also ship the include targets so renderings are non-trivial (real #include).
    for (let k = 0; k < N; k++) files.push({ path: `chap${k}.tex`, text: `sec ${k}` });

    const result = expectFastNoThrow("directive-explosion", () =>
      importLatexProject({ files }),
    );
    expect(result.mainPath).toBe("/main.typ");
    const main = result.files.find((f) => f.path === "/main.typ")!;
    // Every directive token was substituted (no placeholder leaked through).
    expect(main.text).not.toMatch(/GALLEYIMPORTDIRECTIVE/);
    // The includes were rendered.
    expect(main.text).toContain('#include "/chap0.typ"');
    expect(main.text).toContain(`#include "/chap${N - 1}.typ"`);
  });

  it("thousands of \\bibliography directives also stay linear", () => {
    const N = 8000;
    let body = "\\documentclass{article}\n\\begin{document}\n";
    for (let k = 0; k < N; k++) body += `\\bibliography{refs}\n`;
    body += "\\end{document}\n";
    const result = expectFastNoThrow("bib-directive-explosion", () =>
      importLatexProject({ files: [{ path: "main.tex", text: body }] }),
    );
    expect(result.mainPath).toBe("/main.typ");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// markdownToTypst — deep inline recursion, unterminated spans, pathological lines
// ─────────────────────────────────────────────────────────────────────────────
describe("fuzz: markdownToTypst fails safe on hostile Markdown", () => {
  it("huge emphasis-marker pile-ups never hang or overflow", () => {
    // The inline matcher uses `indexOf` for the NEAREST closing marker, so spans
    // match innermost-first and do not nest from the outside in (`_a…_…a_` is
    // depth-1, not depth-n) — there is no genuine deep-recursion DoS here. This
    // still pins the worst case: a huge `_a…a_` pile-up stays linear + in budget,
    // and the MAX_INLINE_DEPTH cap guards any future matcher change.
    let inner = "needle";
    for (let i = 0; i < 100000; i++) inner = "_a" + inner + "a_";
    const { typst } = expectFastNoThrow("emph-pileup", () => markdownToTypst(inner));
    expect(typeof typst).toBe("string");
    expect(typst).toContain("needle");
  });

  it("huge link pile-ups never hang or overflow", () => {
    // Same flat-matching property for links: `[…](u)` matches the nearest `]`, so
    // this does not deeply recurse; assert bounded time + content preserved.
    let text = "needle";
    for (let i = 0; i < 100000; i++) text = "[" + text + "](u)";
    const { typst } = expectFastNoThrow("link-pileup", () => markdownToTypst(text));
    expect(typeof typst).toBe("string");
    expect(typst).toContain("needle");
  });

  it("unterminated inline spans never throw or hang", () => {
    for (const md of [
      "`".repeat(10000),
      "*".repeat(10000),
      "_".repeat(10000),
      "[".repeat(10000),
      "![".repeat(10000),
      "**".repeat(10000),
    ]) {
      const { typst } = expectFastNoThrow("unterminated-md", () =>
        markdownToTypst(md),
      );
      expect(typeof typst).toBe("string");
    }
  });

  it("an unterminated fenced code block consumes to EOF without hanging", () => {
    const md = "```\n" + rep("line of code\n", 50000);
    expectFastNoThrow("open-fence", () => markdownToTypst(md));
  });

  it("a huge pipe table / blockquote / list is bounded", () => {
    expectFastNoThrow("big-table", () =>
      markdownToTypst(rep("| a | b |\n", 20000)),
    );
    expectFastNoThrow("big-quote", () => markdownToTypst(rep("> q\n", 20000)));
    expectFastNoThrow("big-list", () => markdownToTypst(rep("- item\n", 20000)));
  });

  it("hard-break detection on long trailing-space lines is linear", () => {
    const md = rep("word", 20000) + rep(" ", 20000) + "\nnext";
    expectFastNoThrow("trailing-space", () => markdownToTypst(md));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BibTeX (citation.ts / bibliography.ts) — malformed braces, billion-laughs keys
// ─────────────────────────────────────────────────────────────────────────────
describe("fuzz: BibTeX parsing fails safe on hostile input", () => {
  it("unbalanced braces never throw and terminate", () => {
    for (const src of [
      "@article{" + "{".repeat(50000),
      "@article{k," + "field={".repeat(20000),
      "@article{k,title={" + "a".repeat(200000),
      rep("@article{", 20000), // many opens, no bodies
    ]) {
      const out = expectFastNoThrow("bibtex-unbalanced", () => parseBibtex(src));
      expect(Array.isArray(out)).toBe(true);
    }
  });

  it("thousands of entries parse in budget and key uniquely", () => {
    const src = rep('@article{k,author={Smith, J},year={2020},title={T}}\n', 5000);
    const entries = expectFastNoThrow("many-bibtex", () => parseBibliography(src));
    const keys = entries.map((e) => e.key);
    // Globally unique keys (the keying contract) even with all-colliding bases.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("a huge nested-brace field value is linear", () => {
    const src = "@article{k,title={" + rep("{x}", 50000) + "}}";
    expectFastNoThrow("nested-brace-field", () => parseBibtex(src));
  });

  it("collision-suffix generation stays bounded for huge identical-key runs", () => {
    // Forces the collisionSuffix base-26 path repeatedly; bijective base-26 must
    // not loop unboundedly. 5000 identical provided keys → b,c,…,aa,ab,…
    const src = rep("@misc{dup,title={T}}\n", 5000);
    const keys = expectFastNoThrow("collision-suffix", () =>
      citeKeysFromBibliography(src),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("20k entries forcing GENERATED-key collisions key in O(n) (#22.2)", () => {
    // The prior 'identical provided keys' case dedupes BEFORE keying, so it never
    // proves the suffix-search hot path. This forces it: 20k @misc entries with an
    // EMPTY citekey, NO title, NO doi → dedupeEntries pushes each through (no
    // stable identity) and every one derives the SAME base key "ref", so each must
    // get a unique deterministic suffix. With the per-base next-index cache this is
    // O(n); the un-cached re-scan-from-base was O(n²) and would blow the budget.
    const N = 20000;
    const src = rep("@misc{,}\n", N);
    const keys = expectFastNoThrow("generated-key-collision", () =>
      citeKeysFromBibliography(src),
    );
    expect(keys.length).toBe(N);
    expect(new Set(keys).size).toBe(N); // all globally unique
    expect(keys[0]).toBe("ref"); // base is the implicit "a"
    expect(keys[1]).toBe("refb"); // deterministic suffix sequence unchanged
  });

  it("20k RIS records forcing generated-key collisions key in O(n) (#22.2)", () => {
    // Same pathology via the RIS path (importReferences): minimal records with no
    // author/title → base "ref", each needs a fresh suffix.
    const N = 20000;
    const src = rep("TY  - JOUR\nER  -\n", N);
    const out = expectFastNoThrow("ris-generated-collision", () =>
      importReferences(src, "ris"),
    );
    const keys = out.map((e) => e.key);
    expect(keys.length).toBe(N);
    expect(new Set(keys).size).toBe(N);
  });

  it("toHayagriva never lets a hostile field break out of its YAML node", () => {
    // YAML-injection probe: keys/values laden with newlines, colons, anchors, and
    // control chars must round-trip as a single scalar (quoted), not new nodes.
    const hostile = parseBibtex(
      '@misc{evil,title={a\\nb: c #x},author={X}}',
    );
    expect(hostile.length).toBe(1);
    const yaml = toHayagriva({
      ...hostile[0]!,
      key: "evil:\ninjected: true",
      title: "line1\nline2: pwned\nbell",
      url: "x\n  malicious: 1",
    });
    // The cite key line is the ONLY top-level (column-0) mapping key.
    const topLevelKeys = yaml
      .split("\n")
      .filter((l) => l.length > 0 && !/^\s/.test(l));
    expect(topLevelKeys.length).toBe(1);
    // No raw newline leaked an injected key like `injected:` at indent.
    expect(yaml).not.toMatch(/^injected:/m);
    expect(yaml).not.toMatch(/^\s*malicious:/m);
  });

  it("detectInputKind is linear on long DOI/URL-ish strings (no ReDoS)", () => {
    for (const s of [
      "10." + "1".repeat(100000) + "/x",
      "https://" + "a".repeat(100000),
      "doi:" + "9".repeat(100000),
      "@" + "a".repeat(100000), // bibtex-ish, no brace
    ]) {
      expectFastNoThrow("detectInputKind", () => detectInputKind(s));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RIS (reference-import.ts) — malformed records, unterminated, huge author runs
// ─────────────────────────────────────────────────────────────────────────────
describe("fuzz: RIS parsing fails safe on hostile input", () => {
  it("unterminated and malformed records never throw", () => {
    for (const src of [
      rep("TY  - JOUR\n", 20000), // 20k opens, no ER
      rep("AU  - X\n", 50000), // author lines before any TY (ignored)
      "TY  - JOUR\n" + rep("AU  - A\n", 50000) + "ER  -\n", // huge author run
      rep("ER  -\n", 50000), // stray closes
    ]) {
      const out = expectFastNoThrow("ris-malformed", () => parseRis(src));
      expect(Array.isArray(out)).toBe(true);
    }
  });

  it("importReferences keys thousands of RIS records uniquely in budget", () => {
    const src = rep("TY  - JOUR\nAU  - Smith, J\nPY  - 2020\nTI  - T\nER  -\n", 5000);
    const out = expectFastNoThrow("ris-import", () => importReferences(src, "auto"));
    const keys = out.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("countRisRecords is linear on a huge stream", () => {
    expectFastNoThrow("ris-count", () =>
      countRisRecords(rep("TY  - JOUR\n", 100000)),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Close-probe pileups (#22.2, real-corpus review HIGH-1/HIGH-2): a run of
// unclosed bracket/math openers must not rescan the suffix per opener. Before
// the close-position index (md) / no-close watermark (latex), each case below
// was O(n²) — well past the budget at these sizes; now they are ~linear.
// ─────────────────────────────────────────────────────────────────────────────
describe("fuzz: unclosed-opener pileups stay linear (#22.2 review)", () => {
  it("100k unclosed footnote openers ([^[^…) do not go quadratic", () => {
    const { typst, unmapped } = expectFastNoThrow("footnote-pileup", () =>
      markdownToTypst(rep("[^", 100000)),
    );
    expect(typeof typst).toBe("string");
    expect(unmapped).toEqual([]); // nothing closes → nothing recorded
  });

  it("50k reference-link openers stay bounded", () => {
    const { typst } = expectFastNoThrow("ref-link-pileup", () =>
      markdownToTypst(rep("[a][", 50000)),
    );
    expect(typeof typst).toBe("string");
  });

  it("50k link openers with no closing paren stay bounded", () => {
    const { typst } = expectFastNoThrow("paren-pileup", () =>
      markdownToTypst(rep("[a](", 50000)),
    );
    expect(typeof typst).toBe("string");
  });

  it("50k unterminated \\( openers stay linear with EXCERPTED snippets", () => {
    const { typst, unconverted } = expectFastNoThrow("inline-math-pileup", () =>
      latexToTypst(rep("\\(", 50000)),
    );
    expect(typeof typst).toBe("string");
    // Each bare backslash is still honestly reported, but the snippet is an
    // excerpt — the old whole-remainder snippet accumulated O(n²) bytes.
    expect(unconverted.length).toBeGreaterThan(0);
    expect(unconverted.every((u) => u.snippet.length <= 121)).toBe(true);
  });
});
