/**
 * Roadmap #13 slice 3 — broken-reference diagnostics: the PURE, offline,
 * framework-free composition core.
 *
 * Typst overloads the `@` sigil: `@fig-1` is a cross-reference (resolved against
 * a `<fig-1>` label) while `@smith2020` is a citation (resolved against a
 * bibliography). The label core in `./labels.js` cannot tell them apart, so
 * `findBrokenRefs` over-reports — it flags every `@key` that lacks a `<key>`,
 * including legitimate citations.
 *
 * This module resolves that ambiguity by COMPOSING the label index with a set of
 * known citation keys SUPPLIED BY THE CALLER. We never import a bibliography
 * module; `citeKeys` is consumed as a general `Iterable<string>` so the caller
 * may pass a `Set`, an array, or a generator.
 *
 * No React, no DOM, no CodeMirror, no I/O — deterministic functions over a
 * string (plus an iterable of keys). Only dependencies are `./labels.js` and the
 * `Diagnostic` TYPE from `@galley/shared`.
 */
import type { Diagnostic, SourceSpan, SourcePosition } from "@galley/shared";
import {
  buildLabelIndex,
  findBrokenRefs,
  findUnusedLabels,
} from "./labels.js";
import { stripTypstComments } from "./typst-comments.js";

/**
 * Derive a 1-based line/column position from an absolute UTF-16 offset.
 * Lines are split on `\n`; a `\r` (CRLF) sits at the end of its line so column
 * arithmetic stays in UTF-16 code units and matches CodeMirror/JS strings.
 */
function positionAt(source: string, offset: number): SourcePosition {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (source[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/** Build a `SourceSpan` from absolute offsets (`end` exclusive). */
function spanAt(source: string, offset: number, endOffset: number): SourceSpan {
  return {
    offset,
    endOffset,
    start: positionAt(source, offset),
    end: positionAt(source, endOffset),
  };
}

/**
 * Broken cross-reference diagnostics for `source`, composed with the caller's
 * known citation keys.
 *
 * For each `@ref` use whose name is neither a defined `<label>` nor a member of
 * `citeKeys`, emit a `severity:"warning"` diagnostic spanning the ref token.
 * A name that IS a citation key is a citation (not flagged); a name that IS a
 * defined label resolves cleanly (not flagged). Every broken occurrence is
 * reported in document order.
 *
 * `citeKeys` is consumed as a general `Iterable<string>` (Set, array, or
 * generator). It is read exactly once and never mutated.
 */
export function refDiagnostics(
  source: string,
  citeKeys: Iterable<string>,
): Diagnostic[] {
  const cites = new Set(citeKeys);
  // Index the COMMENT-STRIPPED text (#20.2): `@…` inside a comment or raw
  // block is text, not a reference. The strip preserves length and newlines,
  // so the index's offsets are valid in the original `source` for `spanAt`.
  const index = buildLabelIndex(stripTypstComments(source));
  const diagnostics: Diagnostic[] = [];

  for (const ref of findBrokenRefs(index)) {
    if (cites.has(ref.name)) continue; // a citation, not a broken cross-reference
    diagnostics.push({
      severity: "warning",
      message: `unknown reference @${ref.name}`,
      span: spanAt(source, ref.start, ref.end),
      hints: [
        `define a label <${ref.name}> in this document, or add "${ref.name}" to the bibliography`,
      ],
    });
  }

  return diagnostics;
}

/**
 * Diagnostics for labels that are defined but never referenced. Each unused
 * `<label>` yields a `severity:"warning"` spanning the def token. Pure and
 * independent of citation keys (an unused label is unused regardless of cites).
 */
export function unusedLabelDiagnostics(source: string): Diagnostic[] {
  // Same comment/raw strip as `refDiagnostics` (#20.2): a `<label>` inside a
  // comment is not a definition, so it must be neither "unused" nor able to
  // satisfy a real `@ref`. Offsets are preserved, so spans stay exact.
  const index = buildLabelIndex(stripTypstComments(source));
  return findUnusedLabels(index).map((def) => ({
    severity: "warning",
    message: `unused label <${def.name}>`,
    span: spanAt(source, def.start, def.end),
    hints: [`reference it with @${def.name}, or remove the label`],
  }));
}
