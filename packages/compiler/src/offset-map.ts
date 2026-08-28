/**
 * Source position mapping: Typst's UTF-8 byte offsets <-> the editor's UTF-16
 * world.
 *
 * Typst reports diagnostic spans as **byte offsets into the UTF-8 source**.
 * CodeMirror and JS strings are **UTF-16**. The `Diagnostic` contract
 * (`@galley/shared`) canonicalizes on UTF-16 offsets with **1-based** line/
 * column derived from them (see docs/compiler.md, "Diagnostics normalization").
 *
 * This is the M0 spike the compiler doc flags as a silent off-by-one hazard:
 * multi-byte characters (é = 2 UTF-8 bytes, 1 UTF-16 unit) and astral
 * characters (😀 = 4 UTF-8 bytes, 2 UTF-16 units / a surrogate pair) make the
 * naive `offset === index` assumption wrong. It is pure and fully unit-tested
 * before any WASM is wired on top.
 */

import type { SourcePosition, SourceSpan } from "@galley/shared";

/** UTF-8 bytes used to encode a single Unicode code point. */
function utf8Len(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** UTF-16 code units for a code point (2 for astral chars, via surrogates). */
function utf16Len(codePoint: number): number {
  return codePoint > 0xffff ? 2 : 1;
}

/**
 * Precomputed view over a source string for converting compiler byte offsets
 * into UTF-16 offsets and 1-based line/column positions. Build once per source
 * (per compile); reuse for every diagnostic.
 */
export class SourceMapper {
  private readonly source: string;
  /** UTF-16 index at which each line begins; `lineStarts[0] === 0`. */
  private readonly lineStarts: number[];

  constructor(source: string) {
    this.source = source;
    const starts = [0];
    for (let i = 0; i < source.length; i++) {
      // 0x0a === '\n'. CR is treated as ordinary text; the app normalizes line
      // endings to '\n' before compiling (see docs/editing-and-diff.md).
      if (source.charCodeAt(i) === 0x0a) starts.push(i + 1);
    }
    this.lineStarts = starts;
  }

  /** Length of the source in UTF-16 code units. */
  get length(): number {
    return this.source.length;
  }

  /**
   * Convert a Typst UTF-8 byte offset into a UTF-16 string index.
   *
   * Clamps to `[0, length]`. If the byte offset lands inside a multi-byte
   * sequence (it should not, for real compiler spans) it rounds **down** to the
   * start of that code point rather than guessing.
   */
  byteToUtf16(byteOffset: number): number {
    if (byteOffset <= 0) return 0;
    let bytes = 0;
    let units = 0;
    for (const ch of this.source) {
      if (bytes >= byteOffset) break;
      const cp = ch.codePointAt(0)!;
      const b = utf8Len(cp);
      if (bytes + b > byteOffset) break; // offset is inside this code point
      bytes += b;
      units += utf16Len(cp);
    }
    return units;
  }

  /**
   * 1-based line/column for a UTF-16 offset. Column is in UTF-16 code units to
   * match CodeMirror. Clamps the offset to `[0, length]`.
   */
  positionAt(utf16Offset: number): SourcePosition {
    const offset = Math.max(0, Math.min(utf16Offset, this.length));
    // Greatest line start <= offset (binary search).
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    const lineStart = this.lineStarts[lo] ?? 0;
    return { line: lo + 1, column: offset - lineStart + 1 };
  }

  /**
   * UTF-16 offset for a 0-based (line, column). The inverse of `positionAt`,
   * used to canonicalize Typst's `line:column` diagnostic ranges into offsets.
   * Column is in UTF-16 code units; both are clamped into range, and the column
   * is clamped to the end of its line (never spilling past the newline).
   */
  offsetAt(line0: number, column0: number): number {
    const li = Math.max(0, Math.min(line0, this.lineStarts.length - 1));
    const base = this.lineStarts[li] ?? 0;
    const next = this.lineStarts[li + 1];
    const lineEnd = next !== undefined ? next - 1 : this.length; // exclude the '\n'
    return Math.min(base + Math.max(0, column0), lineEnd);
  }

  /** Build a normalized `SourceSpan` from a Typst UTF-8 byte range. */
  spanFromBytes(startByte: number, endByte: number): SourceSpan {
    const offset = this.byteToUtf16(startByte);
    const endOffset = this.byteToUtf16(endByte);
    return {
      offset,
      endOffset,
      start: this.positionAt(offset),
      end: this.positionAt(endOffset),
    };
  }
}
