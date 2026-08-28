import { useEffect, useRef } from "react";
import { useFocusTrap } from "./use-focus-trap.js";
import "./insert-reference-picker.css";

/**
 * `InsertReferencePicker` (roadmap #13 follow-up) — a small BLOCKING modal that
 * lists the project's known `<label>` names so the author can insert a `@ref`
 * without remembering the exact name. Complements the inline `@`-completion: it's
 * a discoverable, explicit affordance (⌘K → "Insert reference…") that also offers
 * labels defined in SIBLING files (the union, not just the active doc).
 *
 * Presentational + injection-only: ProjectApp owns the label list and the actual
 * editor insert. Picking a label calls `onPick(name)` (which dispatches `@name`
 * at the cursor); an empty union renders a calm empty-state instead of a list.
 *
 * A11y mirrors `InstructionsPanel`: `role="dialog"` + `aria-modal`, focus lands
 * on the first option (or the close button) on open, Escape and a backdrop click
 * both CLOSE without inserting. Renders byte-for-byte ABSENT when `!open`.
 */
export interface InsertReferencePickerProps {
  open: boolean;
  /** Sorted, de-duped project-wide `<label>` names. */
  labels: string[];
  /** Insert `@<label>` at the editor cursor. */
  onPick: (label: string) => void;
  /** Close without inserting. */
  onClose: () => void;
}

export function InsertReferencePicker({
  open,
  labels,
  onPick,
  onClose,
}: InsertReferencePickerProps) {
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // A11y (#23.5): trap Tab + restore focus on close (autofocus/Escape below).
  useFocusTrap(dialogRef, open);

  // Focus the first option (or the close button) when the modal opens.
  useEffect(() => {
    if (open) firstRef.current?.focus();
  }, [open]);

  // Escape closes without inserting while the modal is open.
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
      className="insert-ref-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="insert-ref-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="insert-ref-title"
        data-testid="insert-reference-picker"
      >
        <h2 className="insert-ref-title" id="insert-ref-title">
          Insert reference
        </h2>
        <p className="insert-ref-help">
          Pick a label to insert <code>@label</code> at the cursor.
        </p>

        {labels.length === 0 ? (
          <p className="insert-ref-empty" data-testid="insert-reference-empty">
            No labels in this project yet. Define one with{" "}
            <code>&lt;label&gt;</code> to reference it here.
          </p>
        ) : (
          <ul className="insert-ref-list" data-testid="insert-reference-list">
            {labels.map((name, i) => (
              <li key={name}>
                <button
                  type="button"
                  className="insert-ref-option"
                  data-testid="insert-reference-option"
                  ref={i === 0 ? firstRef : undefined}
                  onClick={() => onPick(name)}
                >
                  @{name}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="insert-ref-actions">
          <button
            type="button"
            className="insert-ref-cancel"
            data-testid="insert-reference-cancel"
            ref={labels.length === 0 ? firstRef : undefined}
            onClick={() => onClose()}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
