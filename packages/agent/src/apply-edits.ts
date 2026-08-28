/**
 * `applyEdits` — the search/replace edit primitive (see docs/editing-and-diff.md
 * and ADR-0003). The agent's only way to mutate the scratch copy.
 *
 * The contract is ENFORCED here, not merely documented:
 *
 *   1. Line endings are normalized to "\n" before matching.
 *   2. Each block's `search` must match EXACTLY ONCE in the current running
 *      source: 0 -> `no_match`, >1 -> `multiple_matches` (with `matchCount`).
 *   3. Blocks apply sequentially against the running source — an earlier block's
 *      replacement is visible to a later block's search.
 *   4. A block whose match lands inside a span already edited by a previous
 *      block fails with `overlap` (never silently edit just-inserted text).
 *   5. All-or-nothing: if ANY block fails, the call returns `ok: false` with the
 *      full list of `EditFailure`s and does NOT mutate (returns the source
 *      unchanged). The loop feeds the failures back to the model to retry.
 *
 * Failures are structured DATA returned to the model, never thrown.
 */

import type { ApplyResult, EditBlock, EditFailure } from "@galley/shared";

/** Normalize CRLF / lone CR to LF so matching is independent of line endings. */
export function normalizeNewlines(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

/** All start indices at which `needle` occurs in `haystack` (non-overlapping). */
function allMatches(haystack: string, needle: string): number[] {
  if (needle === "") return []; // empty search never matches; treated as no_match
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    out.push(i);
    from = i + needle.length;
  }
  return out;
}

interface AppliedSpan {
  start: number;
  end: number;
}

/**
 * Whether `match` lies entirely within `applied` — i.e. the block is re-editing
 * text a previous block in this same batch just inserted, with no anchoring to
 * surrounding original text. That is the `overlap` failure.
 *
 * A match that merely *includes* a prior replacement while also spanning
 * original text (e.g. searching "x b" after "a"->"x") is NOT an overlap — the
 * contract (rule 3) explicitly lets a later search see an earlier replacement,
 * as long as it anchors on surrounding text. We deliberately do NOT reject all
 * intersections (that would break rule 3). The output of every applied edit is
 * always exact; the applied-span bookkeeping is approximate only for the
 * (vanishingly rare, model-never-does-this) case of THREE chained edits that
 * each partially overlap the previous one's insertion — and even then a
 * mis-classified third edit fails safe (an `overlap`/`no_match` fed back to the
 * model to retry), never a silent corruption.
 */
function containedIn(match: AppliedSpan, applied: AppliedSpan): boolean {
  return match.start >= applied.start && match.end <= applied.end;
}

export function applyEdits(source: string, blocks: EditBlock[]): ApplyResult {
  const normalized = normalizeNewlines(source);
  let running = normalized;
  const failures: EditFailure[] = [];
  // Spans (in CURRENT running-string coordinates) already produced by an applied
  // block; used to detect a later block editing just-inserted text.
  const applied: AppliedSpan[] = [];

  for (const block of blocks) {
    const search = normalizeNewlines(block.search);
    const replace = normalizeNewlines(block.replace);
    const matches = allMatches(running, search);

    if (matches.length === 0) {
      failures.push({ block, reason: "no_match" });
      continue;
    }
    if (matches.length > 1) {
      failures.push({ block, reason: "multiple_matches", matchCount: matches.length });
      continue;
    }

    const start = matches[0]!;
    const end = start + search.length;
    const span: AppliedSpan = { start, end };
    if (applied.some((s) => containedIn(span, s))) {
      failures.push({ block, reason: "overlap" });
      continue;
    }

    // Apply to the running source and shift previously-recorded spans.
    running = running.slice(0, start) + replace + running.slice(end);
    const delta = replace.length - (end - start);
    for (const s of applied) {
      if (s.start >= end) {
        s.start += delta;
        s.end += delta;
      }
    }
    applied.push({ start, end: start + replace.length });
  }

  if (failures.length > 0) {
    // All-or-nothing: report every failure and return the source UNCHANGED (the
    // original input, not the newline-normalized copy — the contract says the
    // call mutates nothing on failure).
    return { ok: false, source, failures };
  }
  return { ok: true, source: running, failures: [] };
}
