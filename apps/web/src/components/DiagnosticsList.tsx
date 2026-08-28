import type { Diagnostic } from "@galley/shared";
import { quickFixAvailable } from "./quick-fix.js";
import { explainAvailable } from "./explain-error.js";

/**
 * `DiagnosticsList` — the shared presentational diagnostics `<ul>` rendered under
 * the preview in BOTH shells (single-file `App` and the `ProjectApp` shell). It
 * was duplicated byte-for-byte in both; extracting it keeps the markup (every
 * `data-testid`, class, and asserted string) identical while DRYing the wiring.
 *
 * Purely presentational: the parent owns the diagnostics array and the three
 * actions (jump-to-source, quick-fix, explain). Renders NOTHING when empty, so a
 * shell with no diagnostics is byte-for-byte unchanged.
 */
export interface DiagnosticsListProps {
  diagnostics: Diagnostic[];
  /** Jump the editor to a located diagnostic (no-op when it has no span). */
  onJump: (d: Diagnostic) => void;
  /** Quick-fix a diagnostic via the agent (only shown when available). */
  onQuickFix: (d: Diagnostic) => void;
  /** Explain a diagnostic via the agent (only shown when available). */
  onExplain: (d: Diagnostic) => void;
}

export function DiagnosticsList({
  diagnostics,
  onJump,
  onQuickFix,
  onExplain,
}: DiagnosticsListProps) {
  if (diagnostics.length === 0) return null;
  return (
    <ul className="diagnostics" data-testid="diagnostics" aria-label="Diagnostics">
      {diagnostics.map((d, i) => (
        <li key={i} className={`diag diag-${d.severity}`}>
          <button
            type="button"
            className="diag-jump"
            data-testid="diagnostic"
            disabled={!d.span}
            title={d.span ? "Jump to this location" : undefined}
            onClick={() => onJump(d)}
          >
            {d.span ? `${d.span.start.line}:${d.span.start.column} ` : ""}
            {d.severity}: {d.message}
          </button>
          {quickFixAvailable(d) && (
            <button
              type="button"
              className="diag-quickfix"
              data-testid="quick-fix"
              title="Ask the agent to fix this"
              aria-label={`Quick-fix: ${d.message}`}
              onClick={() => onQuickFix(d)}
            >
              💡 Fix
            </button>
          )}
          {explainAvailable(d) && (
            <button
              type="button"
              className="diag-quickfix diag-explain"
              data-testid="explain-error"
              title="Ask the agent to explain this error"
              aria-label={`Explain: ${d.message}`}
              onClick={() => onExplain(d)}
            >
              🎓 Explain
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
