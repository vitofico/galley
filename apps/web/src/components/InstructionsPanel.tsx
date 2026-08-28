import { useEffect, useMemo, useRef, useState } from "react";
import { parseInstructions } from "@galley/agent";
import { INSTRUCTIONS_SEED } from "../instructions-edit.js";
import { useFocusTrap } from "./use-focus-trap.js";
import "./instructions-panel.css";

/**
 * `InstructionsPanel` (roadmap 14-D, authoring surface) — a BLOCKING modal editor
 * for the project's `.galley/instructions` file: the steering prose + deterministic
 * `## Constraints` the agent loop already reads live. The agent-steering CORE is
 * wired elsewhere; this is the missing AUTHORING surface (promotion principle).
 *
 * Presentational + injection-only — ProjectApp owns persistence (save = a HUMAN
 * config edit straight into the CRDT, NOT routed through the agent Accept/diff
 * gate). The panel:
 *   - pre-fills a textarea with the existing file's text, or a parse-clean SEED;
 *   - shows a LIVE parsed preview (steering presence/length, a constraints summary,
 *     and every parse warning as `line: message`) recomputed on each change;
 *   - renders byte-for-byte ABSENT when `!open` (the shipped path is unchanged
 *     until the user opens it).
 *
 * A11y: `role="dialog"` + `aria-modal`; focus lands in the textarea on open;
 * Escape and a backdrop click both CLOSE WITHOUT saving (no silent writes).
 */
export interface InstructionsPanelProps {
  open: boolean;
  /** The existing file's raw text, or undefined for a brand-new file (→ SEED). */
  initialText?: string;
  /** Persist the edited text (create-or-replace, coalescing duplicates). */
  onSave: (text: string) => void;
  /** Tombstone the instructions file entirely (only offered when one exists). */
  onRemove: () => void;
  /** Close without saving. */
  onClose: () => void;
  /** Whether a live instructions file already exists (gates the Remove button). */
  hasExisting: boolean;
}

const KNOWN_KEYS = "max-words, min-words, required-section, forbidden-word";

export function InstructionsPanel({
  open,
  initialText,
  onSave,
  onRemove,
  onClose,
  hasExisting,
}: InstructionsPanelProps) {
  const [text, setText] = useState<string>(initialText ?? INSTRUCTIONS_SEED);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // A11y (#23.5): trap Tab within the dialog and restore focus to the trigger
  // on close. Additive — autofocus + Escape are handled separately below.
  useFocusTrap(dialogRef, open);

  // Re-seed the editor each time it opens so it reflects the CURRENT file (or the
  // SEED for a new one). Keyed on `open` edge so typing isn't clobbered mid-edit.
  useEffect(() => {
    if (open) setText(initialText ?? INSTRUCTIONS_SEED);
  }, [open, initialText]);

  // Focus the textarea when the modal opens.
  useEffect(() => {
    if (open) textareaRef.current?.focus();
  }, [open]);

  // Escape closes without saving while the modal is open.
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

  // Live parse for the preview (pure + never throws; cheap enough, no debounce).
  const parsed = useMemo(() => parseInstructions(text), [text]);
  const steering = parsed.steering.trim();
  const c = parsed.constraints;

  // Additive: render NOTHING when closed.
  if (!open) return null;

  return (
    <div
      className="instructions-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="instructions-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="instructions-title"
        aria-describedby="instructions-help"
        data-testid="instructions-panel"
      >
        <p className="instructions-eyebrow">Project</p>
        <h2 className="instructions-title" id="instructions-title">
          Project instructions
        </h2>
        <p className="instructions-help" id="instructions-help">
          Steering prose guides the AI agent for this project. An optional{" "}
          <code>## Constraints</code> section adds deterministic checks — supported
          keys: <code>{KNOWN_KEYS}</code>.
        </p>

        <div className="instructions-body">
          <textarea
            ref={textareaRef}
            className="instructions-textarea"
            data-testid="instructions-textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            rows={14}
            aria-label="Project instructions content"
          />

          <aside className="instructions-preview" data-testid="instructions-preview">
            <p className="instructions-preview-row">
              <span className="instructions-preview-label">Steering</span>
              <span data-testid="instructions-steering-summary">
                {steering ? `${steering.length} chars` : "none"}
              </span>
            </p>
            <p className="instructions-preview-row">
              <span className="instructions-preview-label">Constraints</span>
              <span data-testid="instructions-constraints-summary">
                {summarizeConstraints(c)}
              </span>
            </p>
            <div className="instructions-warnings" data-testid="instructions-warnings">
              {parsed.warnings.length === 0 ? (
                <p className="instructions-ok" data-testid="instructions-no-warnings">
                  No problems.
                </p>
              ) : (
                <ul className="instructions-warning-list">
                  {parsed.warnings.map((w, i) => (
                    <li
                      key={`${w.line}-${i}`}
                      className="instructions-warning"
                      data-testid="instructions-warning"
                    >
                      line {w.line}: {w.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>

        <div className="instructions-actions">
          {hasExisting && (
            <button
              type="button"
              className="instructions-remove"
              data-testid="instructions-remove"
              onClick={() => onRemove()}
            >
              Remove
            </button>
          )}
          <span className="instructions-actions-spacer" />
          <button
            type="button"
            className="instructions-cancel"
            data-testid="instructions-cancel"
            onClick={() => onClose()}
          >
            Cancel
          </button>
          <button
            type="button"
            className="instructions-save"
            data-testid="instructions-save"
            onClick={() => onSave(text)}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/** A compact human summary of the parsed constraints for the preview. */
function summarizeConstraints(
  c: ReturnType<typeof parseInstructions>["constraints"],
): string {
  if (!c) return "none";
  const parts: string[] = [];
  if (c.maxWords !== undefined) parts.push(`max ${c.maxWords} words`);
  if (c.minWords !== undefined) parts.push(`min ${c.minWords} words`);
  if (c.requiredSections.length > 0) {
    parts.push(`required: ${c.requiredSections.join(", ")}`);
  }
  if (c.forbiddenWords.length > 0) {
    parts.push(`forbidden: ${c.forbiddenWords.join(", ")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "section present (no checks set)";
}
