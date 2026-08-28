import { describe, it, expect } from "vitest";
import type { VersionedFile } from "@galley/shared";
import {
  compareVersionTrees,
  diffLines,
  PROJECT_MANIFEST_PATHS,
  type VersionComparison,
  type VersionFileDiff,
  type VersionFileStatus,
  type LineDiffOp,
} from "./version-compare.js";

const f = (path: string, text: string): VersionedFile => ({ path, text });

const statusOf = (cmp: VersionComparison, path: string): VersionFileStatus | undefined =>
  cmp.files.find((e) => e.path === path)?.status;

describe("compareVersionTrees", () => {
  it("classifies added / removed / modified / unchanged over the path union", () => {
    const base = [f("a.typ", "alpha"), f("b.typ", "beta"), f("c.typ", "gamma")];
    const other = [f("b.typ", "beta-2"), f("c.typ", "gamma"), f("d.typ", "delta")];
    const cmp = compareVersionTrees(base, other);

    expect(statusOf(cmp, "a.typ")).toBe("removed");
    expect(statusOf(cmp, "b.typ")).toBe("modified");
    expect(statusOf(cmp, "c.typ")).toBe("unchanged");
    expect(statusOf(cmp, "d.typ")).toBe("added");
  });

  it("attaches baseText/otherText per status (conditional, no undefined slots)", () => {
    const base = [f("only-base.typ", "B"), f("both.typ", "x")];
    const other = [f("only-other.typ", "O"), f("both.typ", "y")];
    const cmp = compareVersionTrees(base, other);

    const removed = cmp.files.find((e) => e.path === "only-base.typ")!;
    expect(removed.status).toBe("removed");
    expect(removed.baseText).toBe("B");
    expect("otherText" in removed).toBe(false);

    const added = cmp.files.find((e) => e.path === "only-other.typ")!;
    expect(added.status).toBe("added");
    expect(added.otherText).toBe("O");
    expect("baseText" in added).toBe(false);

    const modified = cmp.files.find((e) => e.path === "both.typ")!;
    expect(modified.status).toBe("modified");
    expect(modified.baseText).toBe("x");
    expect(modified.otherText).toBe("y");
  });

  it("includes both texts on an unchanged entry (still useful for rendering)", () => {
    const cmp = compareVersionTrees([f("a.typ", "same")], [f("a.typ", "same")]);
    const e = cmp.files[0]!;
    expect(e.status).toBe("unchanged");
    expect(e.baseText).toBe("same");
    expect(e.otherText).toBe("same");
  });

  it("sorts entries by path ascending (deterministic)", () => {
    const base = [f("z.typ", "1"), f("m.typ", "2"), f("a.typ", "3")];
    const other = [f("b.typ", "4"), f("a.typ", "3")];
    const cmp = compareVersionTrees(base, other);
    const paths = cmp.files.map((e) => e.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toEqual(["a.typ", "b.typ", "m.typ", "z.typ"]);
  });

  it("excludes the reserved manifest by default (both slash conventions)", () => {
    const base = [f(".galley/project.json", "{m1}"), f("a.typ", "x")];
    const other = [f("/.galley/project.json", "{m2}"), f("a.typ", "x")];
    const cmp = compareVersionTrees(base, other);
    const paths = cmp.files.map((e) => e.path);
    expect(paths).toEqual(["a.typ"]);
    expect(cmp.summary).toEqual({ added: 0, removed: 0, modified: 0, unchanged: 1 });
  });

  it("includes the manifest when includeManifest: true", () => {
    const base = [f(".galley/project.json", "{m1}"), f("a.typ", "x")];
    const other = [f(".galley/project.json", "{m2}"), f("a.typ", "x")];
    const cmp = compareVersionTrees(base, other, { includeManifest: true });
    expect(statusOf(cmp, ".galley/project.json")).toBe("modified");
    expect(statusOf(cmp, "a.typ")).toBe("unchanged");
  });

  it("knows the manifest path constants", () => {
    expect(PROJECT_MANIFEST_PATHS).toContain(".galley/project.json");
    expect(PROJECT_MANIFEST_PATHS).toContain("/.galley/project.json");
  });

  it("handles two empty trees", () => {
    const cmp = compareVersionTrees([], []);
    expect(cmp.files).toEqual([]);
    expect(cmp.summary).toEqual({ added: 0, removed: 0, modified: 0, unchanged: 0 });
  });

  it("handles one empty tree (all added / all removed)", () => {
    const allAdded = compareVersionTrees([], [f("a.typ", "x"), f("b.typ", "y")]);
    expect(allAdded.summary).toEqual({ added: 2, removed: 0, modified: 0, unchanged: 0 });

    const allRemoved = compareVersionTrees([f("a.typ", "x")], []);
    expect(allRemoved.summary).toEqual({ added: 0, removed: 1, modified: 0, unchanged: 0 });
  });

  it("reports correct summary counts on a mixed tree", () => {
    const base = [f("a.typ", "1"), f("b.typ", "2"), f("c.typ", "3")];
    const other = [f("a.typ", "1"), f("b.typ", "CHANGED"), f("d.typ", "4")];
    const cmp = compareVersionTrees(base, other);
    expect(cmp.summary).toEqual({ added: 1, removed: 1, modified: 1, unchanged: 1 });
    // summary counts equal the entry total
    const total = cmp.summary.added + cmp.summary.removed + cmp.summary.modified + cmp.summary.unchanged;
    expect(total).toBe(cmp.files.length);
  });

  it("treats identical trees as fully unchanged regardless of input order", () => {
    const base = [f("b.typ", "B"), f("a.typ", "A")];
    const other = [f("a.typ", "A"), f("b.typ", "B")];
    const cmp = compareVersionTrees(base, other);
    expect(cmp.summary).toEqual({ added: 0, removed: 0, modified: 0, unchanged: 2 });
  });

  it("does not mutate its inputs", () => {
    const base = [f("z.typ", "1"), f("a.typ", "2")];
    const other = [f("a.typ", "2")];
    const baseCopy = JSON.parse(JSON.stringify(base));
    compareVersionTrees(base, other);
    expect(base).toEqual(baseCopy);
  });
});

describe("diffLines", () => {
  const types = (ops: LineDiffOp[]): string => ops.map((o) => o.type[0]).join("");

  it("returns all context for identical text", () => {
    const ops = diffLines("a\nb\nc", "a\nb\nc");
    expect(ops.every((o) => o.type === "ctx")).toBe(true);
    expect(ops.map((o) => o.text)).toEqual(["a", "b", "c"]);
  });

  it("returns all adds against empty base", () => {
    const ops = diffLines("", "x\ny");
    // "" splits to one empty line; treat as del of "" then adds — assert adds present
    expect(ops.some((o) => o.type === "add" && o.text === "x")).toBe(true);
    expect(ops.some((o) => o.type === "add" && o.text === "y")).toBe(true);
  });

  it("returns all dels against empty other", () => {
    const ops = diffLines("x\ny", "");
    expect(ops.some((o) => o.type === "del" && o.text === "x")).toBe(true);
    expect(ops.some((o) => o.type === "del" && o.text === "y")).toBe(true);
  });

  it("detects a single middle-line change", () => {
    const ops = diffLines("a\nb\nc", "a\nB\nc");
    expect(ops.some((o) => o.type === "del" && o.text === "b")).toBe(true);
    expect(ops.some((o) => o.type === "add" && o.text === "B")).toBe(true);
    expect(ops.some((o) => o.type === "ctx" && o.text === "a")).toBe(true);
    expect(ops.some((o) => o.type === "ctx" && o.text === "c")).toBe(true);
  });

  it("preserves order: shared prefix as ctx, then del block, then add block, then ctx suffix", () => {
    const ops = diffLines("a\nb\nc\nd", "a\nx\ny\nd");
    // common prefix "a", common suffix "d" → middle b,c deleted; x,y added
    expect(types(ops).startsWith("c")).toBe(true); // ctx a
    expect(types(ops).endsWith("c")).toBe(true); // ctx d
    const middle = ops.slice(1, -1);
    const dels = middle.filter((o) => o.type === "del").map((o) => o.text);
    const adds = middle.filter((o) => o.type === "add").map((o) => o.text);
    expect(dels).toEqual(["b", "c"]);
    expect(adds).toEqual(["x", "y"]);
  });

  it("recovers a common middle line via LCS (not just prefix/suffix)", () => {
    // base: A K B   other: X K Y  → K is the only common line, in the middle
    const ops = diffLines("A\nK\nB", "X\nK\nY");
    expect(ops.some((o) => o.type === "ctx" && o.text === "K")).toBe(true);
    expect(ops.filter((o) => o.type === "del").map((o) => o.text)).toEqual(["A", "B"]);
    expect(ops.filter((o) => o.type === "add").map((o) => o.text)).toEqual(["X", "Y"]);
  });

  it("reconstructs base from ctx+del and other from ctx+add", () => {
    const base = "one\ntwo\nthree\nfour";
    const other = "one\n2\nthree\n4\nfive";
    const ops = diffLines(base, other);
    const rebuiltBase = ops.filter((o) => o.type !== "add").map((o) => o.text).join("\n");
    const rebuiltOther = ops.filter((o) => o.type !== "del").map((o) => o.text).join("\n");
    expect(rebuiltBase).toBe(base);
    expect(rebuiltOther).toBe(other);
  });
});
