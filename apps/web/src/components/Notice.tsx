/**
 * `Notice` (#19.4, spec §8) — the ONE shared inline notice: a severity glyph,
 * a message, and an optional action button, replacing ad-hoc alert spans.
 * Adopted this slice at exactly two call sites (share failure + main-file-
 * deleted); the remaining ad-hoc notices migrate in a later slice.
 *
 * Calm by design: token-driven colors (both themes), `role="alert"` only for
 * errors (warnings/info use a polite status region), no animation.
 */
import type { ReactNode } from "react";
import "./notice.css";

export type NoticeSeverity = "info" | "warning" | "error";

/** The ARIA role for a severity — errors interrupt, the rest stay polite. */
export function noticeRole(severity: NoticeSeverity): "alert" | "status" {
  return severity === "error" ? "alert" : "status";
}

/** The severity glyph (decorative; the color carries the same signal). */
export function noticeGlyph(severity: NoticeSeverity): string {
  switch (severity) {
    case "info":
      return "ℹ";
    case "warning":
      return "⚠";
    case "error":
      return "⚠";
  }
}

export interface NoticeAction {
  label: string;
  onClick: () => void;
  /** Optional testid for the action button. */
  testId?: string;
  /** Optional hover title explaining what the action will do. */
  title?: string;
}

export function Notice({
  severity,
  message,
  action,
  testId,
}: {
  severity: NoticeSeverity;
  message: ReactNode;
  action?: NoticeAction;
  testId?: string;
}) {
  return (
    <div
      className={`notice notice-${severity}`}
      role={noticeRole(severity)}
      {...(testId ? { "data-testid": testId } : {})}
    >
      <span className="notice-glyph" aria-hidden="true">
        {noticeGlyph(severity)}
      </span>
      <span className="notice-message">{message}</span>
      {action && (
        <button
          type="button"
          className="notice-action"
          onClick={action.onClick}
          {...(action.testId ? { "data-testid": action.testId } : {})}
          {...(action.title ? { title: action.title } : {})}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
