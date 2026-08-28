import { describe, it, expect } from "vitest";
import { applyEdits, normalizeNewlines } from "./apply-edits.js";

describe("applyEdits — success", () => {
  it("applies a single unique block", () => {
    const r = applyEdits("hello world", [{ search: "world", replace: "Typst" }]);
    expect(r).toEqual({ ok: true, source: "hello Typst", failures: [] });
  });

  it("applies blocks sequentially; a later search sees the earlier replacement", () => {
    const r = applyEdits("a b c", [
      { search: "a", replace: "x" },
      { search: "x b", replace: "y" }, // only matches after block 1 applied
    ]);
    expect(r.ok).toBe(true);
    expect(r.source).toBe("y c");
  });

  it("normalizes CRLF before matching and in output", () => {
    const r = applyEdits("line1\r\nline2", [{ search: "line1\nline2", replace: "ok" }]);
    expect(r).toEqual({ ok: true, source: "ok", failures: [] });
  });

  it("leaves the document unchanged for an empty block list", () => {
    const r = applyEdits("untouched", []);
    expect(r).toEqual({ ok: true, source: "untouched", failures: [] });
  });
});

describe("applyEdits — structured failures", () => {
  it("reports no_match when the search string is absent", () => {
    const r = applyEdits("hello", [{ search: "absent", replace: "x" }]);
    expect(r.ok).toBe(false);
    expect(r.source).toBe("hello");
    expect(r.failures).toEqual([{ block: { search: "absent", replace: "x" }, reason: "no_match" }]);
  });

  it("treats an empty search as no_match (never matches everything)", () => {
    const r = applyEdits("hello", [{ search: "", replace: "x" }]);
    expect(r.ok).toBe(false);
    expect(r.failures[0]!.reason).toBe("no_match");
  });

  it("reports multiple_matches with a count when ambiguous", () => {
    const r = applyEdits("foo foo foo", [{ search: "foo", replace: "bar" }]);
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toEqual({
      block: { search: "foo", replace: "bar" },
      reason: "multiple_matches",
      matchCount: 3,
    });
  });

  it("reports overlap when a block edits text just inserted by an earlier block", () => {
    const r = applyEdits("one two three", [
      { search: "two", replace: "two XYZ" }, // inserts XYZ
      { search: "XYZ", replace: "ZZZ" }, // edits inside block 1's span
    ]);
    expect(r.ok).toBe(false);
    const reasons = r.failures.map((f) => f.reason);
    expect(reasons).toContain("overlap");
  });

  it("reports overlap when a block's match is exactly a previous insertion", () => {
    const r = applyEdits("a b", [
      { search: "a", replace: "INS" }, // inserts INS, span covers exactly "INS"
      { search: "INS", replace: "x" }, // match == the insertion span
    ]);
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.reason)).toContain("overlap");
  });

  it("ALLOWS a later match that includes a prior insertion but anchors on original text", () => {
    // Rule 3: a later search may see an earlier replacement. "abcdef": replace
    // "cd"->"XYZ", then "YZe" (partly inserted YZ, partly original e) must apply,
    // not be rejected as overlap. (Guards against an over-eager "reject any
    // intersection" change — that would break sequential visibility.)
    const r = applyEdits("abcdef", [
      { search: "cd", replace: "XYZ" }, // -> "abXYZef"
      { search: "YZe", replace: "Q" }, // anchors on original "e" -> "abXQf"
    ]);
    expect(r.ok).toBe(true);
    expect(r.source).toBe("abXQf");
  });
});

describe("applyEdits — all-or-nothing", () => {
  it("mutates nothing and lists every failure when any block fails", () => {
    const r = applyEdits("alpha beta", [
      { search: "alpha", replace: "ALPHA" }, // would succeed alone
      { search: "missing", replace: "x" }, // fails
    ]);
    expect(r.ok).toBe(false);
    expect(r.source).toBe("alpha beta"); // unchanged — no partial mutation
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]!.reason).toBe("no_match");
  });

  it("returns the source byte-for-byte unchanged on failure (incl. CRLF)", () => {
    const crlf = "line1\r\nline2";
    const r = applyEdits(crlf, [{ search: "absent", replace: "x" }]);
    expect(r.ok).toBe(false);
    expect(r.source).toBe(crlf); // not newline-normalized — truly unchanged
  });

  it("collects EVERY failure in a batch, not just the first", () => {
    const r = applyEdits("foo foo bar", [
      { search: "nope", replace: "x" }, // no_match
      { search: "foo", replace: "y" }, // multiple_matches (2)
    ]);
    expect(r.ok).toBe(false);
    expect(r.source).toBe("foo foo bar");
    const byReason = Object.fromEntries(r.failures.map((f) => [f.reason, f]));
    expect(byReason.no_match).toBeDefined();
    expect(byReason.multiple_matches).toMatchObject({ matchCount: 2 });
    expect(r.failures).toHaveLength(2);
  });
});

describe("applyEdits — coordinate shifting", () => {
  it("keeps later applied spans correct when an earlier block shrinks the source (negative delta)", () => {
    // Block A (later in the string) inserts a token; Block B (earlier) shrinks
    // the text before it, shifting A's recorded span backward. Block C then
    // tries to edit exactly A's (shifted) insertion and must still be caught.
    const r = applyEdits("AAAA middle INSERT-HERE", [
      { search: "INSERT-HERE", replace: "TOKEN" }, // applied span near the end
      { search: "AAAA", replace: "B" }, // negative delta (-3): shifts the span left
      { search: "TOKEN", replace: "x" }, // exactly the shifted insertion -> overlap
    ]);
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.reason)).toContain("overlap");
    expect(r.source).toBe("AAAA middle INSERT-HERE"); // all-or-nothing
  });

  it("succeeds across a negative-delta shift when edits are independent", () => {
    const r = applyEdits("AAAA middle ZZZZ", [
      { search: "ZZZZ", replace: "z" },
      { search: "AAAA", replace: "a" }, // shifts nothing it touches; independent
    ]);
    expect(r.ok).toBe(true);
    expect(r.source).toBe("a middle z");
  });
});

describe("normalizeNewlines", () => {
  it("collapses CRLF and lone CR to LF", () => {
    expect(normalizeNewlines("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
});
