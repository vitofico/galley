/**
 * Roadmap #13 slice 3 — cross-file label index: the PURE, offline,
 * framework-free composition core for multi-file projects.
 *
 * Typst resolves a `@ref` against any `<label>` visible in the COMPILED PROJECT,
 * not just the file the ref appears in. The single-file `refDiagnostics`
 * (`./ref-check.js`) only sees one file's labels, so in a multi-file project it
 * would FALSELY flag a `@ref` that resolves to a `<label>` defined in a SIBLING
 * file. This module fixes that by composing the label union across ALL project
 * files, then scanning each file's refs against that union (plus the caller's
 * citation keys).
 *
 * Findings are PATH-QUALIFIED: every emitted `Diagnostic` carries the `path` of
 * the file it belongs to, and its `span` offsets index into THAT file's text
 * (`end` exclusive, UTF-16 code units), so callers can map findings back to the
 * right editor buffer.
 *
 * No React, no DOM, no CodeMirror, no I/O — deterministic functions over text.
 * Only dependencies are `./labels.js` and the `Diagnostic` TYPE from
 * `@galley/shared`.
 */
import type { Diagnostic, SourceSpan, SourcePosition } from "@galley/shared";
import { buildLabelIndex, findBrokenRefs, labelNames } from "./labels.js";
import { stripTypstComments } from "./typst-comments.js";

/** One in-project text file: its project path and its full source text. */
export interface ProjectTextFile {
  path: string;
  text: string;
}

/**
 * Derive a 1-based line/column from an absolute UTF-16 offset into `source`.
 * Lines split on `\n`; a `\r` (CRLF) sits at the end of its line so column
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

/** Build a `SourceSpan` from absolute offsets into `source` (`end` exclusive). */
function spanAt(source: string, offset: number, endOffset: number): SourceSpan {
  return {
    offset,
    endOffset,
    start: positionAt(source, offset),
    end: positionAt(source, endOffset),
  };
}

/**
 * The UNION of every `<label>` name defined across all project files.
 *
 * `files` is consumed as a general `Iterable<ProjectTextFile>` (array, Set, or
 * generator), read once and never mutated. Names are deduped via the returned
 * `Set`.
 */
export function allProjectLabelNames(
  files: Iterable<ProjectTextFile>,
): Set<string> {
  const names = new Set<string>();
  for (const file of files) {
    // Strip comments/raw first (#20.2): a `<label>` inside a comment is text,
    // not a definition, and must not enter the project-wide union.
    for (const name of labelNames(buildLabelIndex(stripTypstComments(file.text)))) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Project-aware broken cross-reference diagnostics.
 *
 * For EACH file, flag a `@ref` whose name is NOT in the project-wide label
 * union AND NOT a citation key. Crucially, a `@ref` that resolves to a `<label>`
 * defined in ANY file (not just its own) is NOT flagged — this is the cross-file
 * bug that the single-file scan cannot fix. Each finding is `severity:"warning"`,
 * carries the offending file's `path`, and spans the ref token within THAT
 * file's text. Refs are reported in document order, file by file.
 *
 * Both `files` and `citeKeys` are consumed as general iterables (array, Set, or
 * generator); each is read once and never mutated. NOTE: `files` must be
 * materialized because the union requires a full pass before per-file scanning.
 */
export function crossFileRefDiagnostics(
  files: Iterable<ProjectTextFile>,
  citeKeys: Iterable<string>,
): Diagnostic[] {
  const projectFiles = [...files];
  const labelUnion = allProjectLabelNames(projectFiles);
  const cites = new Set(citeKeys);

  const diagnostics: Diagnostic[] = [];
  for (const file of projectFiles) {
    // Scan the COMMENT-STRIPPED text (#20.2): `@…` in a comment/raw block is
    // text, not a reference (the demo's main.typ mentions `@preview` in its
    // header comment). The strip preserves length and newlines, so offsets
    // index into the ORIGINAL `file.text` unchanged for `spanAt`.
    const index = buildLabelIndex(stripTypstComments(file.text));
    // Start from the file-local broken refs, then resolve each against the
    // cross-file union and the cite keys (the local index already excluded refs
    // that match a same-file label, so we only need the extra resolution here).
    for (const ref of findBrokenRefs(index)) {
      if (labelUnion.has(ref.name)) continue; // resolves to a label in some file
      if (cites.has(ref.name)) continue; // a citation, not a broken cross-reference
      diagnostics.push({
        severity: "warning",
        message: `unknown reference @${ref.name}`,
        span: spanAt(file.text, ref.start, ref.end),
        hints: [
          `define a label <${ref.name}> somewhere in this project, or add "${ref.name}" to the bibliography`,
        ],
        path: file.path,
      });
    }
  }

  return diagnostics;
}
