/**
 * Roadmap #13 slice 3 — cross-file label index: pure, offline, framework-free.
 *
 * A `@ref` in one file may resolve to a `<label>` defined in ANOTHER file. The
 * single-file `refDiagnostics` cannot see those cross-file labels and would
 * falsely flag such refs as broken. This core composes the label union across
 * ALL project files so broken-ref detection is project-aware, and qualifies
 * every finding with the `path` of the file it belongs to.
 */
import { describe, it, expect } from "vitest";
import {
  allProjectLabelNames,
  crossFileRefDiagnostics,
  type ProjectTextFile,
} from "./cross-file-labels.js";
import { buildLabelIndex, labelNames } from "./labels.js";

describe("allProjectLabelNames", () => {
  it("returns an empty set for empty input", () => {
    expect(allProjectLabelNames([])).toEqual(new Set());
  });

  it("returns an empty set when no file defines a label", () => {
    const files: ProjectTextFile[] = [
      { path: "a.typ", text: "see @intro" },
      { path: "b.typ", text: "no labels here" },
    ];
    expect(allProjectLabelNames(files)).toEqual(new Set());
  });

  it("unions <label> names across every file (deduped)", () => {
    const files: ProjectTextFile[] = [
      { path: "a.typ", text: "intro <intro> and <shared>" },
      { path: "b.typ", text: "<methods> and <shared> again" },
    ];
    expect(allProjectLabelNames(files)).toEqual(
      new Set(["intro", "shared", "methods"]),
    );
  });

  it("agrees with per-file labelNames composed by hand", () => {
    const files: ProjectTextFile[] = [
      { path: "a.typ", text: "<x> <y>" },
      { path: "b.typ", text: "<z>" },
    ];
    const byHand = new Set(
      files.flatMap((f) => labelNames(buildLabelIndex(f.text))),
    );
    expect(allProjectLabelNames(files)).toEqual(byHand);
  });

  it("accepts a generator (general Iterable)", () => {
    function* gen(): Generator<ProjectTextFile> {
      yield { path: "a.typ", text: "<one>" };
      yield { path: "b.typ", text: "<two>" };
    }
    expect(allProjectLabelNames(gen())).toEqual(new Set(["one", "two"]));
  });
});

describe("crossFileRefDiagnostics", () => {
  it("returns no diagnostics for empty input", () => {
    expect(crossFileRefDiagnostics([], [])).toEqual([]);
  });

  it("does NOT flag a @ref that resolves to a <label> in another file", () => {
    // The core fix: file A refs a label DEFINED IN FILE B → not broken.
    const files: ProjectTextFile[] = [
      { path: "a.typ", text: "as in @methods we proceed" },
      { path: "b.typ", text: "the method <methods> is here" },
    ];
    expect(crossFileRefDiagnostics(files, [])).toEqual([]);
  });

  it("flags a genuinely-undefined @ref with the correct path and span", () => {
    const files: ProjectTextFile[] = [
      { path: "a.typ", text: "see @ghost now" },
    ];
    const diags = crossFileRefDiagnostics(files, []);
    expect(diags).toHaveLength(1);
    const d = diags[0]!;
    expect(d.severity).toBe("warning");
    expect(d.message).toContain("ghost");
    expect(d.path).toBe("a.typ");
    // span offsets are into THAT file's text; end exclusive, UTF-16.
    expect(d.span).toBeDefined();
    expect(d.span!.offset).toBe(4);
    expect(d.span!.endOffset).toBe(10);
    expect("see @ghost now".slice(d.span!.offset, d.span!.endOffset)).toBe(
      "@ghost",
    );
    // 1-based line/column derived from the file's own offsets.
    expect(d.span!.start).toEqual({ line: 1, column: 5 });
    expect(d.span!.end).toEqual({ line: 1, column: 11 });
  });

  it("does NOT flag a @ref whose name is a citation key", () => {
    const files: ProjectTextFile[] = [
      { path: "a.typ", text: "per @smith2020 we cite" },
    ];
    expect(crossFileRefDiagnostics(files, ["smith2020"])).toEqual([]);
    // ...but flags it when the key is absent.
    expect(crossFileRefDiagnostics(files, [])).toHaveLength(1);
  });

  it("qualifies each broken ref with the path of ITS file", () => {
    // a.typ: clean (refs a label defined in b). b.typ: a broken ref of its own.
    const files: ProjectTextFile[] = [
      { path: "a.typ", text: "see @shared here" },
      { path: "b.typ", text: "<shared> but also @missing" },
    ];
    const diags = crossFileRefDiagnostics(files, []);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.path).toBe("b.typ");
    expect(diags[0]!.message).toContain("missing");
    expect(diags[0]!.span!.offset).toBe(18);
    expect("<shared> but also @missing".slice(18, 26)).toBe("@missing");
  });

  it("reports diagnostics across multiple files, each path-qualified", () => {
    const files: ProjectTextFile[] = [
      { path: "a.typ", text: "@gone1" },
      { path: "b.typ", text: "ok <ok> @ok @gone2" },
    ];
    const diags = crossFileRefDiagnostics(files, []);
    expect(diags.map((d) => [d.path, d.message.includes("gone1") ? "g1" : "g2"]))
      .toEqual([
        ["a.typ", "g1"],
        ["b.typ", "g2"],
      ]);
  });

  it("resolves cite key OR cross-file label, and accepts generators for both", () => {
    function* fileGen(): Generator<ProjectTextFile> {
      yield { path: "x.typ", text: "@local @far @cited @bad" };
      yield { path: "y.typ", text: "defined <far> over here" };
    }
    function* keyGen(): Generator<string> {
      yield "cited";
    }
    // @local: undefined → bad. @far: cross-file label → ok. @cited: cite → ok.
    // @bad: undefined → bad. <local> not defined anywhere.
    const diags = crossFileRefDiagnostics(fileGen(), keyGen());
    expect(diags.map((d) => d.message.match(/@(\w+)/)![1]).sort()).toEqual([
      "bad",
      "local",
    ]);
    expect(diags.every((d) => d.path === "x.typ")).toBe(true);
  });
});

// First-boot lint fix (#20.2): comments are TEXT — the demo workspace's
// main.typ header comment mentions `@preview` and must not produce a warning,
// in the project-wide scan exactly as in the single-file one.
describe("crossFileRefDiagnostics ignores comments and raw blocks", () => {
  it("does not flag a @mention inside a line comment (the demo repro)", () => {
    const files: ProjectTextFile[] = [
      {
        path: "/main.typ",
        text: "// pure Typst — no @preview packages\nIntro <intro>\n@intro",
      },
    ];
    expect(crossFileRefDiagnostics(files, [])).toEqual([]);
  });

  it("still flags a real broken ref, with correct path and span after a comment", () => {
    const text = "// comment with @preview\nsee @missing here";
    const files: ProjectTextFile[] = [{ path: "/a.typ", text }];
    const diags = crossFileRefDiagnostics(files, []);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.path).toBe("/a.typ");
    expect(diags[0]!.message).toContain("@missing");
    const span = diags[0]!.span!;
    expect(text.slice(span.offset, span.endOffset)).toBe("@missing");
    expect(span.start).toEqual({ line: 2, column: 5 });
  });

  it("a <label> defined only inside a sibling's comment does not resolve a ref", () => {
    const files: ProjectTextFile[] = [
      { path: "/a.typ", text: "@ghost" },
      { path: "/b.typ", text: "// <ghost> commented out" },
    ];
    const diags = crossFileRefDiagnostics(files, []);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.path).toBe("/a.typ");
  });

  it("allProjectLabelNames skips labels inside comments", () => {
    const files: ProjectTextFile[] = [
      { path: "/a.typ", text: "real <kept> // and <dropped> in a comment" },
    ];
    expect(allProjectLabelNames(files)).toEqual(new Set(["kept"]));
  });
});
