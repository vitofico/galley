/**
 * `applyAgentEdits` — the agent as a CRDT peer (ADR-0006, Phase 1). It takes the
 * SAME search/replace `EditBlock`s the MVP agent loop already produces and
 * applies them to the shared `CollabDocument` as a single author-tagged Yjs
 * transaction (per-block delete+insert at the matched offset).
 *
 * The MVP's fail-safe rule carries over verbatim: each block's `search` must
 * match EXACTLY ONCE in the CURRENT doc; it is all-or-nothing; a block that no
 * longer matches uniquely is a surfaced conflict, never a clobber. (Same
 * semantics as `@galley/agent`'s `applyEdits`, but applied as CRDT operations so
 * concurrent human edits merge instead of being overwritten.)
 *
 * Coordinates: unlike the MVP — which normalizes the source, edits the copy, and
 * returns the whole new string — the CRDT version must apply POSITIONAL ops to
 * the live `Y.Text`, whose content is the raw document (it may use CRLF). So we
 * plan in the raw document's own coordinates and match newlines CRLF-tolerantly;
 * normalizing first would drift every offset by one code unit per `\r` before
 * the edit and corrupt the document. (`Y.Text` indexes by UTF-16 code unit, the
 * same basis as JS string indices, so astral characters need no special care.)
 */
import type { Author, EditBlock, EditFailure } from "@galley/shared";
import type { CollabDocument } from "./collab-document.js";

export interface CollabApplyResult {
  ok: boolean;
  /** Populated when ok === false; the doc is left untouched. */
  failures: EditFailure[];
}

function normalizeNewlines(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

/** Escape a literal string for safe inclusion in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A regex matching the (newline-normalized) `search` against RAW document text
 * whose line endings may be CRLF or a lone CR. Each `\n` in the search matches
 * any of `\r\n`, `\r`, or `\n` — mirroring `normalizeNewlines` — so the agent
 * (which always emits `\n`) still matches a CRLF document, and the match comes
 * back in the raw document's own coordinates with no offset drift.
 */
function crlfTolerantRegex(searchNorm: string): RegExp {
  const pattern = searchNorm.split("\n").map(escapeRegExp).join("(?:\\r\\n|\\r|\\n)");
  return new RegExp(pattern, "g");
}

interface Range {
  start: number;
  end: number;
}

/** Non-overlapping match ranges of a global `re` in `haystack`. */
function allRanges(haystack: string, re: RegExp): Range[] {
  const out: Range[] = [];
  let from = 0;
  for (;;) {
    re.lastIndex = from;
    const m = re.exec(haystack);
    if (m === null) break;
    const end = m.index + m[0].length;
    out.push({ start: m.index, end });
    from = end; // m[0] is non-empty (search is non-empty) -> always advances
  }
  return out;
}

interface Op {
  index: number;
  deleteLen: number;
  insert: string;
}

export function applyAgentEdits(
  doc: CollabDocument,
  blocks: EditBlock[],
  author: Author,
): CollabApplyResult {
  // Plan + validate against the RAW current content (sequentially, so a later
  // block sees an earlier block's replacement) BEFORE touching the CRDT. There
  // is no `await` between this read and the transaction below, so the plan
  // applies atomically with respect to any concurrent remote update.
  const raw = doc.getSource();
  const usesCRLF = raw.includes("\r\n");
  let running = raw;
  const failures: EditFailure[] = [];
  const ops: Op[] = [];
  const applied: Range[] = [];

  for (const block of blocks) {
    const search = normalizeNewlines(block.search);
    if (search === "") {
      failures.push({ block, reason: "no_match" }); // empty search never matches
      continue;
    }
    // Inserted text adopts the document's newline convention so an edit never
    // introduces mixed line endings into a CRLF file.
    const replace = usesCRLF
      ? normalizeNewlines(block.replace).replace(/\n/g, "\r\n")
      : normalizeNewlines(block.replace);

    const matches = allRanges(running, crlfTolerantRegex(search));
    if (matches.length === 0) {
      failures.push({ block, reason: "no_match" });
      continue;
    }
    if (matches.length > 1) {
      failures.push({ block, reason: "multiple_matches", matchCount: matches.length });
      continue;
    }

    const { start, end } = matches[0]!;
    // `overlap` = re-editing text a previous block in THIS batch just inserted
    // (the match lies entirely within that block's output span). A match that
    // merely *includes* an earlier replacement while also spanning original text
    // is allowed — the contract (rule 3) lets a later search see an earlier
    // replacement when it anchors on surrounding text, so we deliberately do NOT
    // reject every intersection. The replace output is always exact; this span
    // bookkeeping is approximate only for the (model-never-does-this) case of
    // three chained partial-overlap edits, and even then it fails safe.
    if (applied.some((s) => start >= s.start && end <= s.end)) {
      failures.push({ block, reason: "overlap" });
      continue;
    }

    running = running.slice(0, start) + replace + running.slice(end);
    const delta = replace.length - (end - start);
    for (const s of applied) {
      if (s.start >= end) {
        s.start += delta;
        s.end += delta;
      }
    }
    applied.push({ start, end: start + replace.length });
    ops.push({ index: start, deleteLen: end - start, insert: replace });
  }

  if (failures.length > 0) {
    return { ok: false, failures }; // all-or-nothing: mutate nothing
  }

  // Op indices are in raw running-string coordinates as each earlier op applied.
  // The `Y.Text` starts equal to the raw source and uses the same UTF-16 indexing,
  // so replaying the ops in order reproduces the planned result exactly.
  doc.transact((text) => {
    for (const op of ops) {
      if (op.deleteLen > 0) text.delete(op.index, op.deleteLen);
      if (op.insert.length > 0) text.insert(op.index, op.insert);
    }
  }, author);

  return { ok: true, failures: [] };
}
