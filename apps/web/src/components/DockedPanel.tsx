import { useEffect, type ReactNode } from "react";
import "./rail-and-pills.css";

/**
 * `DockedPanel` — the floating-card host that panels dock into beside the icon
 * rail (#19.2, spec §1/§9). Provides the card chrome (header with a title and
 * a Close button) for panels that don't carry their own (Files, History);
 * panels that already render a full `authoring-panel` card (Git sync, the
 * Insert tabs' panels, editor prefs) dock with their own chrome instead.
 *
 * The Close button's accessible name is "Close" — the same name the modal
 * overlays used — so existing e2e (`getByRole("button", { name: "Close" })`)
 * keeps working against the docked presentation.
 */
export interface DockedPanelProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Optional testid for the card (e.g. the history card keeps "history-overlay"). */
  testId?: string;
}

export function DockedPanel({ title, onClose, children, testId }: DockedPanelProps) {
  // M15: Escape closes the docked panel (Files / Search / History / Outline) —
  // previously the ✕ was reachable only by tabbing. Non-modal: a global keydown
  // (matching the Insert panels' Escape and `use-dismissable.ts`) that does NOT
  // trap focus or close on outside-click — a docked panel stays put while you work
  // in the editor. Only mounted while its dock is open.
  //
  // Escape must close the INNERMOST thing first: the Files dock has its own
  // Escape interactions (cancel a rename / new-folder input, close the file
  // context menu). So defer when the event was already handled, or focus sits on
  // an editable control or inside an open menu — let that inner control take the
  // Escape; the dock only closes when nothing inner claims it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Use the event TARGET (fixed at dispatch), not `document.activeElement`:
      // an inner Escape handler (cancel a rename) re-renders and UNMOUNTS its
      // input synchronously (React 18 flushes discrete keydowns), so by the time
      // this window listener runs the active element is already gone — but
      // `e.target` still points at the control that owned the Escape.
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable ||
          t.closest('[role="menu"]'))
      ) {
        return;
      }
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <section
      className="docked-panel"
      aria-label={title}
      {...(testId ? { "data-testid": testId } : {})}
    >
      <header className="docked-panel-head">
        <h2 className="docked-panel-title">{title}</h2>
        <button
          type="button"
          className="docked-panel-close"
          aria-label="Close"
          title="Close"
          onClick={onClose}
        >
          ✕
        </button>
      </header>
      <div className="docked-panel-body">{children}</div>
    </section>
  );
}
