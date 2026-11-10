/**
 * Conflict-aware Accept (docs/editing-and-diff.md). Pure so it is unit-tested
 * directly: the "never clobber" invariant is too important to leave only inside
 * a React handler.
 *
 *   - Fast path: the live document still equals the run's base → apply the final
 *     scratch source directly.
 *   - Otherwise the user typed during the run → re-apply the edit BLOCKS to the
 *     CURRENT source. If every block still matches uniquely, apply the result;
 *     otherwise report a conflict and apply nothing (never clobber).
 *
 * EMPTY-BLOCKS FULL-FILE REPLACEMENT (B3 restore): a restore `edit` op carries NO
 * blocks — it is a wholesale "make this file equal the version's text" intent, not
 * a search/replace. For that case there is nothing to re-apply against moved text,
 * so the slow path MUST NOT fall into `applyEdits` (an empty block list "succeeds"
 * there and returns the CURRENT source — a silent no-op that would mark a restore
 * accepted without restoring). Instead: the fast path replaces the whole file when
 * it is unchanged since the proposal (current === base); when the file CHANGED a
 * full replacement would clobber the user's edit, so we surface a CONFLICT and
 * apply nothing. Block-based edits (every non-restore producer) are unaffected.
 */
import { applyEdits } from "@galley/agent";
import type { EditBlock } from "@galley/shared";

export interface AcceptOutcome {
  applied: boolean;
  /** The new source to set, when `applied`. */
  source?: string;
  /** Number of blocks that no longer match, when not applied. */
  conflicts?: number;
}

export function resolveAccept(
  currentSource: string,
  baseSource: string,
  finalSource: string,
  blocks: EditBlock[],
): AcceptOutcome {
  if (currentSource === baseSource) {
    return { applied: true, source: finalSource };
  }
  // EMPTY-BLOCKS = full-file replacement (restore): the live text moved past base,
  // and there are no blocks to re-apply, so a wholesale replace would clobber the
  // user's edit. Surface a conflict (count it as one) — NEVER the silent no-op
  // applyEdits would return for an empty block list.
  if (blocks.length === 0) {
    return { applied: false, conflicts: 1 };
  }
  const result = applyEdits(currentSource, blocks);
  if (result.ok) {
    return { applied: true, source: result.source };
  }
  return { applied: false, conflicts: result.failures.length };
}
