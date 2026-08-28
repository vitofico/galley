import { useEffect, useRef } from "react";
import "./coach-overlay.css";

export interface CoachOverlayProps {
  /** Dismiss permanently — wired to the ✓ button, Escape, or a click anywhere. */
  onDismiss: () => void;
}

/**
 * First-run coach overlay (onboarding M3). A calm, one-time orientation to the
 * three-pane shell — editor (left) · live preview (middle) · agent (right).
 *
 * NON-BLOCKING by construction, matching the shell's "never a modal" onboarding
 * posture (the ⌘K nudge and the H5 chooser): the scrim paints
 * `pointer-events: none`, so a click lands on the app underneath and is never
 * intercepted, while a document-level listener treats that click as
 * "continue" and dismisses the cue. The card itself is a real target so its
 * "Got it" button clicks cleanly.
 *
 * Keyboard-accessible + focus-safe: Escape dismisses; the "Got it" button is
 * Tab-reachable and activates on Enter/Space; focus is never pulled off the
 * editor, so a first-run typist is never interrupted.
 */
export function CoachOverlay({ onDismiss }: CoachOverlayProps): JSX.Element {
  // Keep the latest callback without re-subscribing the document listeners.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    const dismiss = () => dismissRef.current();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    // Any pointer-down anywhere counts as "click to continue". PASSIVE — never
    // preventDefault — so the underlying interaction (placing the caret, hitting
    // a button) still happens; the overlay just steps out of the way.
    const onPointer = () => dismiss();
    // Capture phase for both so we see Escape / the click even when focus is in
    // the editor (CodeMirror handles some keys first) — we never preventDefault,
    // so those handlers still run.
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, []);

  return (
    <div
      className="coach-overlay"
      data-testid="coach-overlay"
      role="region"
      aria-label="A quick tour of Galley"
    >
      <div className="coach-scrim" aria-hidden="true" />
      <div className="coach-card">
        <h2 className="coach-title">Welcome — here’s the lay of the land</h2>
        <ol className="coach-panes">
          <li className="coach-pane">
            <span className="coach-pane-mark" aria-hidden="true">
              1
            </span>
            <span>
              <strong>Write</strong> in the editor on the left — Typst markup, plain text, or
              inline <code>$math$</code>.
            </span>
          </li>
          <li className="coach-pane">
            <span className="coach-pane-mark" aria-hidden="true">
              2
            </span>
            <span>
              Watch the <strong>live preview</strong> in the middle typeset as you type.
            </span>
          </li>
          <li className="coach-pane">
            <span className="coach-pane-mark" aria-hidden="true">
              3
            </span>
            <span>
              Ask the <strong>agent</strong> on the right to draft, edit, or explain — it shows
              every change before it lands.
            </span>
          </li>
        </ol>
        <div className="coach-foot">
          <button
            type="button"
            className="coach-dismiss"
            data-testid="coach-dismiss"
            onClick={onDismiss}
          >
            Got it
          </button>
          <span className="coach-hint">Press Esc or click anywhere to dismiss</span>
        </div>
      </div>
    </div>
  );
}
