/**
 * Search/replace edit blocks — the agent's editing primitive (Aider / Claude
 * Code style). See docs/editing-and-diff.md for the full contract.
 *
 * Rules (enforced by the apply step, not just convention):
 *   - `search` must match EXACTLY ONCE in the current source. Zero matches or
 *     multiple matches is a structured failure, never a silent guess.
 *   - Blocks apply sequentially against the running source; an earlier block's
 *     replacement is visible to a later block's search.
 *   - Edits must not overlap.
 *   - Line endings are normalized to "\n" before matching.
 */

export interface EditBlock {
  /** Exact substring to find. Must be unique in the current source. */
  search: string;
  /** Text to replace it with. */
  replace: string;
}

export type EditFailureReason =
  | "no_match" // search string not found
  | "multiple_matches" // search string is ambiguous (matched >1 times)
  | "overlap" // this block's range overlaps an already-applied block
  | "stale_base"; // RESERVED for a planned revision-check gate; not currently emitted by any apply path

export interface EditFailure {
  block: EditBlock;
  reason: EditFailureReason;
  /** For "multiple_matches": how many times it matched. */
  matchCount?: number;
  detail?: string;
}

/** Result of applying a set of edit blocks to a source string. */
export interface ApplyResult {
  ok: boolean;
  /** The resulting source when ok === true. */
  source: string;
  /** Populated when ok === false; the agent uses these to retry. */
  failures: EditFailure[];
}
