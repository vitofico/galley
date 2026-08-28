import { useEffect, useRef } from "react";
import { useFocusTrap } from "./use-focus-trap.js";
import "./agent-open-consent.css";

/**
 * `AgentOpenConsent` (#16.3) — the BLOCKING, accessible per-request consent modal
 * a paired MCP agent's `open_project` raises. ProjectApp owns the decision
 * promise; this component is presentational + injection-only:
 *
 *   - It renders byte-for-byte ABSENT when `pending` is null (the shipped path is
 *     unchanged until an agent actually asks and the user has Agent Access on).
 *   - Default-DENY: the safe action (Deny) is the focused default; Escape and a
 *     backdrop click both DENY. Only the explicit "Share project" button approves.
 *   - The copy NAMES the project and states that approving starts live
 *     collaboration and shares the document's FULL CONTENT with the paired agent.
 *
 * A11y: `role="dialog"` + `aria-modal="true"`, labelled/described by its own
 * heading + body; focus lands on Deny when it opens; Escape denies.
 */
export interface AgentOpenConsentPending {
  /** The display name of the currently-open project the agent asked to open. */
  projectName: string;
  /** Resolve the awaiting handler: true = approve (share), false = deny. */
  resolve: (approved: boolean) => void;
}

export function AgentOpenConsent({ pending }: { pending: AgentOpenConsentPending | null }) {
  const denyRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // A11y (#23.5): trap Tab + restore focus on close (autofocus/Escape below).
  useFocusTrap(dialogRef, pending !== null);

  // Focus the safe default (Deny) when the modal opens.
  useEffect(() => {
    if (pending) denyRef.current?.focus();
  }, [pending]);

  // Escape denies while the modal is open.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        pending.resolve(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending]);

  // Additive: render NOTHING when there is no pending request.
  if (!pending) return null;

  return (
    <div
      className="agent-consent-backdrop"
      // Backdrop click denies (only when the click is on the backdrop itself).
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) pending.resolve(false);
      }}
    >
      <div
        ref={dialogRef}
        className="agent-consent"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-consent-title"
        aria-describedby="agent-consent-body"
        data-testid="agent-open-consent"
      >
        <p className="agent-consent-eyebrow">Agent request</p>
        <h2 className="agent-consent-title" id="agent-consent-title">
          Share this project with the agent?
        </h2>
        <p className="agent-consent-body" id="agent-consent-body">
          A paired AI agent (via the Galley MCP kernel) is asking to open{" "}
          <span className="agent-consent-project" data-testid="agent-open-consent-project">
            {pending.projectName}
          </span>
          .
        </p>
        <p className="agent-consent-warn">
          Approving starts live collaboration and shares this document&rsquo;s{" "}
          <strong>full content</strong> with the agent until you revoke access. Only approve
          requests you initiated.
        </p>
        <div className="agent-consent-actions">
          <button
            type="button"
            ref={denyRef}
            className="agent-consent-deny"
            data-testid="agent-open-consent-deny"
            onClick={() => pending.resolve(false)}
          >
            Deny
          </button>
          <button
            type="button"
            className="agent-consent-approve"
            data-testid="agent-open-consent-approve"
            onClick={() => pending.resolve(true)}
          >
            Share project
          </button>
        </div>
      </div>
    </div>
  );
}
