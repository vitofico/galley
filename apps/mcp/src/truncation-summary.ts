/**
 * Truncation surfacing (D1) — pure helpers that turn the read tools' structured
 * truncation signals into ONE human-readable line for the tool result.
 *
 * `list_files` / `project_context` already report truncation as booleans +
 * counts (surface.ts ListOutcome / ContextOutcome). Those are precise but the
 * agent has to reason over several flags to learn "I am NOT seeing everything".
 * A single sentence — appended only when something was actually cut — tells it
 * plainly so it knows to narrow its query or read a specific file.
 *
 * Pure + additive: when nothing was truncated every helper returns `null` and
 * the result is unchanged; the boolean/count fields stay exactly as they were.
 */

import { READ_LIMITS } from "./surface.js";
import type { ContextSkipReason } from "./surface.js";

/** The list_files truncation signals the summary reads. */
export interface ListTruncation {
  /** Live files past the entry cap were cut off. */
  truncated: boolean;
  /** Live entries hidden because their forged path exceeded the cap. */
  omitted: number;
  /** Count of surfaced entries whose size is a lower bound (sizing budget spent). */
  inexactSizes?: number;
}

/** The project_context truncation signals the summary reads. */
export interface ContextTruncation {
  omitted: number;
  filesTruncated: boolean;
  scanTruncated: boolean;
  chunksTruncated: boolean;
  selectionTruncated: boolean;
  /** Reasons live files were excluded from ranking (one per skipped file). */
  skippedReasons?: ContextSkipReason[];
}

/** Join clauses into one sentence: "Results truncated: a; b; c." */
function sentence(clauses: string[]): string | null {
  if (clauses.length === 0) return null;
  return `Results truncated: ${clauses.join("; ")}.`;
}

/** Pluralize: `1 file` / `3 files`. */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * One-line summary of what `list_files` left out, or null when it returned the
 * complete listing. Covers the entry cap, forged over-long paths hidden, and
 * sizes reported as lower bounds because the sizing budget was spent.
 */
export function summarizeListTruncation(t: ListTruncation): string | null {
  const clauses: string[] = [];
  if (t.truncated) {
    clauses.push(`hit the ${READ_LIMITS.maxListEntries}-entry list cap (more files exist)`);
  }
  if (t.omitted > 0) {
    clauses.push(`${plural(t.omitted, "file")} omitted (path over the length cap)`);
  }
  if (t.inexactSizes !== undefined && t.inexactSizes > 0) {
    clauses.push(`${plural(t.inexactSizes, "size")} are lower bounds (sizing budget spent)`);
  }
  return sentence(clauses);
}

/** Human label for each context skip reason (counts are aggregated by reason). */
const SKIP_LABEL: Record<ContextSkipReason, string> = {
  "duplicate-path": "skipped for a duplicate-path conflict",
  "over-cap": "skipped (over the per-file read cap)",
  "scan-budget": "skipped (scan budget spent)",
  "chunk-cap": "skipped (chunk cap reached)",
};

/**
 * One-line summary of what `project_context` left out of its ranking/selection,
 * or null when nothing was cut. Aggregates per-reason skip counts and the
 * scan/chunk/selection/file caps into a single sentence.
 */
export function summarizeContextTruncation(t: ContextTruncation): string | null {
  const clauses: string[] = [];
  if (t.filesTruncated) {
    clauses.push(`hit the ${READ_LIMITS.maxListEntries}-entry file cap (some files not considered)`);
  }
  if (t.omitted > 0) {
    clauses.push(`${plural(t.omitted, "file")} omitted (path over the length cap)`);
  }
  // Aggregate skipped files by reason so the line stays short for large projects.
  const counts = new Map<ContextSkipReason, number>();
  if (t.skippedReasons !== undefined) {
    for (const r of t.skippedReasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  // Stable reason order for a deterministic line.
  const order: ContextSkipReason[] = ["duplicate-path", "over-cap", "scan-budget", "chunk-cap"];
  for (const reason of order) {
    const n = counts.get(reason);
    if (n !== undefined && n > 0) clauses.push(`${plural(n, "file")} ${SKIP_LABEL[reason]}`);
  }
  // The scan/chunk budgets can be hit WITHOUT a skipped entry: a file whose
  // chunks were cut to a prefix sets `chunksTruncated` alone, and the scan can
  // stop after a partial read. Surface a standalone cause for each — but only
  // when no per-file skip of the same kind already named it (avoid double-
  // reporting). Without these, a prefix-cut would summarize to null despite
  // real truncation.
  if (t.scanTruncated && (counts.get("scan-budget") ?? 0) === 0) {
    clauses.push("the materialization scan budget was spent (some files not read)");
  }
  if (t.chunksTruncated && (counts.get("chunk-cap") ?? 0) === 0) {
    clauses.push("the chunk cap was reached (some content not chunked)");
  }
  if (t.selectionTruncated) {
    clauses.push("relevant excerpts did not fit the response budget");
  }
  return sentence(clauses);
}
