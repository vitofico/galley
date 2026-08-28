import type { AgentMode } from "./agent-access-panel-mode.js";

/**
 * The unified AGENT ACCESS PANEL (ADR-0025 §1/§5, Task 8) — one per-project
 * Ask/Auto control that governs BOTH acceptance surfaces (the in-app agent and a
 * paired MCP agent), folding in the former `AutoAcceptBar`'s instant kill-switch
 * and apply-then-review audit trail. `AutoAcceptBar` and its buried two-step
 * arm/confirm are retired in favour of this single, glanceable surface.
 *
 * PURE PRESENTATIONAL. All authority lives in the two stores the PARENT owns (the
 * MAC'd MCP grant + the in-app per-project setting, ADR-0025 §1); this component
 * only renders the EFFECTIVE mode and calls back. The parent decides, per the
 * pure `agentModeWrites` policy, which stores a selection writes — crucially the
 * MCP grant store is written ONLY when a grant is active, so a plain project
 * setting can never authorize MCP auto-apply. `canMutate` is a defensive second
 * guard so a viewer never sees the controls even if the panel is mounted
 * (ADR-0023 §5: "a viewer never sees or flips it").
 *
 * The brand `--err` true-red is reserved for DESTRUCTIVE controls; choosing Auto
 * is consequential but recoverable (every change is checkpointed and revertable),
 * so the active Auto state leans on the ACCENT tokens for unmissable weight and a
 * `failed` audit row degrades to a muted `--warn`, never red.
 */

/**
 * One merged audit row (newest-first), shaped to read identically whether it came
 * from the MCP durable tombstone audit or the in-app provenance trail.
 */
export interface AgentAccessAuditRow {
  /** Stable key (the MCP `(id,digest)` or the in-app run id). */
  key: string;
  /** The originating user request. */
  request: string;
  /** How many files the apply touched. */
  fileCount: number;
  /** Unix-ms timestamp. */
  at: number;
  /** The lifecycle state of the entry. */
  state: "started" | "applied" | "failed" | "accepted" | "rejected";
  /** Which surface produced it — a small provenance cue. */
  source: "mcp" | "in-app";
}

export interface AgentAccessPanelProps {
  /** The EFFECTIVE mode to display (parent-computed from both stores). */
  mode: AgentMode;
  /** Write capability; a viewer (false) never sees the controls. */
  canMutate: boolean;
  /** True when a paired-agent (MCP) grant is active. */
  grantActive: boolean;
  /**
   * True when the active paired-agent grant's own mode is Auto (F12). The Auto
   * sublabel keys off THIS — the grant.mode is the sole MCP auto-apply authority,
   * so the UI must never claim "(including the paired agent's signed proposals)"
   * unless the grant itself grants it (grantActive alone over-promised).
   */
  grantAuto: boolean;
  /** Select a mode. The parent fans this out to the authoritative store(s). */
  onSelectMode: (mode: AgentMode) => void;
  /** Merged audit trail, newest-first; may be empty. */
  audit: AgentAccessAuditRow[];
}

/** Max audit rows rendered before collapsing to a "+N more" line. */
const MAX_AUDIT_ROWS = 8;

/** Human label per audit lifecycle state. */
const STATE_LABEL: Record<AgentAccessAuditRow["state"], string> = {
  started: "applying…",
  applied: "applied",
  failed: "failed",
  accepted: "accepted",
  rejected: "rejected",
};

/** Short, locale-stable time for an audit row (HH:MM). */
function formatAt(at: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function AgentAccessPanel(props: AgentAccessPanelProps): JSX.Element | null {
  const { mode, canMutate, grantAuto, onSelectMode, audit } = props;

  // Defensive: a viewer never sees this panel (the parent also hides it).
  if (!canMutate) return null;

  const isAuto = mode === "auto";
  const shown = audit.slice(0, MAX_AUDIT_ROWS);
  const hidden = audit.length - shown.length;

  return (
    <section
      className="agent-access-panel"
      data-testid="agent-access-panel"
      aria-label="Agent access"
    >
      <div className="agent-access-mode">
        <span className="agent-access-mode-title" id="agent-access-mode-title">
          Accept agent changes
        </span>
        <div
          className="agent-access-mode-choice"
          role="radiogroup"
          aria-labelledby="agent-access-mode-title"
        >
          <button
            type="button"
            role="radio"
            aria-checked={!isAuto}
            className={
              isAuto
                ? "agent-access-mode-btn"
                : "agent-access-mode-btn agent-access-mode-btn--active"
            }
            data-testid="agent-mode-ask"
            onClick={() => onSelectMode("ask")}
          >
            Ask
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={isAuto}
            className={
              isAuto
                ? "agent-access-mode-btn agent-access-mode-btn--active agent-access-mode-btn--auto"
                : "agent-access-mode-btn"
            }
            data-testid="agent-mode-auto"
            onClick={() => onSelectMode("auto")}
          >
            Auto
          </button>
        </div>
      </div>

      <p className="agent-access-caption">
        {isAuto ? (
          <>
            <span className="agent-access-bolt" aria-hidden="true">
              ⚡
            </span>{" "}
            Auto — finished runs apply without a click
            {grantAuto ? " (including the paired agent's signed proposals)" : ""}. Every
            change is checkpointed and revertable.
          </>
        ) : (
          <>Ask — every agent run waits for your Accept before it applies.</>
        )}
      </p>

      {isAuto && (
        // Instant kill-switch (ADR-0025 §5): one click → back to Ask, no confirm.
        <button
          type="button"
          className="agent-auto-killswitch"
          data-testid="agent-auto-killswitch"
          onClick={() => onSelectMode("ask")}
        >
          Turn off auto
        </button>
      )}

      {audit.length > 0 && (
        <ul className="agent-access-audit" data-testid="agent-access-audit">
          {shown.map((row) => (
            <li
              key={row.key}
              className={
                row.state === "failed"
                  ? "agent-access-audit-row agent-access-audit-row--failed"
                  : "agent-access-audit-row"
              }
              data-testid="agent-access-audit-row"
              data-state={row.state}
              data-source={row.source}
            >
              <span className="agent-access-audit-request">{row.request}</span>
              <span className="agent-access-audit-files">
                {row.fileCount} file{row.fileCount === 1 ? "" : "s"}
              </span>
              <time
                className="agent-access-audit-at"
                dateTime={new Date(row.at).toISOString()}
              >
                {formatAt(row.at)}
              </time>
              <span className="agent-access-audit-state">{STATE_LABEL[row.state]}</span>
            </li>
          ))}
          {hidden > 0 && (
            <li className="agent-access-audit-more" data-testid="agent-access-audit-more">
              +{hidden} more
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
