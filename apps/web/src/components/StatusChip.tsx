/**
 * `StatusChip` (#19.3, spec §1/§2) — the brand pill's ONE status readout. The
 * compile status ("3 page(s)" / "2 error(s)"), the save-state badge, and the
 * package/compile notices collapse into a single calm chip; clicking it opens
 * a popover with the spelled-out details AND the Local/Server/Auto compiler
 * toggle (moved out of the pill — it's configuration, not status).
 *
 * Testid contract: `status` and `save-state` stay on ALWAYS-VISIBLE elements
 * INSIDE the chip (same text/attributes as their topbar-era spans), so the
 * suite's many `getByTestId("status")` assertions hold without edits. The
 * popover details (notices, compiler toggle) render only while open — their
 * specs gain one "open the chip" step.
 *
 * A11y: the chip is a button with `aria-haspopup="dialog"`/`aria-expanded`;
 * the popover is a named non-modal dialog; Escape closes and returns focus to
 * the chip; an outside pointerdown closes without stealing focus.
 */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { saveStateLabel, type SaveState } from "../use-save-state.js";
import { statusGlyph, type StatusGlyphInputs } from "./status-chip.js";
import { useDismissable, type DismissReason } from "./use-dismissable.js";
import "./rail-and-pills.css";

export interface StatusChipProps {
  /** The compile status text (unchanged contract: "3 page(s)", "2 error(s)"…). */
  status: string;
  /** The calm three-way save status (#18.2). */
  saveState: SaveState;
  /** Inputs for the chip's severity glyph. */
  glyphInputs: StatusGlyphInputs;
  /**
   * Optional "export a copy" action (the source bundle). When provided, the Save
   * row carries a CALM resting reminder that local-first work lives only on this
   * device and is worth backing up — distinct from the at-risk eviction banner,
   * which only fires near the storage cap. Passive: it lives inside the opt-in
   * popover and never nags.
   */
  onBackup?: () => void;
  /**
   * The origin's storage is TRANSIENT — the browser hasn't granted persistent
   * storage, so the local-first copy is at real risk: a private/incognito window
   * clears IndexedDB on close. When true (and `onBackup` is set) the Save-row cue
   * is stronger and more specific than the generic local-only reminder, closing
   * the documented gap where an incognito user got no warning at all. Still
   * passive (inside the opt-in popover) — informs without nagging.
   */
  transient?: boolean;
  /** Popover detail rows (package notices, the compiler-mode toggle…). */
  children?: ReactNode;
}

/** The save badge's spelled-out explanation (the old badge's title text). */
function saveDetail(state: SaveState): string {
  switch (state) {
    case "offline":
      return "You're offline — your work is still saved on this device.";
    case "saving":
      return "Saving your work to this device…";
    case "saved":
      return "Your work is saved on this device.";
    case "at-risk":
      return "This device's storage is unavailable, so your work isn't being saved — back up a copy before closing the tab.";
  }
}

export function StatusChip({
  status,
  saveState,
  glyphInputs,
  onBackup,
  transient,
  children,
}: StatusChipProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback((reason: DismissReason | "action") => {
    setOpen(false);
    if (reason === "escape") chipRef.current?.focus();
  }, []);
  useDismissable(open, rootRef, close);

  const { tone, glyph } = statusGlyph(glyphInputs);

  return (
    <div className="status-chip-wrap" ref={rootRef}>
      <button
        type="button"
        ref={chipRef}
        className={`status-chip status-chip--${tone}`}
        data-testid="status-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Document status — compile, save, and compiler settings"
        onClick={() => (open ? close("action") : setOpen(true))}
      >
        <span className="status-chip-glyph" aria-hidden="true">
          {glyph}
        </span>
        <span className="status" data-testid="status">
          {status}
        </span>
        <span className="status-chip-dot" aria-hidden="true">
          ·
        </span>
        <span
          className={`save-state save-state--${saveState}`}
          data-testid="save-state"
          data-state={saveState}
          role="status"
          aria-label={`Document ${saveStateLabel(saveState)}`}
        >
          {saveStateLabel(saveState)}
        </span>
        <span className="status-chip-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div
          className="ui-popover status-popover"
          role="dialog"
          aria-label="Document status"
          data-testid="status-popover"
        >
          <dl className="status-popover-rows">
            <div className="status-popover-row">
              <dt>Compile</dt>
              <dd>{status}</dd>
            </div>
            <div className="status-popover-row">
              <dt>Save</dt>
              <dd>
                {saveDetail(saveState)}
                {onBackup && (
                  <span
                    className="status-popover-backup"
                    data-testid="status-backup-cue"
                    data-transient={transient ? "true" : undefined}
                  >
                    {" "}
                    {transient
                      ? "This browser may not keep your work after you close it — in a private/incognito window it's cleared on close."
                      : "It lives only here — keep a copy safe."}{" "}
                    <button
                      type="button"
                      className="status-popover-link"
                      data-testid="status-backup-export"
                      onClick={() => {
                        onBackup();
                        close("action");
                      }}
                    >
                      Export a copy
                    </button>
                  </span>
                )}
              </dd>
            </div>
          </dl>
          {children}
        </div>
      )}
    </div>
  );
}
