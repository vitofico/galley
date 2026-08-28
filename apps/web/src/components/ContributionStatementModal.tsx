import { useEffect, useRef } from "react";
import { useFocusTrap } from "./use-focus-trap.js";
import "./contribution-statement-modal.css";

/**
 * `ContributionStatementModal` (roadmap #13) — a BLOCKING review modal for the
 * machine-drafted CRediT-style author-contribution statement. ProjectApp builds
 * the draft text from the project's REAL attributed history (versions + per-file
 * authorship) via the pure core, then opens this modal so the human can READ the
 * draft before any document mutation.
 *
 * The Insert button does NOT mutate the document itself — it calls `onInsert`,
 * which routes the draft through ProjectApp's existing conflict-aware Accept flow
 * (append → resolveAccept), so the insertion is reviewable and never auto-applied.
 * Cancel / Escape / backdrop close WITHOUT inserting. Renders byte-for-byte
 * ABSENT when `!open`, so the shipped DOM is unchanged when the feature is idle.
 *
 * Presentational + injection-only: it owns no evidence, no editor write. A11y
 * mirrors `InsertReferencePicker` (`role="dialog"` + `aria-modal`, focus trap,
 * Escape/backdrop close).
 */
export interface ContributionStatementModalProps {
  open: boolean;
  /** The rendered statement text (with heading) to review. */
  statement: string;
  /** Insert the reviewed draft into the document (through the Accept gate). */
  onInsert: () => void;
  /** Close without inserting. */
  onClose: () => void;
}

export function ContributionStatementModal({
  open,
  statement,
  onInsert,
  onClose,
}: ContributionStatementModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const insertRef = useRef<HTMLButtonElement | null>(null);

  // A11y (#23.5): trap Tab + restore focus on close.
  useFocusTrap(dialogRef, open);

  // Focus the primary action when the modal opens.
  useEffect(() => {
    if (open) insertRef.current?.focus();
  }, [open]);

  // Escape closes without inserting.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  // Additive: render NOTHING when closed.
  if (!open) return null;

  return (
    <div
      className="contrib-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="contrib-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="contrib-title"
        data-testid="contribution-statement-modal"
      >
        <h2 className="contrib-title" id="contrib-title">
          Contribution statement
        </h2>
        <p className="contrib-help">
          A CRediT-style draft reconstructed from this project's version history
          and per-file authorship. Review and edit it after inserting — it is a
          starting point, not an authoritative record.
        </p>

        <pre className="contrib-preview" data-testid="contribution-statement-preview">
          {statement}
        </pre>

        <div className="contrib-actions">
          <button
            type="button"
            className="contrib-cancel"
            data-testid="contribution-statement-cancel"
            onClick={() => onClose()}
          >
            Cancel
          </button>
          <button
            type="button"
            className="contrib-insert"
            data-testid="contribution-statement-insert"
            ref={insertRef}
            onClick={() => onInsert()}
          >
            Insert into document
          </button>
        </div>
      </div>
    </div>
  );
}
