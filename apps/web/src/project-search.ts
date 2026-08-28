/**
 * In-document full-text search (Tier E #2 — "find in files").
 *
 * A PURE, dependency-free helper that scans the LIVE project files for a literal
 * (case-insensitive substring) query and returns ordered, per-file matches the
 * editor can jump to. This is "find in files", NOT semantic retrieval — literal
 * substring matching is the right UX, so there is no BM25/tokenisation here.
 *
 * Offsets are UTF-16 code-unit based (`from`), matching CodeMirror's document
 * model, so a match's `from` feeds the existing `jumpToOffset(view, from)`
 * helper directly. No React, no DOM — unit-tested in the node gate.
 */

/** One project file to search: its id, display path, and full live text. */
export interface SearchInputFile {
  fileId: string;
  path: string;
  text: string;
}

/** A single match within a file. */
export interface SearchMatch {
  /** 1-based line number of the match within the file. */
  line: number;
  /** Absolute UTF-16 offset of the match start (for `jumpToOffset`). */
  from: number;
  /** The full text of the line the match sits on (the result snippet). */
  snippet: string;
  /** Start column of the match WITHIN the line (0-based, for highlighting). */
  columnStart: number;
  /** End column of the match within the line (exclusive). */
  columnEnd: number;
}

/** All matches for one file, in document order. */
export interface SearchFileResult {
  fileId: string;
  path: string;
  matches: SearchMatch[];
  /** True when this file had more matches than `maxMatchesPerFile`. */
  truncated: boolean;
}

/** The full search result: matching files, totals, and a truncation flag. */
export interface SearchResult {
  files: SearchFileResult[];
  /** Total matches across the returned (post-cap) files. */
  totalMatches: number;
  /**
   * TRUE total matches across ALL files, ignoring every cap — so a capped
   * result can still say "showing N of M" honestly (and a replace-all can
   * state exactly how many matches it will NOT touch). Equal to
   * `totalMatches` whenever `truncated` is false.
   */
  totalMatchesAll: number;
  /** True when ANY cap (per-file or file-count) dropped some results. */
  truncated: boolean;
}

export interface SearchOptions {
  /** Cap on matches kept per file (default 50). */
  maxMatchesPerFile?: number;
  /** Cap on files returned (default 30). */
  maxFiles?: number;
}

const DEFAULT_MAX_MATCHES_PER_FILE = 50;
const DEFAULT_MAX_FILES = 30;

/** Absolute offset where each line begins (index 0 == line 1's start). */
function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/**
 * PURE: find every literal, case-insensitive occurrence of `query` across the
 * given files. Empty/whitespace-only queries return no matches. Matches are
 * returned grouped by file (input order preserved, non-matching files omitted),
 * each carrying its 1-based line, absolute offset, line snippet, and in-line
 * column range. Results are capped (per file and by file count); any drop is
 * surfaced via the `truncated` flags so the UI can say "showing first N".
 */
export function searchProjectFiles(
  files: readonly SearchInputFile[],
  query: string,
  opts?: SearchOptions,
): SearchResult {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { files: [], totalMatches: 0, totalMatchesAll: 0, truncated: false };
  }

  const maxMatchesPerFile = opts?.maxMatchesPerFile ?? DEFAULT_MAX_MATCHES_PER_FILE;
  const maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES;
  // Case-insensitive literal match: lowercase the query once and scan (NOT a
  // RegExp — the query is taken verbatim, so "a.b" never matches "axb"). Every
  // matched span is exactly `needleLen` code units of the ORIGINAL text whose
  // lowercase equals the needle, so `from`/`columnEnd` are always valid
  // original-string indices (the invariant replace and highlighting rely on).
  const needle = trimmed.toLowerCase();
  const needleLen = needle.length;

  const results: SearchFileResult[] = [];
  let totalMatches = 0;
  let totalMatchesAll = 0;
  let truncated = false;

  for (const file of files) {
    const text = file.text;
    if (text.length === 0) continue;
    const hay = text.toLowerCase();
    // OFFSET SAFETY: lowercasing can EXPAND some characters ('İ' U+0130 →
    // "i̇", two code units), which would shift every later offset of the
    // lowercased haystack relative to the original. Lowercase mappings never
    // SHRINK a UTF-16 unit count, so equal total length ⇒ every per-character
    // mapping is 1:1 ⇒ `hay` offsets ARE original offsets — the common fast
    // path keeps the cheap indexOf scan. Otherwise fall back to an
    // offset-preserving per-position scan over the ORIGINAL text: a match is a
    // `needleLen`-unit original slice whose lowercase equals the needle (string
    // equality implies equal length, so a length-changing slice never matches).
    const offsetSafe = hay.length === text.length;
    const findNext = offsetSafe
      ? (from: number) => hay.indexOf(needle, from)
      : (from: number) => {
          for (let i = from; i + needleLen <= text.length; i++) {
            if (text.slice(i, i + needleLen).toLowerCase() === needle) return i;
          }
          return -1;
        };

    // A file past the file-count cap is still SCANNED (for the honest grand
    // total) but its matches are never materialised.
    const keepFile = results.length < maxFiles;
    const matches: SearchMatch[] = [];
    let fileMatchCount = 0;
    // Line bookkeeping: walk the offset forward, advancing the current line as
    // we cross newlines so each match knows its line + in-line column cheaply.
    const lineStarts = keepFile ? lineStartOffsets(text) : [];
    let lineIdx = 0;

    let at = findNext(0);
    while (at !== -1) {
      fileMatchCount++;
      if (keepFile && matches.length < maxMatchesPerFile) {
        // Advance to the line containing `at` (matches are found in ascending
        // offset order, so this pointer only ever moves forward).
        while (lineIdx + 1 < lineStarts.length && lineStarts[lineIdx + 1]! <= at) lineIdx++;
        const lineStart = lineStarts[lineIdx]!;
        const lineEnd =
          lineIdx + 1 < lineStarts.length ? lineStarts[lineIdx + 1]! - 1 : text.length;
        matches.push({
          line: lineIdx + 1,
          from: at,
          snippet: text.slice(lineStart, lineEnd),
          columnStart: at - lineStart,
          columnEnd: at - lineStart + needleLen,
        });
      }
      // Non-overlapping scan: resume past this match.
      at = findNext(at + needleLen);
    }

    if (fileMatchCount === 0) continue;
    totalMatchesAll += fileMatchCount;
    if (!keepFile) {
      truncated = true;
      continue;
    }
    const fileTruncated = fileMatchCount > matches.length;
    if (fileTruncated) truncated = true;
    totalMatches += matches.length;
    results.push({
      fileId: file.fileId,
      path: file.path,
      matches,
      truncated: fileTruncated,
    });
  }

  return { files: results, totalMatches, totalMatchesAll, truncated };
}
