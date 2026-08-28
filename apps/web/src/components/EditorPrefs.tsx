import { useEffect } from "react";
import type { EditorPrefs as EditorPrefsValue } from "../editor-prefs.js";
import "./editor-prefs-panel.css";

/**
 * Editor preferences panel (roadmap #11.5-UI) — the missing UI for the
 * already-persisted prefs capability in `editor-prefs.ts`.
 *
 * PRESENTATIONAL + CONTROLLED: it reflects the `prefs` prop and emits patches
 * via `onChange`; it holds no internal prefs state and runs no module-scope
 * side effects. The coordinator mounts it and wires it to the live editor
 * (remount-on-change) during the integration sweep — this file mounts nowhere
 * itself. Dialog/Escape/backdrop behaviour mirrors `CommandSheet.tsx`.
 */

/**
 * Font-size bounds, mirroring the editor core's normalize() in
 * `editor-prefs.ts` (which clamps to [8, 32]). Re-declared here — those module
 * constants are private — so the panel hands the parent a value the core will
 * accept verbatim.
 */
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;

/** Step used by the +/- font-size steppers. */
const FONT_SIZE_STEP = 0.5;

/**
 * Clamp an arbitrary number (including NaN / ±Infinity from an empty or
 * malformed number input) into the editor's valid [8, 32] range. Non-finite
 * input falls back to the minimum, except +Infinity which saturates to the max.
 */
export function clampFontSize(n: number): number {
  if (Number.isNaN(n)) return FONT_SIZE_MIN;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, n));
}

export interface EditorPrefsProps {
  prefs: EditorPrefsValue;
  onChange: (patch: Partial<EditorPrefsValue>) => void;
  open: boolean;
  onClose: () => void;
  /**
   * Rail & Islands (#19.2): when true the panel renders as a DOCKED card (no
   * fixed backdrop, no modal dialog semantics) inside the shell's dock host.
   * Default false — the modal presentation is byte-for-byte unchanged.
   */
  docked?: boolean;
  /**
   * Unified settings (#19.7): when true the prefs rows render INLINE inside a
   * host surface (the /settings Editor card) — no chrome of their own (no
   * header/close, no backdrop, no Escape binding; the page owns the framing).
   * The controls and their testids are byte-for-byte the panel's.
   */
  embedded?: boolean;
}

export function EditorPrefs({ prefs, onChange, open, onClose, docked, embedded }: EditorPrefsProps) {
  useEffect(() => {
    if (!open || embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, embedded]);

  if (!open) return null;

  const setFontSize = (n: number) => onChange({ fontSize: clampFontSize(n) });

  const panel = (
      <div
        className={`editor-prefs${docked ? " editor-prefs--docked" : ""}${embedded ? " editor-prefs--embedded" : ""}`}
        data-testid="editor-prefs"
        onClick={(e) => e.stopPropagation()}
      >
        {!embedded && (
          <header className="editor-prefs-header">
            <h2 className="editor-prefs-title">Editor preferences</h2>
            <button
              type="button"
              className="editor-prefs-close"
              aria-label="Close"
              onClick={onClose}
            >
              ✕
            </button>
          </header>
        )}

        <div className="editor-prefs-body">
          <div className="editor-prefs-row">
            <label className="editor-prefs-label" htmlFor="editor-prefs-font-size">
              Font size
            </label>
            <div className="editor-prefs-stepper">
              <button
                type="button"
                className="editor-prefs-step"
                aria-label="Decrease font size"
                onClick={() => setFontSize(prefs.fontSize - FONT_SIZE_STEP)}
              >
                −
              </button>
              <input
                id="editor-prefs-font-size"
                data-testid="editor-prefs-font-size"
                className="editor-prefs-font-size"
                type="number"
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                step={FONT_SIZE_STEP}
                value={prefs.fontSize}
                onChange={(e) => setFontSize(e.currentTarget.valueAsNumber)}
              />
              <button
                type="button"
                className="editor-prefs-step"
                aria-label="Increase font size"
                onClick={() => setFontSize(prefs.fontSize + FONT_SIZE_STEP)}
              >
                +
              </button>
              <span className="editor-prefs-unit">px</span>
            </div>
          </div>

          <div className="editor-prefs-row">
            <label className="editor-prefs-label" htmlFor="editor-prefs-wrap">
              Wrap long lines
            </label>
            <input
              id="editor-prefs-wrap"
              data-testid="editor-prefs-wrap"
              type="checkbox"
              checked={prefs.lineWrap}
              onChange={(e) => onChange({ lineWrap: e.currentTarget.checked })}
            />
          </div>
        </div>
      </div>
  );
  if (docked || embedded) return panel;
  return (
    <div
      className="editor-prefs-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Editor preferences"
      onClick={onClose}
    >
      {panel}
    </div>
  );
}
