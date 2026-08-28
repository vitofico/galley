import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "./use-focus-trap.js";
import "./revise-selection-prompt.css";

/**
 * `ReviseSelectionPrompt` (roadmap 11.8b) — a focused, BLOCKING popover that
 * collects the instruction for a selection-scoped revise.
 *
 * The user selects a region in the editor and triggers "Revise selection…";
 * ProjectApp snapshots the selection and opens this prompt with a one-line
 * `summary` (e.g. "Revise the selected 3 lines (12-14)"). On submit it hands the
 * typed instruction back; ProjectApp composes the scoped agent request and runs
 * it through the NORMAL scratch→diff→Accept loop (never auto-applied).
 *
 * Presentational + injection-only: it owns no selection/agent state. A11y:
 * `role="dialog"` + `aria-modal`; the input autofocuses on open; Enter submits
 * (when non-empty), Escape cancels; a backdrop click cancels. Renders nothing
 * when `!open` so the shipped DOM is unchanged until the user invokes it.
 */
export interface ReviseSelectionPromptProps {
  open: boolean;
  /** One-line human summary of the selection being revised. */
  summary: string;
  /** Submit the typed instruction (already trimmed; never empty). */
  onSubmit: (instruction: string) => void;
  /** Close without submitting. */
  onCancel: () => void;
}

export function ReviseSelectionPrompt({
  open,
  summary,
  onSubmit,
  onCancel,
}: ReviseSelectionPromptProps) {
  const [instruction, setInstruction] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // A11y (#23.5): trap Tab + restore focus on close (autofocus/Escape below).
  useFocusTrap(dialogRef, open);

  // Reset + focus the input each time the prompt opens (fresh per selection).
  useEffect(() => {
    if (open) {
      setInstruction("");
      inputRef.current?.focus();
    }
  }, [open]);

  // Escape cancels while the prompt is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onCancel]);

  // Additive: render NOTHING when closed.
  if (!open) return null;

  const trimmed = instruction.trim();
  const submit = () => {
    if (trimmed) onSubmit(trimmed);
  };

  return (
    <div
      className="revise-selection-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="revise-selection-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="revise-selection-title"
        data-testid="revise-selection-prompt"
      >
        <p className="revise-selection-eyebrow">Agent</p>
        <h2 className="revise-selection-title" id="revise-selection-title">
          Revise selection
        </h2>
        <p className="revise-selection-summary" data-testid="revise-selection-summary">
          {summary}
        </p>

        <form
          className="revise-selection-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            ref={inputRef}
            type="text"
            className="revise-selection-input"
            data-testid="revise-selection-input"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="How should the agent revise this? (e.g. make it shorter)"
            aria-label="Revision instruction"
            spellCheck={false}
          />

          <div className="revise-selection-actions">
            <span className="revise-selection-hint">
              The revision is shown as a diff you Accept — nothing changes until then.
            </span>
            <span className="revise-selection-actions-spacer" />
            <button
              type="button"
              className="revise-selection-cancel"
              data-testid="revise-selection-cancel"
              onClick={() => onCancel()}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="revise-selection-submit"
              data-testid="revise-selection-submit"
              disabled={trimmed === ""}
            >
              Revise
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
