/**
 * Pure decision helpers for the unified Agent access panel (ADR-0025 §1/§5,
 * Task 8). The panel presents ONE per-project Ask/Auto choice over TWO
 * authoritative stores; this module isolates the (testable) policy so the React
 * component stays a thin shell:
 *
 *   - {@link effectiveAgentMode} — what the control SHOWS. Auto only when an
 *     authoritative store actually authorizes it: the MCP grant's `mode` (when a
 *     grant exists) OR the in-app project setting. A plain project setting alone
 *     is enough to show Auto for the IN-APP agent, but it must NEVER imply the
 *     MCP grant is on Auto (that authority is read separately at apply time).
 *   - {@link agentModeWrites} — which stores a selection writes. The in-app
 *     project store is ALWAYS written; the MCP grant store is written ONLY when a
 *     grant is active. This is the load-bearing guard from ADR-0025 §1: "a plain
 *     project setting must never authorize MCP auto-apply" — with no grant, the
 *     selection touches the project store only.
 *
 * No React, no storage, no side effects — the caller performs the writes the
 * descriptor names. Fully exercised by `agent-access-panel-mode.test.ts`.
 */

/** The unified acceptance mode the panel toggles. */
export type AgentMode = "ask" | "auto";

/**
 * The effective mode the Ask/Auto control should DISPLAY.
 *
 * @param grantMode the active MCP grant's `mode`, or null when no grant exists.
 * @param projectMode the in-app per-project acceptance setting.
 *
 * Auto when EITHER authoritative store is on Auto: the MCP grant authorizes the
 * paired agent, or the project setting authorizes the in-app agent. When a grant
 * exists its mode and the project mode are kept in lockstep by the writer, so
 * they agree; the OR only matters transiently (e.g. a grant arriving Auto from a
 * reload while the project setting is still Ask) and biases toward showing the
 * stronger "Auto is live somewhere" signal so the kill-switch stays reachable.
 */
export function effectiveAgentMode(grantMode: AgentMode | null, projectMode: AgentMode): AgentMode {
  return grantMode === "auto" || projectMode === "auto" ? "auto" : "ask";
}

/** Which authoritative stores a mode selection must write. */
export interface AgentModeWrites {
  /** The chosen mode (echoed for the caller). */
  mode: AgentMode;
  /** Always true — the in-app per-project store is the in-app authority. */
  project: true;
  /**
   * Write the MCP grant store? TRUE only when a grant is active. NEVER true with
   * no grant — a plain project setting must not authorize MCP auto-apply
   * (ADR-0025 §1).
   */
  grant: boolean;
}

/**
 * Decide which stores a selection of `mode` writes, given whether an MCP grant
 * is currently active. The in-app project store is always written; the grant
 * store is written ONLY when `grantActive` — the single guard that keeps a
 * project setting from ever widening MCP trust.
 */
export function agentModeWrites(mode: AgentMode, grantActive: boolean): AgentModeWrites {
  return { mode, project: true, grant: grantActive };
}
