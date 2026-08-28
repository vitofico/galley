import { describe, it, expect } from "vitest";
import { SourceMapper } from "./offset-map.js";

describe("SourceMapper.byteToUtf16", () => {
  it("is the identity for pure ASCII", () => {
    const m = new SourceMapper("hello world");
    expect(m.byteToUtf16(0)).toBe(0);
    expect(m.byteToUtf16(6)).toBe(6);
    expect(m.byteToUtf16(11)).toBe(11);
  });

  it("maps past a 2-byte char (é) — 2 UTF-8 bytes, 1 UTF-16 unit", () => {
    // "café": c a f = 3 bytes/3 units; é = U+00E9 = 2 bytes, 1 unit.
    const m = new SourceMapper("café");
    expect(m.length).toBe(4);
    expect(m.byteToUtf16(3)).toBe(3); // start of é
    expect(m.byteToUtf16(5)).toBe(4); // end of string (past é)
  });

  it("maps past an astral char (😀) — 4 UTF-8 bytes, 2 UTF-16 units", () => {
    // "a😀b": a = 1/1; 😀 = U+1F600 = 4 bytes, 2 units (surrogate pair); b = 1/1.
    const m = new SourceMapper("a😀b");
    expect(m.length).toBe(4);
    expect(m.byteToUtf16(1)).toBe(1); // start of emoji
    expect(m.byteToUtf16(5)).toBe(3); // start of 'b' (after the 4-byte emoji)
    expect(m.byteToUtf16(6)).toBe(4); // end of string
  });

  it("rounds down when a byte offset lands inside a multi-byte sequence", () => {
    const m = new SourceMapper("é"); // 2 bytes, 1 unit
    expect(m.byteToUtf16(1)).toBe(0); // mid-codepoint -> start of é
    expect(m.byteToUtf16(2)).toBe(1);
  });

  it("clamps out-of-range byte offsets", () => {
    const m = new SourceMapper("abc");
    expect(m.byteToUtf16(-5)).toBe(0);
    expect(m.byteToUtf16(999)).toBe(3);
  });
});

describe("SourceMapper.positionAt", () => {
  it("gives 1-based line/column for ASCII across newlines", () => {
    const m = new SourceMapper("hello\nworld");
    expect(m.positionAt(0)).toEqual({ line: 1, column: 1 });
    expect(m.positionAt(5)).toEqual({ line: 1, column: 6 }); // the '\n' itself
    expect(m.positionAt(6)).toEqual({ line: 2, column: 1 }); // 'w'
    expect(m.positionAt(11)).toEqual({ line: 2, column: 6 }); // end
  });

  it("counts columns in UTF-16 units, unaffected by prior byte width", () => {
    // "é\nx": é = 1 UTF-16 unit on line 1; 'x' is line 2 col 1.
    const m = new SourceMapper("é\nx");
    expect(m.positionAt(0)).toEqual({ line: 1, column: 1 }); // é
    expect(m.positionAt(2)).toEqual({ line: 2, column: 1 }); // x
  });

  it("handles the empty string", () => {
    const m = new SourceMapper("");
    expect(m.length).toBe(0);
    expect(m.positionAt(0)).toEqual({ line: 1, column: 1 });
  });

  it("clamps out-of-range offsets to the end", () => {
    const m = new SourceMapper("ab\ncd");
    expect(m.positionAt(999)).toEqual({ line: 2, column: 3 });
  });
});

describe("SourceMapper.spanFromBytes", () => {
  it("normalizes a byte range into offsets + derived positions", () => {
    // Underline "world" (bytes 6..11) in "hello\nworld".
    const m = new SourceMapper("hello\nworld");
    expect(m.spanFromBytes(6, 11)).toEqual({
      offset: 6,
      endOffset: 11,
      start: { line: 2, column: 1 },
      end: { line: 2, column: 6 },
    });
  });

  it("derives a correct span when multi-byte chars precede it", () => {
    // "é = 1" — error on the '1' (a number). Bytes: é(2) space(1) =(1) space(1) -> '1' at byte 5.
    const src = "é = 1";
    const m = new SourceMapper(src);
    // '1' is UTF-16 index 4 (é=1, space=1, '='=1, space=1).
    expect(m.spanFromBytes(5, 6)).toEqual({
      offset: 4,
      endOffset: 5,
      start: { line: 1, column: 5 },
      end: { line: 1, column: 6 },
    });
  });
});
