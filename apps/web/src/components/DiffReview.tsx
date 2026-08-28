import { useState } from "react";
import { DiffBody } from "./DiffBody.js";

/**
 * The diff review UI (docs/editing-and-diff.md): a unified line diff from base →
 * final scratch, with Accept / Reject. The diff is a *view*; Accept re-applies
 * the edit blocks conflict-aware (handled by the caller), it does not apply this
 * textual diff.
 *
 * 11.8c — refine the pending proposal: when `onRefine` is provided, a "Refine…"
 * affordance appears next to Accept/Reject. It reveals an inline instruction
 * field; submitting hands the instruction to the caller, which starts a NEW run
 * from the PENDING proposal (this proposal's final source becomes the new base),
 * replacing this DiffReview when the chained run completes. The Accept semantics
 * are unchanged — `onRefine` is purely additive, and when absent DiffReview
 * renders exactly as before.
 */
export function DiffReview({
  base,
  next,
  outcome,
  onAccept,
  onReject,
  onRefine,
}: {
  base: string;
  next: string;
  outcome: string;
  onAccept: () => void;
  onReject: () => void;
  /**
   * Optional (11.8c): iterate on this pending proposal. Receives the trimmed,
   * non-empty refine instruction; the caller starts a chained run. Absent → no
   * Refine affordance, byte-for-byte the shipped DiffReview.
   */
  onRefine?: (instruction: string) => void;
}) {
  const [refining, setRefining] = useState(false);
  const [instruction, setInstruction] = useState("");
  const trimmed = instruction.trim();

  const submitRefine = () => {
    if (!onRefine || trimmed === "") return;
    onRefine(trimmed);
    // The chained run resets the agent state and unmounts this DiffReview when it
    // completes; reset our local affordance so a re-mount starts clean.
    setRefining(false);
    setInstruction("");
  };

  return (
    <div className="diff-review" data-testid="diff-review">
      <div className="diff-head">
        <span>Proposed changes ({outcome})</span>
        <span className="diff-actions">
          {/* B13(8): Accept applies immediately (single-click contract kept — the
              edit is reversible via version history), but the title spells out
              that it writes the changes to the document so it isn't a surprise. */}
          <button
            onClick={onAccept}
            data-testid="accept"
            title="Apply these changes to the document"
          >
            Accept
          </button>
          <button
            onClick={onReject}
            data-testid="reject"
            title="Discard this proposal"
          >
            Reject
          </button>
          {onRefine && (
            <button
              type="button"
              data-testid="refine-proposal"
              aria-expanded={refining}
              onClick={() => setRefining((r) => !r)}
              // B13(9): make the Refine affordance self-describing on hover/focus.
              title="Refine this proposal with a follow-up request before accepting"
            >
              Refine…
            </button>
          )}
        </span>
      </div>
      {/* B13(9): a one-line discovery hint for the iterate-then-accept loop. Only
          rendered when refining is available, so the shipped (no-onRefine)
          DiffReview is byte-for-byte unchanged. */}
      {onRefine && (
        <p className="diff-refine-hint" data-testid="refine-hint">
          Keep refining until the proposal is right, then Accept once.
        </p>
      )}
      {onRefine && refining && (
        <form
          className="diff-refine"
          data-testid="refine-form"
          onSubmit={(e) => {
            e.preventDefault();
            submitRefine();
          }}
        >
          <input
            type="text"
            className="diff-refine-input"
            data-testid="refine-input"
            value={instruction}
            autoFocus
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setRefining(false);
                setInstruction("");
              }
            }}
            placeholder="Refine this proposal… (e.g. make it shorter)"
            aria-label="Refine instruction"
            spellCheck={false}
          />
          <button type="submit" data-testid="refine-submit" disabled={trimmed === ""}>
            Refine
          </button>
        </form>
      )}
      <DiffBody base={base} next={next} />
    </div>
  );
}
