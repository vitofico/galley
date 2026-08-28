/**
 * Real-scenario import corpus (roadmap #5 "import features testing in real
 * scenarios"). Hand-crafted, license-free corpora shaped like REAL documents —
 * a markdown article, a LaTeX paper, an Overleaf-style multi-file project, and
 * messy reference-manager exports (BibTeX + RIS) — driven through the REAL
 * import paths end to end.
 *
 * Two kinds of assertions live here:
 *   1. structural guarantees (headings survive, math passes through, citations
 *      are recorded, includes resolve, keys are stable);
 *   2. DOCUMENTED LIMITATIONS — places where the output is imperfect but
 *      accepted. Those are pinned with an explicit "documented limitation"
 *      comment so a future change that improves them fails loudly here and the
 *      pin gets updated deliberately. A pin is NOT an endorsement of the
 *      output as correct.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { markdownToTypst } from "./md-to-typst.js";
import { latexToTypst, escapeTypstMathBody } from "./latex-to-typst.js";
import { importLatexProject } from "./import-latex-project.js";
import {
  importReferences,
  importReferencesDetailed,
  parseRis,
  countRisRecords,
  detectImportFormat,
} from "./reference-import.js";
import { parseBibtex } from "./citation.js";

const fixture = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/import-real/${rel}`, import.meta.url)), "utf8");

// ---------------------------------------------------------------------------
// Markdown article
// ---------------------------------------------------------------------------

describe("real corpus — markdown article", () => {
  const md = fixture("article.md");
  const { typst, unmapped } = markdownToTypst(md);

  it("preserves the heading hierarchy", () => {
    expect(typst).toContain("= Lattice Boltzmann Methods on Adaptive Grids");
    expect(typst).toContain("== Abstract");
    expect(typst).toContain("== 1. Background");
    expect(typst).toContain("=== 1.1 Refinement criteria");
    expect(typst).toContain("== References (informal)");
  });

  it("maps inline emphasis, strong, code, and links", () => {
    expect(typst).toContain("_Anna Voss_ and _Pieter Hendriks_");
    expect(typst).toContain("*Boltzmann equation*");
    expect(typst).toContain("`D2Q9`");
    expect(typst).toContain('#link("https://example.org/fh98")[Filippova & Hänel]');
  });

  it("keeps fenced code blocks verbatim, language tag included", () => {
    expect(typst).toContain("```python");
    expect(typst).toContain("return np.roll(f, shift=e, axis=(0, 1))");
    expect(typst).toContain("```cpp");
    // Typst-special chars inside a raw block must survive UNescaped.
    expect(typst).toContain("constexpr std::array<int2, 9> kD2Q9 = {{");
  });

  it("collapses the multi-line blockquote into one #quote", () => {
    expect(typst).toContain("#quote[Grid refinement does not change the physics");
    expect(typst).toContain("— workshop remark, attributed]");
  });

  it("maps ordered list items and the horizontal rule", () => {
    expect(typst).toContain("+ Velocity-gradient magnitude\n+ Vorticity thresholds\n+ Wall distance");
    expect(typst).toContain("#line(length: 100%)");
  });

  it("records the pipe table, image, and HTML fragments as unmapped", () => {
    const tables = unmapped.filter((u) => u.kind === "table");
    expect(tables).toHaveLength(1);
    expect(tables[0]!.snippet).toContain("Scheme");

    const images = unmapped.filter((u) => u.kind === "image");
    expect(images).toHaveLength(1);
    expect(images[0]!.snippet).toContain("vorticity-re200.png");

    // Opening <div> and closing </div> are recorded individually.
    expect(unmapped.filter((u) => u.kind === "html")).toHaveLength(2);
  });

  it("records footnote refs AND definitions as unmapped, content preserved", () => {
    const footnotes = unmapped.filter((u) => u.kind === "footnote");
    // [^glups] + [^yu] inline refs, [^glups]: + [^yu]: definition lines.
    expect(footnotes).toHaveLength(4);
    expect(footnotes.map((f) => f.snippet)).toContain("[^glups]");
    expect(typst).toContain("[^glups]"); // passed through, not dropped
    expect(typst).toContain("Giga lattice updates per second.");
  });

  it("records reference-style links and their definitions as unmapped", () => {
    const refLinks = unmapped.filter((u) => u.kind === "reference-link");
    // [project page][lbm-site] inline + the [lbm-site]: definition line.
    expect(refLinks).toHaveLength(2);
    expect(typst).toContain("[project page][lbm-site]");
    expect(typst).toContain("https://example.org/lbm-bench");
  });

  it("maps nested list items to indented Typst list items (G2)", () => {
    // The indented sub-items nest under their parent as Typst list items
    // (two spaces per level), preserving the structure. (Was a documented
    // limitation; G2 closed it.)
    expect(typst).toContain(
      "- Collision step\n" +
        "  - BGK single-relaxation-time approximation\n" +
        "  - Multiple-relaxation-time (MRT) variants\n" +
        "- Streaming step",
    );
    expect(typst).not.toContain("- - BGK"); // not a malformed flat item
  });

  it("passes inline math through as Typst math (G2)", () => {
    // Markdown `$\rho = \sum_i f_i$` is now passed through as Typst inline math
    // (body neutralized, never translated). (Was a documented limitation; G2
    // closed it.) Still not recorded as unmapped — it is mapped, not lost.
    expect(typst).toContain("$\\rho = \\sum_i f_i$");
    expect(typst).not.toContain("\\$rho"); // no longer escaped to literal text
    expect(unmapped.some((u) => u.kind === "math")).toBe(false);
  });

  it("never throws and reports every loss with a line number", () => {
    expect(unmapped.every((u) => u.line >= 1 && u.snippet.length > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LaTeX paper (single-file converter)
// ---------------------------------------------------------------------------

describe("real corpus — LaTeX paper", () => {
  const tex = fixture("paper.tex");
  const { typst, unconverted } = latexToTypst(tex);

  it("strips the preamble and records the documentclass", () => {
    expect(typst).not.toContain("usepackage");
    const preamble = unconverted.filter((u) => u.kind === "preamble");
    expect(preamble).toHaveLength(1);
    expect(preamble[0]!.snippet).toBe("documentclass: article");
  });

  it("maps the sectioning commands to Typst headings", () => {
    expect(typst).toContain("= Introduction");
    expect(typst).toContain("= Main results");
    expect(typst).toContain("== The spectral gap");
    expect(typst).toContain("== A two-line lemma");
    expect(typst).toContain("= Experiments");
  });

  it("passes inline math through verbatim", () => {
    expect(typst).toContain("$d$-regular");
    expect(typst).toContain("$A \\in \\Reals^{n \\times n}$");
  });

  it("converts equation environments and \\[...\\] to Typst math blocks", () => {
    expect(typst).toContain("\\lambda_2(A) \\le 2\\sqrt{d-1} + \\epsilon $");
    expect(typst).toContain("$ \\lambda_2(A) = \\max_{x \\perp \\mathbf{1}");
  });

  it("lifts \\label out of an equation body into a Typst label (G6)", () => {
    // Was a documented limitation (the \label landed INSIDE the math block as
    // literal text). G6 extracts the single \label{key} and emits it as a Typst
    // post-block label, so eqref/ref can resolve it.
    expect(typst).toContain(
      "$ \\lambda_2(A) \\le 2\\sqrt{d-1} + \\epsilon $ <eq:gap>",
    );
    // The label no longer appears inside the math body.
    expect(typst).not.toContain("$ \\label{eq:gap}");
  });

  it("maps itemize/enumerate with inline markup inside items", () => {
    expect(typst).toContain("- An _elementary_ second-moment argument for the spectral gap.");
    expect(typst).toContain("- A `numpy` implementation of the non-backtracking trace bound.");
    expect(typst).toContain("+ Reduce to the non-backtracking operator $B$.");
  });

  it("records every \\cite/\\ref/\\eqref with a visible TODO marker", () => {
    expect(typst).toContain("/* TODO cite: friedman2008 */");
    expect(typst).toContain("/* TODO cite: hoory2006 */");
    expect(typst).toContain("/* TODO ref: fig:gap-hist */");
    expect(typst).toContain("/* TODO eqref: eq:gap */");
    expect(unconverted.filter((u) => u.kind === "cite")).toHaveLength(3);
    expect(unconverted.filter((u) => u.kind === "ref")).toHaveLength(3);
    expect(unconverted.filter((u) => u.kind === "eqref")).toHaveLength(2);
  });

  it("reports abstract/align/(tabular-only)table environments honestly", () => {
    // G3 landed: the figure float and the verbatim block are now CONVERTED to
    // real Typst (asserted below). What remains reported: abstract, align (kept
    // a comment by design — the agent repairs math envs later), and the table
    // float — which has NO \includegraphics (just a tabular), so it keeps the
    // honest comment fallback rather than emitting an empty #figure.
    const envs = unconverted.filter((u) => u.kind === "environment");
    const names = envs.map((e) => e.snippet.match(/^\\begin\{([^}]*)\}/)?.[1]);
    expect(names).toEqual(["abstract", "align", "table"]);
    // The raw align content survives as Typst comments — never silently lost.
    expect(typst).toContain("// \\begin{align}");
  });

  it("converts the verbatim sampling harness to a Typst raw block (G3)", () => {
    // Was a documented limitation (degraded to `// for d in 3 4 5; do`); G3
    // emits a real fenced raw block with the body kept literal.
    expect(typst).toContain("```\nfor d in 3 4 5; do\n  python sample.py --degree $d --trials 10000\ndone\n```");
    expect(typst).not.toContain("// for d in 3 4 5; do");
  });

  it("converts the figure float to #figure(image + caption) with a label (G3)", () => {
    // Was a documented limitation (degraded to `// \begin{figure}`); G3 emits a
    // real #figure with the includegraphics body, converted caption, and label.
    expect(typst).toContain(
      '#figure(\n  image("figures/gap-histogram"),\n  caption: [Histogram of normalized second eigenvalues, $d = 4$.],\n) <fig:gap-hist>',
    );
    expect(typst).not.toContain("// \\begin{figure}");
  });

  it("falls back to a comment for the tabular-only table float (G3, no graphic)", () => {
    // The table float has no \includegraphics (just a tabular), so it keeps the
    // honest comment behavior and stays recorded — no empty #figure is emitted.
    expect(typst).toContain("// \\begin{table}");
    expect(
      unconverted.some(
        (u) => u.kind === "environment" && u.snippet.startsWith("\\begin{table}"),
      ),
    ).toBe(true);
  });

  it("keeps an unexpanded custom macro as reported literal text (documented limitation)", () => {
    // \newcommand is stripped with the preamble, so \keyword{expanders} in the
    // body cannot be expanded. It is recorded and passed through literally.
    expect(typst).toContain("\\keyword{expanders}");
    expect(
      unconverted.some((u) => u.kind === "unknown-command" && u.snippet === "\\keyword{expanders}"),
    ).toBe(true);
  });

  it("records \\input as an unknown command (single-file converter)", () => {
    // The single-file path does not resolve includes — importLatexProject does.
    expect(
      unconverted.some(
        (u) => u.kind === "unknown-command" && u.snippet === "\\input{appendix-proofs}",
      ),
    ).toBe(true);
  });

  it("decodes escaped specials like 50\\%", () => {
    expect(typst).toContain("The 50% quantile sits within 1% of the");
  });
});

describe("latexToTypst — \\(...\\) inline math (real-corpus fix)", () => {
  it("normalizes \\( ... \\) to $ ... $ with the body verbatim", () => {
    const r = latexToTypst("We fit the \\(\\kappa\\)-corrected model.");
    expect(r.typst).toBe("We fit the $\\kappa$-corrected model.");
    expect(r.unconverted).toEqual([]);
  });

  it("still reports an unterminated \\( as an unknown construct", () => {
    const r = latexToTypst("broken \\(x + y");
    expect(r.unconverted.some((u) => u.kind === "unknown-command")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Overleaf-style multi-file project (unpacked tree → importLatexProject)
// ---------------------------------------------------------------------------

describe("real corpus — Overleaf project tree", () => {
  const tree = {
    files: [
      { path: "main.tex", text: fixture("overleaf/main.tex") },
      { path: "sections/intro.tex", text: fixture("overleaf/sections/intro.tex") },
      { path: "sections/methods.tex", text: fixture("overleaf/sections/methods.tex") },
      { path: "refs.bib", text: fixture("overleaf/refs.bib") },
      { path: "figures/setup.png", binary: true },
    ],
  };
  const result = importLatexProject(tree);

  it("detects the main file and emits the converted tree", () => {
    expect(result.mainPath).toBe("/main.typ");
    expect(result.files.map((f) => f.path)).toEqual([
      "/main.typ",
      "/refs.bib",
      "/sections/intro.typ",
      "/sections/methods.typ",
    ]);
  });

  it("rewrites \\input/\\include to #include with converted paths", () => {
    const main = result.files.find((f) => f.path === "/main.typ")!;
    expect(main.text).toContain('#include "/sections/intro.typ"');
    expect(main.text).toContain('#include "/sections/methods.typ"');
    expect(result.report.unresolvedIncludes).toEqual([]);
  });

  it("rewrites \\bibliography to #bibliography and passes the .bib through verbatim", () => {
    const main = result.files.find((f) => f.path === "/main.typ")!;
    expect(main.text).toContain('#bibliography("/refs.bib")');
    const bib = result.files.find((f) => f.path === "/refs.bib")!;
    expect(bib.text).toBe(fixture("overleaf/refs.bib"));
  });

  it("converts the chapter files with sections, cites, and math intact", () => {
    const intro = result.files.find((f) => f.path === "/sections/intro.typ")!;
    expect(intro.text).toContain("= Introduction");
    expect(intro.text).toContain("/* TODO cite: crilley2018 */");

    const methods = result.files.find((f) => f.path === "/sections/methods.typ")!;
    expect(methods.text).toContain("= Methods");
    // \( \kappa \)-corrected normalizes to $...$ (the real-corpus fix).
    expect(methods.text).toContain("$\\kappa$-corrected");
    // The equation environment body survives verbatim in a math block.
    expect(methods.text).toContain("y_t = \\alpha_i \\cdot \\frac{x_{i,t}}{1 + \\kappa \\, a_w(t)} + \\beta_i");
  });

  it("resolves the \\includegraphics target through \\graphicspath into the asset manifest", () => {
    expect(result.report.assets).toEqual([
      { path: "/figures/setup.png", referencedBy: ["/main.tex"] },
    ]);
    const setup = result.report.outcomes.find((o) => o.sourcePath === "/figures/setup.png")!;
    expect(setup.action).toBe("asset");
    expect(setup.outputPath).toBeNull();
  });

  it("reports per-file outcomes with nothing orphaned and no warnings", () => {
    const byPath = new Map(result.report.outcomes.map((o) => [o.sourcePath, o]));
    expect(byPath.get("/main.tex")!.action).toBe("converted");
    expect(byPath.get("/sections/intro.tex")!.action).toBe("converted");
    expect(byPath.get("/sections/methods.tex")!.action).toBe("converted");
    expect(byPath.get("/refs.bib")!.action).toBe("passthrough");
    expect(result.report.outcomes.every((o) => !o.orphaned)).toBe(true);
    expect(result.report.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BibTeX library (messy reference-manager export)
// ---------------------------------------------------------------------------

describe("real corpus — messy BibTeX library", () => {
  const bib = fixture("library.bib");
  const entries = importReferences(bib, "auto");

  it("auto-detects BibTeX and preserves provided keys, suffixing the duplicate", () => {
    expect(detectImportFormat(bib)).toBe("bibtex");
    expect(entries.map((e) => e.key)).toEqual([
      "vapnik1998",
      "mueller2019",
      "smith2020",
      "smith2020b", // duplicate key, deterministically suffixed
      "lamport1986",
      "mullender1990",
    ]);
  });

  it("strips case-protecting braces but keeps the content", () => {
    const m = entries.find((e) => e.key === "mueller2019")!;
    expect(m.title).toBe("On CRDT Convergence in P2P Systems");
  });

  it("maps DOI/URL/volume/number/pages and drops the month macro", () => {
    const m = entries.find((e) => e.key === "mueller2019")!;
    expect(m.doi).toBe("10.5555/3322706.3322779");
    expect(m.url).toBe("https://example.org/crdt-convergence");
    expect(m.volume).toBe("20");
    expect(m.number).toBe("73");
    expect(m.pages).toBe("1--38");
    expect("month" in m).toBe(false); // month is not in the common-denominator set
  });

  it("decodes TeX accent commands in author names to Unicode (G5-accents)", () => {
    // Was a documented limitation ({\"u} lost its braces but left the raw \"
    // escape). G5 folds the common TeX accents to precomposed Unicode; the cite
    // key still ASCII-folds to "mueller2019" so dedup identity is unchanged.
    const m = entries.find((e) => e.key === "mueller2019")!;
    expect(m.author).toEqual(["Müller, Hans", "García, María"]);
  });

  it("expands @string macros referenced in entry fields (G5-@string)", () => {
    // journal = jmlr / publisher = acm were once kept as the raw macro name (the
    // @string defs were parsed-and-skipped). G5 collects the @string table during
    // the single scan and substitutes the macro into the field value.
    expect(entries.find((e) => e.key === "mueller2019")!.journal).toBe(
      "Journal of Machine Learning Research",
    );
    expect(entries.find((e) => e.key === "mullender1990")!.publisher).toBe("ACM Press");
  });

  it("preserves the editor field instead of dropping it (G7)", () => {
    // Was a documented limitation: BibTeX `editor = {…}` was parsed but never
    // stored, so editors were silently lost on import. G7 threads `editor`
    // through parse → model, splitting on " and " exactly like `author`.
    const m = entries.find((e) => e.key === "mullender1990")!;
    expect(m.editor).toEqual(["Mullender, Sape"]);
  });

  it("inherits MISSING fields one level from the crossref parent (G5-crossref)", () => {
    // lamport1986 has crossref = {mullender1990}. It keeps its OWN title/year, and
    // fills the fields it LACKS from the parent: publisher (itself an expanded
    // @string macro, acm → ACM Press) and editor. One level only, best-effort.
    const l = entries.find((e) => e.key === "lamport1986")!;
    expect(l.title).toBe("On Interprocess Communication"); // own title kept
    expect(l.year).toBe("1986"); // own year kept
    expect(l.publisher).toBe("ACM Press"); // inherited (and macro-expanded)
    expect(l.editor).toEqual(["Mullender, Sape"]); // inherited from parent
  });

  it("fails gracefully on the malformed trailing entry (everything before it parses)", () => {
    // The unbalanced @article{broken1999 entry is dropped; the 6 well-formed
    // entries before it all survive.
    expect(entries).toHaveLength(6);
    expect(parseBibtex(bib)).toHaveLength(6);
  });

  it("a malformed entry MID-file no longer swallows the remainder (G4 fixed)", () => {
    // G4 RESYNC: an unbalanced entry used to make `parseBibtex` stop dead, losing
    // every entry after it. Now the parser skips the broken entry (resyncing at
    // the next `@…{` start) and keeps going — both the entry BEFORE and the entry
    // AFTER the broken one survive; only the broken one is dropped.
    const src = [
      "@article{first2000, title={Alpha}, year={2000}}",
      "@article{broken, title={Unclosed",
      "@article{last2001, title={Omega}, year={2001}}",
    ].join("\n");
    const parsed = parseBibtex(src);
    expect(parsed.map((e) => e.key)).toEqual(["first2000", "last2001"]);
    expect(parsed.some((e) => e.title === "Alpha")).toBe(true); // before the break
    expect(parsed.some((e) => e.title === "Omega")).toBe(true); // after the break
  });

  it("counts the malformed trailing entry against the honest parsed total (G4)", () => {
    // The library has 6 well-formed entries + 1 malformed trailing one. The
    // detailed import reports parsed-of-total so the UI can say "N of M".
    const detailed = importReferencesDetailed(bib, "auto");
    expect(detailed.totalCount).toBe(7); // 6 good + 1 broken @-entry start
    expect(detailed.parsedCount).toBe(6); // post-dedupe well-formed entries
    expect(detailed.malformedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// RIS library
// ---------------------------------------------------------------------------

describe("real corpus — RIS library", () => {
  const ris = fixture("library.ris");

  it("parses all four records, the unterminated trailer included", () => {
    expect(countRisRecords(ris)).toBe(4);
    expect(parseRis(ris)).toHaveLength(4);
  });

  it("maps the common tags and joins SP-only pages", () => {
    const [a, b, c, d] = parseRis(ris);
    expect(a!.title).toBe("Adaptive Mesh Refinement for Kinetic Schemes");
    expect(a!.author).toEqual(["Voss, Anna", "Hendriks, Pieter"]);
    expect(a!.year).toBe("2021");
    expect(a!.journal).toBe("Journal of Computational Physics");
    expect(a!.pages).toBe("110049"); // SP without EP (article-number style)
    expect(a!.doi).toBe("10.1016/j.jcp.2020.110049");
    expect(a!.type).toBe("article");

    expect(b!.type).toBe("phdthesis"); // THES
    expect(b!.publisher).toBe("ETH Zurich");

    expect(c!.type).toBe("web"); // ELEC
    expect(c!.url).toBe("https://typst.app/docs");

    expect(d!.title).toBe("Record Missing Its Terminator");
    expect(d!.year).toBe("1999");
  });

  it("derives stable keys, falling back to the title when there is no author", () => {
    const entries = importReferences(ris, "auto");
    expect(detectImportFormat(ris)).toBe("ris");
    expect(entries.map((e) => e.key)).toEqual([
      "voss2021",
      "okafor2018",
      "typst2024", // no author → first title word
      "last1999",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Format detection ordering (real-corpus fix)
// ---------------------------------------------------------------------------

describe("detectImportFormat — first-opener-wins (real-corpus fix)", () => {
  it("a BibTeX-first paste with a stray RIS block later stays BibTeX", () => {
    const mixed = [
      "@article{a, title={X}, year={2000}}",
      "TY  - JOUR",
      "TI  - Y",
      "ER  -",
    ].join("\n");
    expect(detectImportFormat(mixed)).toBe("bibtex");
    // The auto path therefore parses the BibTeX side instead of dropping it.
    const entries = importReferences(mixed, "auto");
    expect(entries.map((e) => e.key)).toEqual(["a"]);
  });

  it("a RIS export with a vendor header (no leading TY) is still RIS", () => {
    const ris = "Provider: Example\nDatabase: Things\n\nTY  - JOUR\nTI  - T\nER  -\n";
    expect(detectImportFormat(ris)).toBe("ris");
    expect(importReferences(ris, "auto")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Zero-entry auto fallback (review MEDIUM-1)
// ---------------------------------------------------------------------------

describe("importReferencesDetailed — zero-entry auto fallback", () => {
  // A MALFORMED BibTeX opener ahead of a valid RIS block: first-opener-wins
  // detection picks bibtex, whose parse yields nothing — without the fallback
  // the whole RIS library was silently lost.
  const malformedFirst = [
    "@article{broken, title={Unclosed",
    "TY  - JOUR",
    "TI  - Rescued Work",
    "AU  - Voss, Anna",
    "PY  - 2021",
    "ER  -",
  ].join("\n");

  it("falls back bibtex→ris when the detected format parses to zero entries — and says so", () => {
    expect(detectImportFormat(malformedFirst)).toBe("bibtex"); // detection is defeated…
    const r = importReferencesDetailed(malformedFirst, "auto");
    expect(r.format).toBe("ris"); // …but the entries are not lost
    expect(r.entries.map((e) => e.title)).toEqual(["Rescued Work"]);
    expect(r.entries[0]!.key).toBe("voss2021");
    expect(r.fallbackNote).toContain("imported as ris");
    // The plain entry-point sees the same recovery.
    expect(importReferences(malformedFirst, "auto")).toHaveLength(1);
  });

  it("a FORCED format is honored even when it parses to nothing (no fallback)", () => {
    const r = importReferencesDetailed(malformedFirst, "bibtex");
    expect(r.entries).toEqual([]);
    expect(r.format).toBe("bibtex");
    expect(r.fallbackNote).toBeUndefined();
    // The reverse forced direction likewise stays put: pure BibTeX forced as RIS
    // yields zero entries, honestly, with no second-guessing.
    const bib = "@article{a, title={X}, year={2000}}";
    const forced = importReferencesDetailed(bib, "ris");
    expect(forced.entries).toEqual([]);
    expect(forced.format).toBe("ris");
    expect(forced.fallbackNote).toBeUndefined();
  });

  it("clean parses carry no fallback note; total garbage stays empty without one", () => {
    const bib = importReferencesDetailed("@article{a, title={X}, year={2000}}", "auto");
    expect(bib.format).toBe("bibtex");
    expect(bib.entries).toHaveLength(1);
    expect(bib.fallbackNote).toBeUndefined();

    const ris = importReferencesDetailed("TY  - JOUR\nTI  - T\nER  -\n", "auto");
    expect(ris.format).toBe("ris");
    expect(ris.entries).toHaveLength(1);
    expect(ris.fallbackNote).toBeUndefined();

    // NOTE on the reverse auto direction (ris→bibtex): structurally unreachable
    // today — any TY line that triggers RIS detection also OPENS a RIS record,
    // so a RIS parse of RIS-detected input is never empty. The branch exists
    // symmetrically in code; garbage proves the no-entries/no-note case.
    const junk = importReferencesDetailed("complete garbage, no openers at all", "auto");
    expect(junk.entries).toEqual([]);
    expect(junk.fallbackNote).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Math-body neutralization (review HIGH-3)
// ---------------------------------------------------------------------------

describe("latexToTypst — emitted math bodies are inert (review HIGH-3)", () => {
  it("\\(...\\): a crafted $ / #set inside the body cannot break out of Typst math", () => {
    const r = latexToTypst("\\(x $ #set text(red) $ y\\)");
    expect(r.typst).toBe("$x \\$ \\#set text(red) \\$ y$");
  });

  it("\\[...\\] display math gets the same neutralization", () => {
    const r = latexToTypst("\\[\nx $ #set text(red) $ y\n\\]");
    expect(r.typst).toBe("$ x \\$ \\#set text(red) \\$ y $");
  });

  it("equation environments get the same neutralization", () => {
    const r = latexToTypst("\\begin{equation}\nE = mc^2 $ #emit $\n\\end{equation}");
    expect(r.typst).toBe("$ E = mc^2 \\$ \\#emit \\$ $");
  });

  it("$...$ passthrough neutralizes a crafted # (a $ cannot occur — it closes the span)", () => {
    const r = latexToTypst("where $#foo$ holds");
    expect(r.typst).toBe("where $\\#foo$ holds");
  });

  it("escapeTypstMathBody leaves real LaTeX math byte-identical", () => {
    // Backslash sequences (incl. already-escaped \$ and \#) pass through; only
    // BARE $ / # are escaped.
    const real = "\\lambda_2(A) \\le 2\\sqrt{d-1} + \\epsilon";
    expect(escapeTypstMathBody(real)).toBe(real);
    expect(escapeTypstMathBody("a \\$5 fee and item \\#2")).toBe("a \\$5 fee and item \\#2");
    expect(escapeTypstMathBody("a $ b # c")).toBe("a \\$ b \\# c");
  });
});

// ---------------------------------------------------------------------------
// Reference-style images (review LOW)
// ---------------------------------------------------------------------------

describe("markdownToTypst — reference-style images", () => {
  it("records ![alt][label] under its own kind, not as a reference link", () => {
    const { typst, unmapped } = markdownToTypst("See ![apparatus sketch][fig-setup] here.");
    expect(unmapped).toEqual([
      { kind: "reference-image", line: 1, snippet: "![apparatus sketch][fig-setup]" },
    ]);
    expect(typst).toContain("![apparatus sketch][fig-setup]");
  });
});
