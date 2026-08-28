import { describe, it, expect } from "vitest";
import { searchProjectFiles, type SearchInputFile } from "./project-search.js";

/** Tiny helper to build the {fileId, path, text} input rows tersely. */
function file(fileId: string, path: string, text: string): SearchInputFile {
  return { fileId, path, text };
}

describe("searchProjectFiles — empty / no-match", () => {
  const files = [file("a", "/main.typ", "hello world\nsecond line")];

  it("returns no matches for an empty query", () => {
    const r = searchProjectFiles(files, "");
    expect(r.files).toEqual([]);
    expect(r.totalMatches).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it("returns no matches for a whitespace-only query", () => {
    expect(searchProjectFiles(files, "   ").files).toEqual([]);
  });

  it("returns no matches when the query is absent from every file", () => {
    const r = searchProjectFiles(files, "zzz");
    expect(r.files).toEqual([]);
    expect(r.totalMatches).toBe(0);
  });
});

describe("searchProjectFiles — line / offset correctness", () => {
  it("reports a 1-based line, the line snippet, and the in-line column range", () => {
    const r = searchProjectFiles([file("a", "/main.typ", "hello world")], "world");
    expect(r.files).toHaveLength(1);
    const group = r.files[0]!;
    expect(group.fileId).toBe("a");
    expect(group.path).toBe("/main.typ");
    expect(group.matches).toHaveLength(1);
    const m = group.matches[0]!;
    expect(m.line).toBe(1);
    expect(m.from).toBe(6); // absolute offset of "world" in "hello world"
    expect(m.snippet).toBe("hello world");
    expect(m.columnStart).toBe(6);
    expect(m.columnEnd).toBe(11);
  });

  it("computes the absolute offset after preceding newlines", () => {
    // "line1\nline2\ntarget" — "target" begins at offset 12.
    const r = searchProjectFiles([file("a", "/f.typ", "line1\nline2\ntarget")], "target");
    const m = r.files[0]!.matches[0]!;
    expect(m.line).toBe(3);
    expect(m.from).toBe(12);
    expect(m.columnStart).toBe(0);
    expect(m.snippet).toBe("target");
  });

  it("computes the absolute offset after multi-byte (astral) characters", () => {
    // A leading emoji is two UTF-16 code units; "x" then sits at offset 2, and
    // CodeMirror offsets are UTF-16 code-unit based — so `from` must be 2.
    const text = "😀x match here";
    const r = searchProjectFiles([file("a", "/f.typ", text)], "match");
    const m = r.files[0]!.matches[0]!;
    expect(m.from).toBe(text.indexOf("match"));
    expect(m.line).toBe(1);
  });
});

describe("searchProjectFiles — multiple matches", () => {
  it("finds every non-overlapping match on a single line, in order", () => {
    const r = searchProjectFiles([file("a", "/f.typ", "ab ab ab")], "ab");
    const cols = r.files[0]!.matches.map((m) => m.columnStart);
    expect(cols).toEqual([0, 3, 6]);
    expect(r.files[0]!.matches.map((m) => m.from)).toEqual([0, 3, 6]);
    expect(r.totalMatches).toBe(3);
  });

  it("groups matches across multiple lines under the same file", () => {
    const r = searchProjectFiles([file("a", "/f.typ", "foo\nbar foo\nfoo")], "foo");
    const lines = r.files[0]!.matches.map((m) => m.line);
    expect(lines).toEqual([1, 2, 3]);
    expect(r.files[0]!.matches[1]!.columnStart).toBe(4); // "foo" after "bar "
  });

  it("returns one group per matching file, preserving input order", () => {
    const r = searchProjectFiles(
      [
        file("a", "/a.typ", "alpha beta"),
        file("b", "/b.typ", "gamma beta delta"),
        file("c", "/c.typ", "nothing here"),
      ],
      "beta",
    );
    expect(r.files.map((g) => g.fileId)).toEqual(["a", "b"]); // c has no match → omitted
    expect(r.totalMatches).toBe(2);
  });
});

describe("searchProjectFiles — case insensitivity", () => {
  it("matches regardless of case and preserves the original snippet casing", () => {
    const r = searchProjectFiles([file("a", "/f.typ", "Hello HELLO hello")], "hello");
    expect(r.files[0]!.matches.map((m) => m.columnStart)).toEqual([0, 6, 12]);
    expect(r.files[0]!.matches[0]!.snippet).toBe("Hello HELLO hello"); // snippet keeps original case
  });
});

describe("searchProjectFiles — truncation caps", () => {
  it("caps matches per file and flags truncation", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} needle`).join("\n");
    const r = searchProjectFiles([file("a", "/f.typ", text)], "needle", { maxMatchesPerFile: 10 });
    expect(r.files[0]!.matches).toHaveLength(10);
    expect(r.files[0]!.truncated).toBe(true);
    expect(r.truncated).toBe(true);
  });

  it("caps the number of files and flags truncation", () => {
    const files = Array.from({ length: 8 }, (_, i) => file(`f${i}`, `/f${i}.typ`, "needle"));
    const r = searchProjectFiles(files, "needle", { maxFiles: 3 });
    expect(r.files).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });

  it("does not flag truncation when everything fits under the caps", () => {
    const r = searchProjectFiles([file("a", "/f.typ", "needle once")], "needle");
    expect(r.truncated).toBe(false);
    expect(r.files[0]!.truncated).toBe(false);
  });
});

describe("searchProjectFiles — honest grand totals (totalMatchesAll)", () => {
  it("equals totalMatches when nothing is capped", () => {
    const r = searchProjectFiles([file("a", "/f.typ", "x y x")], "x");
    expect(r.totalMatches).toBe(2);
    expect(r.totalMatchesAll).toBe(2);
  });

  it("counts BEYOND the per-file cap", () => {
    const text = Array.from({ length: 7 }, () => "needle").join(" ");
    const r = searchProjectFiles([file("a", "/f.typ", text)], "needle", { maxMatchesPerFile: 3 });
    expect(r.totalMatches).toBe(3);
    expect(r.totalMatchesAll).toBe(7);
    expect(r.truncated).toBe(true);
  });

  it("counts matches in files DROPPED by the file-count cap", () => {
    const files = Array.from({ length: 5 }, (_, i) =>
      file(`f${i}`, `/f${i}.typ`, "needle needle"),
    );
    const r = searchProjectFiles(files, "needle", { maxFiles: 2 });
    expect(r.files).toHaveLength(2);
    expect(r.totalMatches).toBe(4);
    expect(r.totalMatchesAll).toBe(10);
    expect(r.truncated).toBe(true);
  });
});

describe("searchProjectFiles — Unicode offset preservation", () => {
  it("offsets index the ORIGINAL text when lowercasing expands a character ('İ' → 2 units)", () => {
    // 'İ' (U+0130) lowercases to "i̇" (2 code units): a whole-string-lowercase
    // scan would report the match one unit too far right. The offsets must be
    // valid indices into the ORIGINAL string ("İ cat": 'İ'=0, ' '=1, 'c'=2).
    const r = searchProjectFiles([file("a", "/f.typ", "İ cat mat")], "cat");
    expect(r.totalMatches).toBe(1);
    const m = r.files[0]!.matches[0]!;
    expect(m.from).toBe(2);
    expect(m.columnStart).toBe(2);
    expect(m.columnEnd).toBe(5);
    expect(m.snippet).toBe("İ cat mat");
    expect("İ cat mat".slice(m.from, m.from + 3)).toBe("cat");
  });

  it("matches across later lines after an expanding character without offset drift", () => {
    const text = "İİİ x\ncat here";
    const r = searchProjectFiles([file("a", "/f.typ", text)], "cat");
    const m = r.files[0]!.matches[0]!;
    expect(m.line).toBe(2);
    expect(text.slice(m.from, m.from + 3)).toBe("cat");
    expect(m.columnStart).toBe(0);
  });

  it("ẞ (capital sharp s) is length-preserving and matches ß at the right offsets", () => {
    // "GROẞ groß": ẞ (U+1E9E) lowercases to ß (1 unit) — the fast path. The
    // query "ß" must hit BOTH the ẞ at 3 and the ß at 8.
    const r = searchProjectFiles([file("a", "/f.typ", "GROẞ groß")], "ß");
    expect(r.files[0]!.matches.map((m) => m.from)).toEqual([3, 8]);
  });

  it("a query that lowercases wider than itself ('İ') matches its lowercase form, span = lowercased width", () => {
    // Query 'İ' (U+0130) lowercases to "i̇" (i + combining dot, 2 units).
    // The text carries exactly that 2-unit sequence at offset 3 (written as
    // an explicit escape so source normalization can never collapse it).
    const text = "ab i\u0307 cd";
    const r = searchProjectFiles([file("a", "/f.typ", text)], "İ");
    expect(r.totalMatches).toBe(1);
    const m = r.files[0]!.matches[0]!;
    expect(m.from).toBe(3);
    expect(m.columnEnd - m.columnStart).toBe(2);
  });

  it("documented semantics: a length-CHANGING span never matches (text 'İ' vs query 'İ')", () => {
    // Matching is length-preserving by design: the 1-unit 'İ' in the text
    // cannot equal the 2-unit lowercased needle without shifting offsets, so
    // it is not reported (and replace can never corrupt around it).
    const r = searchProjectFiles([file("a", "/f.typ", "İ")], "İ");
    expect(r.totalMatches).toBe(0);
  });

  it("Turkish dotless ı stays distinct: query 'i' matches 'I' but never 'ı'", () => {
    const r = searchProjectFiles([file("a", "/f.typ", "Iı")], "i");
    expect(r.files[0]!.matches.map((m) => m.from)).toEqual([0]);
  });
});

describe("searchProjectFiles — robustness", () => {
  it("treats the query literally (no regex interpretation)", () => {
    const r = searchProjectFiles([file("a", "/f.typ", "a.b a.b axb")], "a.b");
    // Literal: only the two "a.b" substrings match, NOT "axb".
    expect(r.totalMatches).toBe(2);
  });

  it("skips files with empty text", () => {
    const r = searchProjectFiles([file("a", "/f.typ", ""), file("b", "/g.typ", "found")], "found");
    expect(r.files.map((g) => g.fileId)).toEqual(["b"]);
  });
});
