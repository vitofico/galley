/**
 * roadmap 11.8c — refine the pending proposal.
 *
 * The agent proposes a diff the human reviews (DiffReview / the Accept gate)
 * before it lands. "Refine…" lets the user iterate on that PENDING proposal
 * ("make it shorter", "more formal") WITHOUT restarting from the original
 * document: the pending proposal's `finalSource` becomes the new run's
 * `baseSource`, producing a NEW proposal that replaces the pending one.
 *
 * The Accept semantics stay intact (ADR-0003): `resolveAccept` re-matches each
 * block's `search` text against the LIVE document, so it is independent of this
 * chain's moving base — the chain stays conflict-aware no matter how many refine
 * steps happened.
 *
 * This module is a tiny PURE shaper: given the pending proposal's final source
 * and an instruction, it returns the `{ request, baseSource }` for the chained
 * run. The caller threads the SAME model / buildCheckInput / context /
 * instructions the original run used (so the chained run compiles + checks the
 * scratch identically) and a refine is a NORMAL edit run (never advice-only).
 */

export interface RefineRunArgs {
  /** The instruction to run (e.g. "make it shorter"). */
  request: string;
  /** The base the chained run starts from: the pending proposal's final source. */
  baseSource: string;
}

/**
 * Shape the next run's args from the pending proposal's `finalSource` and the
 * user's refine `instruction`. The instruction is trimmed; an empty instruction
 * yields `null` (a no-op — the caller must not start a run).
 */
export function buildRefineRun(pendingFinalSource: string, instruction: string): RefineRunArgs | null {
  const request = instruction.trim();
  if (request === "") return null;
  return { request, baseSource: pendingFinalSource };
}
