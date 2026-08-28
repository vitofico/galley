/**
 * Find-and-replace planning for the project search panel (feature #4).
 *
 * PURE, dependency-free helpers that turn a search query + replacement string
 * into per-file replacement PLANS: the ordered match spans and the computed
 * next text for every affected file. Matching is delegated to
 * {@link searchProjectFiles} — the SAME literal, case-insensitive,
 * left-to-right non-overlapping scan (and the same display caps) — so what the
 * search panel SHOWS is exactly what a replace CHANGES, span for span. The
 * search scan guarantees its offsets index the ORIGINAL text (Unicode
 * lowercasing that would shift offsets is handled there), and every matched
 * span is exactly the LOWERCASED trimmed query's code-unit length.
 *
 * Replacement is a SINGLE pass over spans found in the ORIGINAL text: a
 * replacement string that itself contains the query is inserted verbatim and
 * never rescanned, so there is no replace loop. The actual CRDT write is the
 * caller's job — {@link applyReplaceChanges} drives it through a minimal
 * structural seam (the host supplies transact/read/write over its Y.Doc) and
 * enforces the ALL-OR-NOTHING base check: every change carries the text it
 * was planned FROM, and if ANY affected file's live text has since diverged
 * (a concurrent local or remote edit), the whole transaction applies nothing
 * — a stale plan can never clobber a collaborator's edit.
 */
import {
  searchProjectFiles,
  type SearchInputFile,
  type SearchOptions,
} from "./project-search.js";

/** One half-open [from, to) span to replace, in UTF-16 code-unit offsets. */
export interface ReplaceSpan {
  from: number;
  to: number;
}

/** The full replacement plan for one file. */
export interface FileReplacePlan {
  fileId: string;
  path: string;
  /** The matched spans (document order, non-overlapping) in `prevText`. */
  spans: ReplaceSpan[];
  /** The file text the plan was computed FROM (the apply base + undo source). */
  prevText: string;
  /** The file text after replacing every span. */
  nextText: string;
}

/** A whole-project replacement plan. */
export interface ReplacePlan {
  /** Affected files only (files without a match are omitted), input order. */
  files: FileReplacePlan[];
  /** Replacements this plan will perform (the matches search SHOWS). */
  totalReplacements: number;
  /** TRUE total matches ignoring caps — `> totalReplacements` iff truncated. */
  totalMatchesAll: number;
  /** True when the search caps dropped some matches (replace follows suit). */
  truncated: boolean;
}

/**
 * One file's replacement to apply: its id, the full text the plan was computed
 * FROM (`beforeText`, the conflict-check base), and the full target text.
 */
export interface ReplaceChange {
  fileId: string;
  /** The live text this change EXPECTS — apply must abort if it diverged. */
  beforeText: string;
  nextText: string;
}

/**
 * The minimal CRDT seam {@link applyReplaceChanges} drives. The host wires it
 * to its project doc: `transact` wraps ONE author-tagged `doc.transact`,
 * `read` returns a file's current text (undefined when unknown), and `write`
 * lands a file's full target text (e.g. via `applyMinimalDiff`).
 */
export interface ReplaceDocAccess {
  transact(fn: () => void): void;
  read(fileId: string): string | undefined;
  write(fileId: string, nextText: string): void;
}

/**
 * Apply a set of replace changes ALL-OR-NOTHING inside one transaction.
 *
 * INSIDE the transaction (so nothing can interleave between check and write),
 * every affected file's live text is compared to the change's `beforeText`
 * base; on ANY mismatch — a concurrent local or remote edit landed since the
 * plan was computed — the transaction performs NO writes and false is
 * returned, so a stale plan can never silently overwrite a collaborator's
 * edit. Returns true only when every file matched and every write applied.
 * Used for replace-all, the per-match replace, AND the undo inverse (whose
 * base is the post-replace text), giving all three the same TOCTOU discipline.
 */
export function applyReplaceChanges(
  access: ReplaceDocAccess,
  changes: readonly ReplaceChange[],
): boolean {
  if (changes.length === 0) return false;
  let applied = false;
  access.transact(() => {
    for (const change of changes) {
      if (access.read(change.fileId) !== change.beforeText) return;
    }
    for (const change of changes) {
      access.write(change.fileId, change.nextText);
    }
    applied = true;
  });
  return applied;
}

/**
 * PURE: stitch `text` back together with `replacement` substituted into each
 * span. Spans must be ascending and non-overlapping (as produced by the search
 * scan); everything outside them is copied byte-for-byte.
 */
export function applySpans(
  text: string,
  spans: readonly ReplaceSpan[],
  replacement: string,
): string {
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.from) + replacement;
    cursor = span.to;
  }
  return out + text.slice(cursor);
}

/**
 * PURE: plan a replace-all of `query` → `replacement` across `files`, reusing
 * {@link searchProjectFiles} (literal, case-insensitive, trimmed query,
 * left-to-right non-overlapping, default display caps) so the plan covers
 * exactly the matches the search panel shows. Returns the affected files with
 * their spans + computed next text, the shown/true totals, and the truncation
 * flag. Span length is the LOWERCASED trimmed query's length — the search
 * scan's match-width invariant (original-case length can differ: 'İ' → "i̇").
 */
export function planReplacements(
  files: readonly SearchInputFile[],
  query: string,
  replacement: string,
  opts?: SearchOptions,
): ReplacePlan {
  const found = searchProjectFiles(files, query, opts);
  const matchLen = query.trim().toLowerCase().length;
  const byId = new Map(files.map((f) => [f.fileId, f]));

  const planned: FileReplacePlan[] = [];
  for (const group of found.files) {
    const src = byId.get(group.fileId);
    if (!src) continue; // defensive: search only returns ids from `files`
    const spans = group.matches.map((m) => ({ from: m.from, to: m.from + matchLen }));
    planned.push({
      fileId: group.fileId,
      path: group.path,
      spans,
      prevText: src.text,
      nextText: applySpans(src.text, spans, replacement),
    });
  }

  return {
    files: planned,
    totalReplacements: found.totalMatches,
    totalMatchesAll: found.totalMatchesAll,
    truncated: found.truncated,
  };
}

/**
 * PURE: plan replacing the SINGLE match at `from` in file `fileId` (the
 * per-result "Replace" button). Validates that the trimmed query still sits at
 * that offset (case-insensitively, length-preserving — the same invariant the
 * search scan guarantees) so a stale row — the text changed under the panel —
 * yields null instead of corrupting unrelated text.
 */
export function planSingleReplacement(
  files: readonly SearchInputFile[],
  fileId: string,
  from: number,
  query: string,
  replacement: string,
): FileReplacePlan | null {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return null;
  const src = files.find((f) => f.fileId === fileId);
  if (!src) return null;
  const to = from + needle.length;
  if (from < 0 || to > src.text.length) return null;
  if (src.text.slice(from, to).toLowerCase() !== needle) return null;
  const spans = [{ from, to }];
  return {
    fileId,
    path: src.path,
    spans,
    prevText: src.text,
    nextText: applySpans(src.text, spans, replacement),
  };
}

/**
 * PURE: the Replace-all button's honest label. When the plan is capped it
 * says how much of the TRUE total it covers ("Replace shown (N of M)");
 * uncapped it is a plain "Replace all (N)". An empty replacement appends
 * "with ''" — the label IS the deletion confirmation (no modal).
 */
export function replaceAllLabel(plan: ReplacePlan, replacement: string): string {
  const base = plan.truncated
    ? `Replace shown (${plan.totalReplacements} of ${plan.totalMatchesAll})`
    : `Replace all (${plan.totalReplacements})`;
  return replacement === "" ? `${base} with ''` : base;
}
