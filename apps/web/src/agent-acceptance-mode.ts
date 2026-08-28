/**
 * The IN-APP agent's per-project acceptance mode (ADR-0025 §7).
 *
 * Two authoritative stores back the unified acceptance UI; this is the IN-APP
 * one. It is a PLAIN localStorage value — NOT MAC'd — because the in-app agent's
 * edits are generated in the user's own browser (no relay, no foreign writer, no
 * signature to forge): there is nothing for an integrity MAC to protect that the
 * same-origin attacker could not also overwrite. The MCP agent's authority lives
 * elsewhere, inside the MAC'd `ProposalGrant` as `grant.mode`, and the MCP
 * auto-apply path reads ONLY that — this setting MUST NEVER widen MCP trust.
 *
 * Named `agentAcceptanceMode` deliberately: `agentMode` already means the editor
 * LAYOUT mode (agent+preview vs editor) in `agent-mode.ts` — a different concept.
 *
 * Importing this module has ZERO side effects (mirrors `agent-mode.ts`): storage
 * is only touched on an explicit call, so the default stays untouched until a
 * caller wires it in. Default is "ask" (a deliberate opt-in to "auto").
 */

/** The per-project in-app acceptance mode. */
export type AgentAcceptanceMode = "ask" | "auto";

/** The localStorage key namespace for the per-project in-app acceptance mode. */
const KEY_PREFIX = "galley.agentAcceptanceMode.";

/** The per-project storage key for a given project id. */
function keyFor(projectId: string): string {
  return `${KEY_PREFIX}${projectId}`;
}

/** The minimal storage surface this module needs (a subset of `Storage`). */
export interface AcceptanceModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): AcceptanceModeStorage | null {
  const s = (globalThis as { localStorage?: AcceptanceModeStorage }).localStorage;
  return s ?? null;
}

/**
 * Read the in-app acceptance mode for a project. Returns "ask" (the fail-closed
 * default) when unset, an unrecognized value, or storage is unavailable.
 */
export function getProjectAcceptanceMode(
  projectId: string,
  storage?: AcceptanceModeStorage | null,
): AgentAcceptanceMode {
  const s = storage === undefined ? defaultStorage() : storage;
  if (!s) return "ask";
  try {
    return s.getItem(keyFor(projectId)) === "auto" ? "auto" : "ask";
  } catch {
    return "ask";
  }
}

/**
 * Persist the in-app acceptance mode for a project. Best-effort — storage
 * failures are swallowed (the setting just stays at its previous/default value).
 */
export function setProjectAcceptanceMode(
  projectId: string,
  mode: AgentAcceptanceMode,
  storage?: AcceptanceModeStorage | null,
): void {
  const s = storage === undefined ? defaultStorage() : storage;
  if (!s) return;
  try {
    s.setItem(keyFor(projectId), mode);
  } catch {
    /* persistence is best-effort */
  }
}
