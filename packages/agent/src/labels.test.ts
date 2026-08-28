/**
 * Roadmap #13 slice 1: the cross-reference label core — pure, offline, framework-free.
 *
 * Typst writes a label as `<name>` (a def) and a reference as `@name` (a ref).
 * This core parses both with exact UTF-16 offsets, then derives broken refs
 * (no matching def) and unused defs (no matching ref). NOTE: `@name` is also
 * Typst's citation syntax, so broken-ref findings here are LOCAL only — the
 * coordinator composes them with the citation index before surfacing diagnostics.
 */
import { describe, it, expect } from "vitest";
import {
  buildLabelIndex,
  findBrokenRefs,
  findUnusedLabels,
  labelNames,
} from "./labels.js";

describe("buildLabelIndex", () => {
  it("returns empty index for empty source", () => {
    const idx = buildLabelIndex("");
    expect(idx).toEqual({ defs: [], refs: [] });
  });

  it("parses a single def with exact offsets (end exclusive)", () => {
    const src = "see <intro> here";
    const idx = buildLabelIndex(src);
    expect(idx.defs).toEqual([{ name: "intro", start: 4, end: 11 }]);
    // offsets must slice back to the literal token
    expect(src.slice(4, 11)).toBe("<intro>");
  });

  it("parses a single ref with exact offsets (end exclusive)", () => {
    const src = "as in @intro for more";
    const idx = buildLabelIndex(src);
    expect(idx.refs).toEqual([{ name: "intro", start: 6, end: 12 }]);
    expect(src.slice(6, 12)).toBe("@intro");
  });

  it("parses defs and refs in document order", () => {
    const src = "@a and <a> then @b and <b>";
    const idx = buildLabelIndex(src);
    expect(idx.refs.map((r) => r.name)).toEqual(["a", "b"]);
    expect(idx.defs.map((d) => d.name)).toEqual(["a", "b"]);
  });

  it("accepts the full label charset: letters/digits/-/_/./:", () => {
    const src = "<fig.a-1_b:c> @fig.a-1_b:c";
    const idx = buildLabelIndex(src);
    expect(idx.defs[0]?.name).toBe("fig.a-1_b:c");
    expect(idx.refs[0]?.name).toBe("fig.a-1_b:c");
  });

  it("does not match an empty <> or a bare @", () => {
    const src = "empty <> and bare @ done";
    const idx = buildLabelIndex(src);
    expect(idx.defs).toEqual([]);
    expect(idx.refs).toEqual([]);
  });

  it("computes correct UTF-16 offsets across CRLF lines", () => {
    const src = "line1\r\n<lbl>\r\n@lbl";
    const idx = buildLabelIndex(src);
    // "line1\r\n" is 7 UTF-16 units, so <lbl> starts at 7
    expect(idx.defs).toEqual([{ name: "lbl", start: 7, end: 12 }]);
    expect(src.slice(7, 12)).toBe("<lbl>");
    // "<lbl>\r\n" -> next token at 12 + 2 = 14
    expect(idx.refs).toEqual([{ name: "lbl", start: 14, end: 18 }]);
    expect(src.slice(14, 18)).toBe("@lbl");
  });

  it("computes correct UTF-16 offsets with astral characters before a token", () => {
    const src = "😀 <x>"; // emoji is 2 UTF-16 units + space => <x> at 3
    const idx = buildLabelIndex(src);
    expect(idx.defs[0]?.start).toBe(3);
    expect(src.slice(idx.defs[0]!.start, idx.defs[0]!.end)).toBe("<x>");
  });
});

describe("findBrokenRefs", () => {
  it("returns refs that have no matching def", () => {
    const idx = buildLabelIndex("<a> @a @b @c <c>");
    const broken = findBrokenRefs(idx);
    expect(broken.map((r) => r.name)).toEqual(["b"]);
  });

  it("returns empty when every ref resolves", () => {
    const idx = buildLabelIndex("<a> <b> @a @b");
    expect(findBrokenRefs(idx)).toEqual([]);
  });

  it("reports each broken occurrence (duplicates kept)", () => {
    const idx = buildLabelIndex("@x @x");
    expect(findBrokenRefs(idx).map((r) => r.name)).toEqual(["x", "x"]);
  });
});

describe("findUnusedLabels", () => {
  it("returns defs that have no matching ref", () => {
    const idx = buildLabelIndex("<a> <b> @a");
    const unused = findUnusedLabels(idx);
    expect(unused.map((d) => d.name)).toEqual(["b"]);
  });

  it("returns empty when every def is referenced", () => {
    const idx = buildLabelIndex("<a> @a");
    expect(findUnusedLabels(idx)).toEqual([]);
  });
});

describe("labelNames", () => {
  it("returns sorted unique def names", () => {
    const idx = buildLabelIndex("<b> <a> <a> <c>");
    expect(labelNames(idx)).toEqual(["a", "b", "c"]);
  });

  it("returns empty for no defs", () => {
    expect(labelNames(buildLabelIndex("@only-ref"))).toEqual([]);
  });
});

// Typst's lexer trims trailing `.`/`:` from a ref — sentence punctuation, not
// name chars (#20.2 first-boot false positive: `… drawn in @lightcone.`).
describe("buildLabelIndex ref trailing punctuation", () => {
  it("does not absorb a sentence-ending period into the ref name", () => {
    const src = "drawn in @lightcone.";
    const idx = buildLabelIndex(src);
    expect(idx.refs).toHaveLength(1);
    expect(idx.refs[0]!.name).toBe("lightcone");
    expect(src.slice(idx.refs[0]!.start, idx.refs[0]!.end)).toBe("@lightcone");
  });

  it("keeps interior dots and colons in the name", () => {
    const idx = buildLabelIndex("see @sec:intro.fig-1, then @sec:intro.fig-1:");
    expect(idx.refs.map((r) => r.name)).toEqual(["sec:intro.fig-1", "sec:intro.fig-1"]);
  });

  it("a bare @ followed only by punctuation is not a ref", () => {
    expect(buildLabelIndex("a @. b @: c").refs).toEqual([]);
  });
});

// Typst's markup escape: `\@` and `\<` are literal characters. Before this the
// scan read the tail of any escaped email address as a cross-reference, so a CV
// carrying `jane.doe\@example.com` warned "unknown reference @example.com" on
// every compile.
describe("buildLabelIndex escapes", () => {
  it("does not read an escaped email address as a ref", () => {
    expect(buildLabelIndex("Springfield, USA · jane.doe\\@example.com · +1 555").refs).toEqual([]);
  });

  it("does not read an escaped angle bracket as a label def", () => {
    expect(buildLabelIndex("a literal \\<name> in prose").defs).toEqual([]);
  });

  it("still finds a real ref elsewhere in the same line", () => {
    const idx = buildLabelIndex("mail me\\@example.com about @fig-1");
    expect(idx.refs.map((r) => r.name)).toEqual(["fig-1"]);
  });

  it("treats an escaped backslash as escaped, so a following @ is a real ref", () => {
    // `\\` is a literal backslash; the `@fig-1` after it is markup again.
    expect(buildLabelIndex("path\\\\@fig-1").refs.map((r) => r.name)).toEqual(["fig-1"]);
  });

  it("keeps offsets exact for a ref that follows an escape", () => {
    const src = "a\\@b then @fig-1";
    const ref = buildLabelIndex(src).refs[0]!;
    expect(src.slice(ref.start, ref.end)).toBe("@fig-1");
  });

  it("a trailing lone backslash does not run past the end", () => {
    expect(buildLabelIndex("ends with a backslash \\").refs).toEqual([]);
  });
});
