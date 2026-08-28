/**
 * Roadmap #17.3: Overleaf/LaTeX multi-file project migration core. These tests
 * pin the pure, offline, deterministic pipeline — tree classification (main
 * detection, include graph, bib/style/asset triage), per-file conversion via
 * the existing latexToTypst, cross-file rewriting to #include/#bibliography,
 * and the HONEST migration report (orphans, unresolved includes, traversal
 * rejection, lossy-construct catalog). Never throws on garbage.
 */
import { describe, it, expect } from "vitest";
import { importLatexProject } from "./import-latex-project.js";

// ---------------------------------------------------------------------------
// Realistic multi-file fixture
// ---------------------------------------------------------------------------

const MAIN_TEX = [
  "\\documentclass{article}",
  "\\usepackage{graphicx}",
  "\\graphicspath{{figures/}}",
  "\\begin{document}",
  "\\section{Introduction}",
  "\\input{chapters/intro}",
  "\\include{chapters/methods}",
  "\\bibliography{refs}",
  "\\end{document}",
].join("\n");

const FIXTURE = {
  files: [
    { path: "main.tex", text: MAIN_TEX },
    {
      path: "chapters/intro.tex",
      text: "Intro with \\textbf{bold}.\n\\input{extra/details}",
    },
    { path: "chapters/extra/details.tex", text: "Some details." },
    {
      path: "chapters/methods.tex",
      text: [
        "\\section{Methods}",
        "\\begin{figure}",
        "\\includegraphics[width=\\linewidth]{plot}",
        "\\end{figure}",
      ].join("\n"),
    },
    { path: "refs.bib", text: "@article{knuth84, author={Knuth}, year={1984}}" },
    { path: "figures/plot.png", binary: true },
    { path: "mystyle.sty", text: "\\newcommand{\\foo}{bar}" },
  ],
};

describe("importLatexProject — realistic multi-file project", () => {
  const result = importLatexProject(FIXTURE);

  it("identifies the main file and maps it to its .typ path", () => {
    expect(result.mainPath).toBe("/main.typ");
  });

  it("emits converted .typ files preserving relative paths, plus the .bib, sorted", () => {
    expect(result.files.map((f) => f.path)).toEqual([
      "/chapters/extra/details.typ",
      "/chapters/intro.typ",
      "/chapters/methods.typ",
      "/main.typ",
      "/refs.bib",
    ]);
  });

  it("rewrites \\input and \\include to root-absolute #include calls", () => {
    const main = result.files.find((f) => f.path === "/main.typ")!.text;
    expect(main).toContain('#include "/chapters/intro.typ"');
    expect(main).toContain('#include "/chapters/methods.typ"');
  });

  it("rewrites \\bibliography{refs} to #bibliography with the .bib path", () => {
    const main = result.files.find((f) => f.path === "/main.typ")!.text;
    expect(main).toContain('#bibliography("/refs.bib")');
  });

  it("converts body content via latexToTypst (headings, inline markup)", () => {
    const main = result.files.find((f) => f.path === "/main.typ")!.text;
    expect(main).toContain("= Introduction");
    const intro = result.files.find((f) => f.path === "/chapters/intro.typ")!.text;
    expect(intro).toContain("*bold*");
  });

  it("resolves a nested relative include from inside chapters/", () => {
    const intro = result.files.find((f) => f.path === "/chapters/intro.typ")!.text;
    expect(intro).toContain('#include "/chapters/extra/details.typ"');
  });

  it("passes the .bib through verbatim", () => {
    const bib = result.files.find((f) => f.path === "/refs.bib")!;
    expect(bib.text).toBe("@article{knuth84, author={Knuth}, year={1984}}");
    const outcome = result.report.outcomes.find((o) => o.sourcePath === "/refs.bib")!;
    expect(outcome.action).toBe("passthrough");
  });

  it("skips the .sty with an honest note", () => {
    const outcome = result.report.outcomes.find((o) => o.sourcePath === "/mystyle.sty")!;
    expect(outcome.action).toBe("skipped");
    expect(outcome.outputPath).toBeNull();
    expect(outcome.note).toMatch(/Typst/);
  });

  it("lists the binary figure as an asset, resolved via \\graphicspath", () => {
    const asset = result.report.assets.find((a) => a.path === "/figures/plot.png");
    expect(asset).toBeDefined();
    expect(asset!.referencedBy).toEqual(["/chapters/methods.tex"]);
    const outcome = result.report.outcomes.find((o) => o.sourcePath === "/figures/plot.png")!;
    expect(outcome.action).toBe("asset");
  });

  it("marks nothing orphaned when everything is reachable from main", () => {
    expect(result.report.outcomes.filter((o) => o.orphaned)).toEqual([]);
  });

  it("converts the figure float to a #figure(image) in the chapter output (G3)", () => {
    // G3: a figure with \includegraphics is now CONVERTED to real Typst rather
    // than degrading to a comment-and-environment-note. The figure body therefore
    // no longer appears in the lossy-construct catalog for this file.
    const methods = result.files.find((f) => f.path === "/chapters/methods.typ")!;
    expect(methods.text).toContain('#figure(\n  image("plot"),\n)');
    const figureNote = result.report.unconverted.find(
      (u) => u.path === "/chapters/methods.tex" && u.kind === "environment",
    );
    expect(figureNote).toBeUndefined();
  });

  it("reports no unresolved includes and no warnings for the clean fixture", () => {
    expect(result.report.unresolvedIncludes).toEqual([]);
    expect(result.report.warnings).toEqual([]);
  });

  it("is deterministic: same input, deep-equal output", () => {
    expect(importLatexProject(FIXTURE)).toEqual(result);
  });
});

// ---------------------------------------------------------------------------
// Main detection heuristics
// ---------------------------------------------------------------------------

const STANDALONE = (body: string): string =>
  `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}`;

describe("importLatexProject — main detection", () => {
  it("uses the single \\documentclass + \\begin{document} file", () => {
    const r = importLatexProject({
      files: [
        { path: "notes.tex", text: STANDALONE("hello") },
        { path: "chapter.tex", text: "no preamble here" },
      ],
    });
    expect(r.mainPath).toBe("/notes.typ");
  });

  it("prefers a conventional name (main.tex) among several candidates, no warning", () => {
    const r = importLatexProject({
      files: [
        { path: "draft.tex", text: STANDALONE("a") },
        { path: "main.tex", text: STANDALONE("b") },
      ],
    });
    expect(r.mainPath).toBe("/main.typ");
    expect(r.report.warnings.filter((w) => w.kind === "ambiguous-main")).toEqual([]);
  });

  it("breaks unnamed ties by include-graph reach, with an honest ambiguity warning", () => {
    const r = importLatexProject({
      files: [
        { path: "alpha.tex", text: STANDALONE("standalone") },
        { path: "beta.tex", text: STANDALONE("\\input{chapter}") },
        { path: "chapter.tex", text: "chapter body" },
      ],
    });
    expect(r.mainPath).toBe("/beta.typ");
    const warning = r.report.warnings.find((w) => w.kind === "ambiguous-main");
    expect(warning).toBeDefined();
    expect(warning!.message).toContain("/alpha.tex");
    expect(warning!.message).toContain("/beta.tex");
  });

  it("falls back to a lone .tex without \\documentclass, warning honestly", () => {
    const r = importLatexProject({
      files: [{ path: "fragment.tex", text: "just a \\section{Body}" }],
    });
    expect(r.mainPath).toBe("/fragment.typ");
    expect(r.report.warnings.some((w) => w.kind === "no-main")).toBe(true);
  });

  it("returns mainPath null for several main-less .tex files, still converting all", () => {
    const r = importLatexProject({
      files: [
        { path: "a.tex", text: "alpha" },
        { path: "b.tex", text: "beta" },
      ],
    });
    expect(r.mainPath).toBeNull();
    expect(r.report.warnings.some((w) => w.kind === "no-main")).toBe(true);
    expect(r.files.map((f) => f.path)).toEqual(["/a.typ", "/b.typ"]);
  });

  it("does not treat a subfiles-class chapter as the main document", () => {
    const r = importLatexProject({
      files: [
        { path: "main.tex", text: STANDALONE("\\input{chap}") },
        {
          path: "chap.tex",
          text: "\\documentclass[main.tex]{subfiles}\n\\begin{document}\nchap\n\\end{document}",
        },
      ],
    });
    expect(r.mainPath).toBe("/main.typ");
    expect(r.report.warnings.filter((w) => w.kind === "ambiguous-main")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Include-graph edge cases
// ---------------------------------------------------------------------------

describe("importLatexProject — include graph", () => {
  it("terminates on an include cycle and reports it", () => {
    const r = importLatexProject({
      files: [
        { path: "main.tex", text: STANDALONE("\\input{a}") },
        { path: "a.tex", text: "A\n\\input{b}" },
        { path: "b.tex", text: "B\n\\input{a}" },
      ],
    });
    expect(r.files.map((f) => f.path)).toEqual(["/a.typ", "/b.typ", "/main.typ"]);
    expect(r.report.warnings.some((w) => w.kind === "include-cycle")).toBe(true);
    expect(r.report.outcomes.filter((o) => o.orphaned)).toEqual([]);
  });

  it("does not report a diamond (shared include) as a cycle", () => {
    const r = importLatexProject({
      files: [
        { path: "main.tex", text: STANDALONE("\\input{a}\n\\input{b}") },
        { path: "a.tex", text: "\\input{shared}" },
        { path: "b.tex", text: "\\input{shared}" },
        { path: "shared.tex", text: "shared" },
      ],
    });
    expect(r.report.warnings.filter((w) => w.kind === "include-cycle")).toEqual([]);
    expect(r.report.outcomes.filter((o) => o.orphaned)).toEqual([]);
  });

  it("reports a missing include target and leaves an honest comment", () => {
    const r = importLatexProject({
      files: [{ path: "main.tex", text: STANDALONE("\\input{ghost}") }],
    });
    expect(r.report.unresolvedIncludes).toEqual([
      { from: "/main.tex", target: "ghost", line: 3, reason: "missing" },
    ]);
    const main = r.files.find((f) => f.path === "/main.typ")!.text;
    expect(main).toContain("unresolved include");
    expect(main).toContain("ghost");
  });

  it("resolves an include written WITH its .tex extension", () => {
    const r = importLatexProject({
      files: [
        { path: "main.tex", text: STANDALONE("\\input{chap.tex}") },
        { path: "chap.tex", text: "chapter" },
      ],
    });
    expect(r.files.find((f) => f.path === "/main.typ")!.text).toContain(
      '#include "/chap.typ"',
    );
  });

  it("falls back to root-relative resolution (LaTeX compile-root convention)", () => {
    const r = importLatexProject({
      files: [
        { path: "main.tex", text: STANDALONE("\\input{chapters/one}") },
        { path: "chapters/one.tex", text: "\\input{appendix}" },
        { path: "appendix.tex", text: "appendix at root" },
      ],
    });
    const one = r.files.find((f) => f.path === "/chapters/one.typ")!.text;
    expect(one).toContain('#include "/appendix.typ"');
    expect(r.report.outcomes.filter((o) => o.orphaned)).toEqual([]);
  });

  it("normalizes a legitimate ../ include below the root", () => {
    const r = importLatexProject({
      files: [
        { path: "main.tex", text: STANDALONE("\\input{chapters/a}") },
        { path: "chapters/a.tex", text: "\\input{../notes}" },
        { path: "notes.tex", text: "notes" },
      ],
    });
    const a = r.files.find((f) => f.path === "/chapters/a.typ")!.text;
    expect(a).toContain('#include "/notes.typ"');
  });

  it("REJECTS a ../ escape above the project root with a report note", () => {
    const r = importLatexProject({
      files: [{ path: "main.tex", text: STANDALONE("\\input{../../etc/passwd}") }],
    });
    expect(r.report.unresolvedIncludes).toEqual([
      { from: "/main.tex", target: "../../etc/passwd", line: 3, reason: "outside-root" },
    ]);
    expect(r.report.warnings.some((w) => w.kind === "path-traversal")).toBe(true);
    const main = r.files.find((f) => f.path === "/main.typ")!.text;
    expect(main).not.toContain("#include");
  });

  it("ignores includes inside comments and verbatim environments", () => {
    const r = importLatexProject({
      files: [
        {
          path: "main.tex",
          text: STANDALONE(
            [
              "% \\input{ghost-comment}",
              "real text",
              "\\begin{verbatim}",
              "\\input{ghost-verbatim}",
              "\\end{verbatim}",
            ].join("\n"),
          ),
        },
      ],
    });
    expect(r.report.unresolvedIncludes).toEqual([]);
    const main = r.files.find((f) => f.path === "/main.typ")!.text;
    expect(main).not.toContain("#include");
  });

  it("warns about an \\input in the preamble (target converted, not rewired)", () => {
    const r = importLatexProject({
      files: [
        {
          path: "main.tex",
          text: "\\documentclass{article}\n\\input{macros}\n\\begin{document}\nbody\n\\end{document}",
        },
        { path: "macros.tex", text: "\\newcommand{\\x}{y}" },
      ],
    });
    expect(r.report.warnings.some((w) => w.kind === "preamble-include")).toBe(true);
    expect(r.files.some((f) => f.path === "/macros.typ")).toBe(true);
    // The preamble (and the placeholder in it) is stripped from the main output.
    expect(r.files.find((f) => f.path === "/main.typ")!.text).not.toContain("#include");
    // Reached through the graph, so not orphaned.
    const outcome = r.report.outcomes.find((o) => o.sourcePath === "/macros.tex")!;
    expect(outcome.orphaned).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bibliography rewrite variants
// ---------------------------------------------------------------------------

describe("importLatexProject — bibliography variants", () => {
  it("rewrites a multi-file \\bibliography{a,b} to a tuple #bibliography", () => {
    const r = importLatexProject({
      files: [
        { path: "main.tex", text: STANDALONE("\\bibliography{a, b}") },
        { path: "a.bib", text: "@misc{a1}" },
        { path: "b.bib", text: "@misc{b1}" },
      ],
    });
    const main = r.files.find((f) => f.path === "/main.typ")!.text;
    expect(main).toContain('#bibliography(("/a.bib", "/b.bib"))');
  });

  it("rewrites biblatex \\addbibresource + \\printbibliography in place", () => {
    const r = importLatexProject({
      files: [
        {
          path: "main.tex",
          text: [
            "\\documentclass{article}",
            "\\addbibresource{refs.bib}",
            "\\begin{document}",
            "body",
            "\\printbibliography",
            "\\end{document}",
          ].join("\n"),
        },
        { path: "refs.bib", text: "@misc{x}" },
      ],
    });
    const main = r.files.find((f) => f.path === "/main.typ")!.text;
    expect(main).toContain('#bibliography("/refs.bib")');
    expect(r.report.warnings.filter((w) => w.kind === "bib-appended")).toEqual([]);
  });

  it("appends #bibliography to main when \\addbibresource has no \\printbibliography", () => {
    const r = importLatexProject({
      files: [
        {
          path: "main.tex",
          text: [
            "\\documentclass{article}",
            "\\addbibresource{refs.bib}",
            "\\begin{document}",
            "body",
            "\\end{document}",
          ].join("\n"),
        },
        { path: "refs.bib", text: "@misc{x}" },
      ],
    });
    const main = r.files.find((f) => f.path === "/main.typ")!.text;
    expect(main.trimEnd().endsWith('#bibliography("/refs.bib")')).toBe(true);
    expect(r.report.warnings.some((w) => w.kind === "bib-appended")).toBe(true);
  });

  it("still emits #bibliography for a missing .bib, reported as unresolved", () => {
    const r = importLatexProject({
      files: [{ path: "main.tex", text: STANDALONE("\\bibliography{nowhere}") }],
    });
    const main = r.files.find((f) => f.path === "/main.typ")!.text;
    expect(main).toContain('#bibliography("/nowhere.bib")');
    expect(r.report.unresolvedIncludes).toEqual([
      { from: "/main.tex", target: "nowhere", line: 3, reason: "missing" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Orphans
// ---------------------------------------------------------------------------

describe("importLatexProject — orphaned files", () => {
  it("converts a .tex never reached from main and flags it orphaned", () => {
    const r = importLatexProject({
      files: [
        { path: "main.tex", text: STANDALONE("body") },
        { path: "stray.tex", text: "\\section{Stray}" },
      ],
    });
    expect(r.files.some((f) => f.path === "/stray.typ")).toBe(true);
    const outcome = r.report.outcomes.find((o) => o.sourcePath === "/stray.tex")!;
    expect(outcome.action).toBe("converted");
    expect(outcome.orphaned).toBe(true);
    expect(outcome.note).toMatch(/never reached/);
    const main = r.report.outcomes.find((o) => o.sourcePath === "/main.tex")!;
    expect(main.orphaned).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Garbage / robustness (never throws)
// ---------------------------------------------------------------------------

describe("importLatexProject — robustness", () => {
  it("returns a structured failure for non-object input", () => {
    const r = importLatexProject(null as never);
    expect(r.files).toEqual([]);
    expect(r.mainPath).toBeNull();
    expect(r.report.warnings.some((w) => w.kind === "invalid-entry")).toBe(true);
  });

  it("ignores malformed entries with an invalid-entry warning", () => {
    const r = importLatexProject({
      files: [
        {} as never,
        { path: 42 } as never,
        { path: "ok.tex", text: STANDALONE("fine") },
      ],
    });
    expect(r.mainPath).toBe("/ok.typ");
    expect(r.report.warnings.filter((w) => w.kind === "invalid-entry")).toHaveLength(2);
  });

  it("rejects an entry path that escapes the root", () => {
    const r = importLatexProject({
      files: [{ path: "../evil.tex", text: "evil" }],
    });
    expect(r.files).toEqual([]);
    expect(r.report.warnings.some((w) => w.kind === "path-traversal")).toBe(true);
  });

  it("keeps the first entry on duplicate paths and warns", () => {
    const r = importLatexProject({
      files: [
        { path: "main.tex", text: STANDALONE("first") },
        { path: "/main.tex", text: STANDALONE("second") },
      ],
    });
    expect(r.files.find((f) => f.path === "/main.typ")!.text).toContain("first");
    expect(r.report.warnings.some((w) => w.kind === "duplicate-path")).toBe(true);
  });

  it("handles an empty project without throwing", () => {
    const r = importLatexProject({ files: [] });
    expect(r.files).toEqual([]);
    expect(r.mainPath).toBeNull();
    expect(r.report.warnings.some((w) => w.kind === "no-main")).toBe(true);
  });

  it("survives a .tex full of garbage bytes-as-text", () => {
    const r = importLatexProject({
      files: [{ path: "junk.tex", text: " \\begin{??\n%%%$$$\\\\}{{{" }],
    });
    expect(r.files).toHaveLength(1);
    expect(r.mainPath).toBe("/junk.typ");
  });

  it("treats a text-less entry as an asset listed by path", () => {
    const r = importLatexProject({
      files: [
        { path: "main.tex", text: STANDALONE("x") },
        { path: "logo.pdf" },
      ],
    });
    const outcome = r.report.outcomes.find((o) => o.sourcePath === "/logo.pdf")!;
    expect(outcome.action).toBe("asset");
    expect(r.report.assets.some((a) => a.path === "/logo.pdf")).toBe(true);
  });

  it("passes unknown text files (e.g. README) through verbatim", () => {
    const r = importLatexProject({
      files: [
        { path: "main.tex", text: STANDALONE("x") },
        { path: "README.md", text: "# hello" },
      ],
    });
    const readme = r.files.find((f) => f.path === "/README.md");
    expect(readme).toBeDefined();
    expect(readme!.text).toBe("# hello");
    expect(
      r.report.outcomes.find((o) => o.sourcePath === "/README.md")!.action,
    ).toBe("passthrough");
  });
});

// ---------------------------------------------------------------------------
// #22.2 SEC-22.2-8: emitted Typst string literals are escaped
// ---------------------------------------------------------------------------
describe("importLatexProject — generated Typst output is escaped (SEC-22.2-8)", () => {
  it("escapes a quote in an unresolved \\bibliography path so the literal can't break out", () => {
    // `evil"name` resolves to no .bib entry → the renderer guesses a path; the
    // crafted quote must be escaped inside the emitted `#bibliography("…")`.
    const r = importLatexProject({
      files: [{ path: "main.tex", text: STANDALONE('\\bibliography{evil"name}') }],
    });
    const main = r.files.find((f) => f.path === "/main.typ")!.text;
    expect(main).toContain('#bibliography("/evil\\"name.bib")');
    // The raw, unescaped `name.bib"` sequence must NOT appear (would be a breakout).
    expect(main).not.toContain('"/evil"name.bib"');
  });

  it("leaves a clean path byte-for-byte unchanged (no special chars)", () => {
    const r = importLatexProject({
      files: [
        { path: "main.tex", text: STANDALONE("\\bibliography{refs}") },
        { path: "refs.bib", text: "@misc{x}" },
      ],
    });
    const main = r.files.find((f) => f.path === "/main.typ")!.text;
    expect(main).toContain('#bibliography("/refs.bib")');
  });
});

// ---------------------------------------------------------------------------
// #7 7C-3b: a bare \includegraphics (outside a figure/table float) is rewritten
// to #image(VFS path); float-embedded graphics stay on the #figure(image) path.
// ---------------------------------------------------------------------------

const BARE_GRAPHICS = {
  files: [
    {
      path: "main.tex",
      text: [
        "\\documentclass{article}",
        "\\graphicspath{{figures/}}",
        "\\begin{document}",
        "\\includegraphics[width=\\linewidth]{plot}",
        "\\begin{figure}",
        "\\includegraphics{plot}",
        "\\caption{A plot}",
        "\\end{figure}",
        "\\end{document}",
      ].join("\n"),
    },
    { path: "figures/plot.png", binary: true },
  ],
};

describe("importLatexProject — 7C-3b bare \\includegraphics", () => {
  it("rewrites a bare \\includegraphics to a #image with the resolved VFS path", () => {
    const r = importLatexProject({
      files: [
        {
          path: "main.tex",
          text: [
            "\\documentclass{article}",
            "\\graphicspath{{figures/}}",
            "\\begin{document}",
            "\\includegraphics[width=\\linewidth]{plot}",
            "\\end{document}",
          ].join("\n"),
        },
        { path: "figures/plot.png", binary: true },
      ],
    });
    const main = r.files.find((f) => f.path === "/main.typ")!.text;
    // \graphicspath + extensionless resolution → root-absolute VFS path; the
    // [width=…] options are consumed and dropped.
    expect(main).toContain('#image("/figures/plot.png")');
    // The resolved reference is still listed in the asset manifest.
    const asset = r.report.assets.find((a) => a.path === "/figures/plot.png");
    expect(asset).toBeDefined();
    expect(asset!.referencedBy).toEqual(["/main.tex"]);
    expect(r.report.warnings).toEqual([]);
  });

  it("keeps a figure-embedded \\includegraphics on the #figure path (two-path exclusivity)", () => {
    const r = importLatexProject(BARE_GRAPHICS);
    const main = r.files.find((f) => f.path === "/main.typ")!.text;
    // Bare occurrence → resolved #image.
    expect(main).toContain('#image("/figures/plot.png")');
    // Figure-embedded occurrence → renderFloat's raw-arg image, not re-emitted.
    expect(main).toContain('#figure(\n  image("plot"),');
    expect(main.match(/#image\(/g)!.length).toBe(1);
  });

  it("emits a #image with a best-effort guess for an unresolved bare reference", () => {
    const r = importLatexProject({
      files: [{ path: "main.tex", text: STANDALONE("\\includegraphics{missing}") }],
    });
    const main = r.files.find((f) => f.path === "/main.typ")!.text;
    expect(main).toContain('#image("/missing")');
    // An unresolved reference stays honest in the report, never silently dropped.
    const asset = r.report.assets.find((a) => a.path === "/missing");
    expect(asset).toBeDefined();
    expect(asset!.referencedBy).toEqual(["/main.tex"]);
  });

  it("escapes a quote in the path so the #image literal can't break out (SEC-22.2-8)", () => {
    const r = importLatexProject({
      files: [{ path: "main.tex", text: STANDALONE('\\includegraphics{evil"name.png}') }],
    });
    const main = r.files.find((f) => f.path === "/main.typ")!.text;
    expect(main).toContain('#image("/evil\\"name.png")');
    // The raw, unescaped sequence must NOT appear (would be a breakout).
    expect(main).not.toContain('"/evil"name.png"');
  });

  it("does NOT tokenize a \\includegraphics inside a multi-line figure", () => {
    const r = importLatexProject({
      files: [
        {
          path: "main.tex",
          text: [
            "\\documentclass{article}",
            "\\begin{document}",
            "\\begin{figure}",
            "\\includegraphics[width=0.8\\textwidth]{plot}",
            "\\caption{A plot}",
            "\\end{figure}",
            "\\end{document}",
          ].join("\n"),
        },
      ],
    });
    const main = r.files.find((f) => f.path === "/main.typ")!.text;
    // The float owns the graphic; no bare #image, no leaked token.
    expect(main).toContain('image("plot")');
    expect(main).not.toContain("#image(");
    expect(main).not.toContain("GALLEYIMPORTDIRECTIVE");
  });

  it("treats figure* and table* as float context (no token leaks into the fallback)", () => {
    const r = importLatexProject({
      files: [
        {
          path: "main.tex",
          text: [
            "\\documentclass{article}",
            "\\begin{document}",
            "\\begin{figure*}",
            "\\includegraphics{wide}",
            "\\end{figure*}",
            "\\begin{table*}",
            "\\includegraphics{wtab}",
            "\\end{table*}",
            "\\end{document}",
          ].join("\n"),
        },
      ],
    });
    const main = r.files.find((f) => f.path === "/main.typ")!.text;
    // Starred floats aren't converted (exact-name match only), but the depth
    // guard still suppresses tokenization, so no token leaks into the comment
    // fallback and no stray #image is emitted.
    expect(main).not.toContain("#image(");
    expect(main).not.toContain("GALLEYIMPORTDIRECTIVE");
  });

  it("leaves a \\includegraphics inside a verbatim environment untouched", () => {
    const r = importLatexProject({
      files: [
        {
          path: "main.tex",
          text: [
            "\\documentclass{article}",
            "\\begin{document}",
            "\\begin{verbatim}",
            "\\includegraphics{plot}",
            "\\end{verbatim}",
            "\\end{document}",
          ].join("\n"),
        },
      ],
    });
    const main = r.files.find((f) => f.path === "/main.typ")!.text;
    expect(main).toContain("includegraphics");
    expect(main).not.toContain("#image(");
    expect(main).not.toContain("GALLEYIMPORTDIRECTIVE");
  });

  it("tokenizes a bare graphic inside a non-float env (center) — accepted v1 limitation", () => {
    const r = importLatexProject({
      files: [
        {
          path: "main.tex",
          text: [
            "\\documentclass{article}",
            "\\begin{document}",
            "\\begin{center}",
            "\\includegraphics{plot}",
            "\\end{center}",
            "\\end{document}",
          ].join("\n"),
        },
      ],
    });
    const main = r.files.find((f) => f.path === "/main.typ")!.text;
    // `center` isn't converted, and its bare graphic IS tokenized, so the #image
    // lands inside the commented-out env block — inert, content not lost.
    expect(main).toContain('// #image("/plot")');
    // The migration report must not surface a raw placeholder token to a human
    // reviewing the lossy-construct catalog; the snippet carries the rendering.
    const envNote = r.report.unconverted.find(
      (u) => u.path === "/main.tex" && u.kind === "environment",
    );
    expect(envNote).toBeDefined();
    expect(envNote!.snippet).not.toContain("GALLEYIMPORTDIRECTIVE");
    expect(envNote!.snippet).toContain('#image("/plot")');
  });

  it("emits #image for a graphic after a MID-LINE \\begin{figure} (dispatcher parity)", () => {
    const r = importLatexProject({
      files: [
        {
          path: "main.tex",
          text: [
            "\\documentclass{article}",
            "\\graphicspath{{figures/}}",
            "\\begin{document}",
            "Intro text. \\begin{figure}[h]",
            "\\includegraphics{plot}",
            "\\caption{X}",
            "\\end{figure}",
            "\\end{document}",
          ].join("\n"),
        },
        { path: "figures/plot.png", binary: true },
      ],
    });
    const main = r.files.find((f) => f.path === "/main.typ")!.text;
    // latex-to-typst only treats a line as a float when the TRIMMED line starts
    // with \begin{...}; here it doesn't, so renderFloat never runs and the graphic
    // must be tokenized to a working #image rather than leaking as raw LaTeX.
    expect(main).toContain('#image("/figures/plot.png")');
  });

  it("keeps a same-line \\begin{figure}...\\end{figure} float-scoped (empty inner → comment)", () => {
    const r = importLatexProject({
      files: [
        {
          path: "main.tex",
          text: [
            "\\documentclass{article}",
            "\\begin{document}",
            "\\begin{figure}\\includegraphics{plot}\\end{figure}",
            "\\end{document}",
          ].join("\n"),
        },
      ],
    });
    const main = r.files.find((f) => f.path === "/main.typ")!.text;
    // A line-start \begin{figure} opens a float, so the graphic is NOT tokenized;
    // latex-to-typst's same-line env has empty inner → comment fallback keeps the
    // raw \includegraphics. Known same-line limitation (no #image double-emit).
    expect(main).not.toContain("#image(");
    expect(main).not.toContain("GALLEYIMPORTDIRECTIVE");
    expect(main).toContain("includegraphics");
  });

  it("resolves a \\graphicspath dir against the including file's directory (subdir main)", () => {
    const r = importLatexProject({
      files: [
        {
          path: "paper/main.tex",
          text: [
            "\\documentclass{article}",
            "\\graphicspath{{figs/}}",
            "\\begin{document}",
            "\\includegraphics{plot}",
            "\\end{document}",
          ].join("\n"),
        },
        { path: "paper/figs/plot.png", binary: true },
      ],
    });
    const main = r.files.find((f) => f.path === "/paper/main.typ")!.text;
    // \graphicspath{{figs/}} is relative to the main file's dir, not just root.
    expect(main).toContain('#image("/paper/figs/plot.png")');
    const asset = r.report.assets.find((a) => a.path === "/paper/figs/plot.png");
    expect(asset).toBeDefined();
    expect(asset!.referencedBy).toEqual(["/paper/main.tex"]);
  });

  it("is deterministic across the new bare-graphics path (deep-equal rerun)", () => {
    expect(importLatexProject(BARE_GRAPHICS)).toEqual(importLatexProject(BARE_GRAPHICS));
  });
});
