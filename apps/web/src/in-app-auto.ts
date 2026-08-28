/**
 * The pure decision for whether the IN-APP agent should auto-apply a finished
 * run (ADR-0025 §4). It answers ONE question — should the caller take the
 * hardened auto-apply path, or surface the normal Ask `DiffReview` gate?
 *
 * It is deliberately a TINY pure function so the unit gate pins the policy
 * without a DOM/React env. It encodes ONLY the two non-negotiable preconditions
 * that can be decided from static inputs:
 *
 *   - the project's in-app acceptance mode is "auto" (the deliberate opt-in), and
 *   - the local role can mutate the doc (a viewer never auto-applies — read-only
 *     users cannot apply at all, so they always fall through to the Ask gate).
 *
 * It MUST NOT be the whole authorization. The CALLER additionally guards on the
 * runtime preconditions that cannot be known here — a pre-apply checkpoint
 * succeeded (the Undo target) and the conflict-aware re-check applied cleanly.
 * ANY of those failing means: do NOT apply, show the Ask gate (in-app Auto is
 * best-effort flow, never a bypass of the §8 invariant).
 */
import type { AgentAcceptanceMode } from "./agent-acceptance-mode.js";

/** The static inputs to the in-app auto-apply decision. */
export interface InAppAutoInput {
  /** The project's in-app acceptance mode (`getProjectAcceptanceMode`). */
  mode: AgentAcceptanceMode;
  /** Whether the local role may mutate the shared document. */
  canMutate: boolean;
}

/** The decision: whether to take the hardened auto-apply path. */
export interface InAppAutoDecision {
  /**
   * True only when mode is "auto" AND the role can mutate. Even when true, the
   * caller still gates on checkpoint + conflict re-check success before applying.
   */
  autoApply: boolean;
}

/**
 * Decide whether a finished in-app run is eligible for the hardened auto-apply
 * path. Pure: `autoApply` is true ONLY when the project is in Auto mode and the
 * local role can mutate. Every other case (Ask mode, viewer) falls back to the
 * mandatory human Accept gate.
 */
export function decideInAppAuto({ mode, canMutate }: InAppAutoInput): InAppAutoDecision {
  return { autoApply: mode === "auto" && canMutate === true };
}

/**
 * The LIVE inputs to the in-app FINAL pre-apply gate (H2) — the in-app analogue of
 * the MCP `passesFinalApplyGate`. They are RE-READ inside the ProjectApp seam AFTER
 * the awaited checkpoint, never captured from the run-finish React closure, so a
 * role drop, a flip to Ask, or a concurrent edit during the checkpoint window is
 * caught before anything is written.
 */
export interface InAppFinalGateInput {
  /** The project's in-app acceptance mode, RE-READ live at the apply point. */
  mode: AgentAcceptanceMode;
  /** The LIVE role (a drop to viewer during the checkpoint window must block). */
  canMutate: boolean;
  /**
   * Did the conflict-aware re-plan against the LIVE file text fail (the active file
   * changed under us during the checkpoint window)? True ⇒ block, fall back to Ask.
   */
  conflict: boolean;
}

/**
 * The LAST gate before an in-app Auto apply commits (H2). Returns true ONLY when,
 * at this very instant: the project is still in Auto, the local role can still
 * mutate, AND the conflict-aware re-plan applied cleanly. Any false ⇒ the caller
 * does NOT apply and falls back to the Ask `DiffReview` gate. Pure boolean — the
 * live re-reads happen in the seam; this just pins the policy.
 */
export function passesInAppFinalGate({ mode, canMutate, conflict }: InAppFinalGateInput): boolean {
  return mode === "auto" && canMutate === true && conflict === false;
}
