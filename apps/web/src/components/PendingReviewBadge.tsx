import type { ReactNode } from "react";

/**
 * ADR-0024 §4 — the GLOBAL, always-visible pending-review surface.
 *
 * Proposal review used to live ONLY inside the collapsible agent sidebar, which
 * is marked `inert`/`aria-hidden` when collapsed — so a pending agent change was
 * invisible the moment the panel was tucked away, and a VIEWER (who never sees
 * the sidebar's Accept cards) had no signal at all. This badge moves the
 * "you have N pending changes" signal to the shell root (next to the durability
 * bar), where it stays visible regardless of panel state.
 *
 * It is a thin shell:
 *  - a count badge that is ABSENT when `count === 0` (default-safe: a project
 *    with no pending proposals renders nothing and the existing layout is
 *    byte-for-byte unchanged);
 *  - for an editor (`canMutate`), the badge is a button that toggles an inline
 *    review pane hosting the EXISTING `McpProposals` / `McpFileProposals` cards
 *    (passed as `children`) — Accept/Reject logic is reused verbatim, this only
 *    changes WHERE it mounts;
 *  - for a viewer (`canMutate === false`), the badge is a static "ask an editor"
 *    cue with the count but no Accept affordance.
 *
 * Visual language follows the durability bar / Agent access panel (token-driven,
 * calm); see pending-review-badge.css.
 */
export function PendingReviewBadge({
  count,
  canMutate,
  open,
  onToggle,
  children,
}: {
  /**
   * Pending agent RUNS awaiting review (ADR-0025 §6) — one still-streaming run
   * counts as one unit, NOT the number of individual proposals. Zero ⇒ no badge.
   */
  count: number;
  /** Write capability — gates the ACCEPT action only (the count shows either way). */
  canMutate: boolean;
  /** Whether the inline review pane is expanded (editors only). */
  open: boolean;
  /** Toggle the review pane (editors only). */
  onToggle: () => void;
  /** The existing proposal cards, hosted in the review pane when open. */
  children?: ReactNode;
}): JSX.Element | null {
  // Default-safe: nothing pending ⇒ no badge, no layout shift.
  if (count <= 0) return null;

  const label = `${count} pending review${count === 1 ? "" : "s"}`;

  // A viewer sees the count but cannot Accept — a static cue, no toggle, no pane.
  if (!canMutate) {
    return (
      <div className="pending-review-bar" data-testid="pending-review-bar">
        <span
          className="pending-review-chip pending-review-chip--viewer"
          data-testid="pending-review-viewer"
          role="status"
        >
          <span className="pending-review-count" data-testid="pending-review-count">
            {count}
          </span>{" "}
          pending change{count === 1 ? "" : "s"} — ask an editor to review
        </span>
      </div>
    );
  }

  return (
    <div className="pending-review-bar" data-testid="pending-review-bar">
      <button
        type="button"
        className="pending-review-chip"
        data-testid="pending-review-badge"
        aria-expanded={open}
        aria-controls="pending-review-pane"
        onClick={onToggle}
      >
        <span className="pending-review-count" data-testid="pending-review-count">
          {count}
        </span>{" "}
        {label}
        <span className="pending-review-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <section
          id="pending-review-pane"
          className="pending-review-pane"
          data-testid="pending-review-pane"
          aria-label="Pending agent proposals"
        >
          {children}
        </section>
      )}
    </div>
  );
}
