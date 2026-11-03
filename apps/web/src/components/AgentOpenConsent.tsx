import { useEffect, useRef, useState } from "react";
import type { AgentAccessOptions } from "../agent-open-handler.js";
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
  initialMode?: "ask" | "auto";
  /** Resolve the awaiting handler: true = approve (share), false = deny. */
  resolve: (approved: boolean, options?: AgentAccessOptions) => void;
}

export function AgentOpenConsent({ pending }: { pending: AgentOpenConsentPending | null }) {
  const denyRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<"ask" | "auto">("ask");
  const [backgroundAccess, setBackgroundAccess] = useState(false);

  // A11y (#23.5): trap Tab + restore focus on close (autofocus/Escape below).
  useFocusTrap(dialogRef, pending !== null);

  // Focus the safe default (Deny) when the modal opens.
  useEffect(() => {
    if (pending) {
      setMode(pending.initialMode ?? "ask");
      setBackgroundAccess(false);
      denyRef.current?.focus();
    }
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
          Approving shares <strong>all files in this project</strong> with the paired
          agent. Reconnecting to this approved project will not ask again. You can
          revoke access in Settings → Agent Access.
        </p>
        <fieldset className="agent-consent-options">
          <legend>Changes to this project</legend>
          <label>
            <input type="radio" name="agent-consent-mode" checked={mode === "ask"}
              onChange={() => setMode("ask")} data-testid="agent-open-consent-ask" />
            Review changes before applying
          </label>
          <label>
            <input type="radio" name="agent-consent-mode" checked={mode === "auto"}
              onChange={() => setMode("auto")} data-testid="agent-open-consent-auto" />
            Apply changes automatically, with undo checkpoints
          </label>
        </fieldset>
        <label className="agent-consent-background">
          <input type="checkbox" checked={backgroundAccess}
            onChange={(e) => setBackgroundAccess(e.currentTarget.checked)}
            data-testid="agent-open-consent-background" />
          Keep access when I switch projects
        </label>
        <p className="agent-consent-body">
          Background access stays limited to this project while a Galley tab is
          open, and expires after seven days of inactivity.
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
            onClick={() => pending.resolve(true, { mode, backgroundAccess })}
          >
            Share project
          </button>
        </div>
      </div>
    </div>
  );
}
