/**
 * Agent mode persistence (#14).
 *
 * The MIRROR of focus mode: when ON, the shell hides the EDITOR (and, in the
 * project shell, the file pane) for an agent+preview view — you drive the doc
 * through the agent panel while watching the rendered preview. Default OFF → the
 * layout is byte-for-byte the current one (the shell omits the `data-agent`
 * attribute entirely). It is mutually exclusive with focus mode (which instead
 * hides the agent panel); the toggle handlers enforce that.
 *
 * Importing this module has ZERO side effects (mirrors focus-mode.ts / theme.ts):
 * storage is only touched on an explicit call, so the default stays untouched
 * until the rail/palette toggle wires it in.
 */

/** localStorage key the agent-mode flag is persisted under. */
export const AGENT_MODE_KEY = "galley.agentMode";

/** The minimal storage surface this module needs (a subset of `Storage`). */
export interface AgentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): AgentStorage | null {
  const s = (globalThis as { localStorage?: AgentStorage }).localStorage;
  return s ?? null;
}

/**
 * Read the persisted agent-mode flag. Returns `false` (the byte-for-byte
 * default) when unset, invalid, or storage is unavailable.
 */
export function loadAgentMode(storage?: AgentStorage | null): boolean {
  const s = storage === undefined ? defaultStorage() : storage;
  if (!s) return false;
  try {
    return s.getItem(AGENT_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist the agent-mode flag. Best-effort — storage failures are swallowed. */
export function saveAgentMode(on: boolean, storage?: AgentStorage | null): void {
  const s = storage === undefined ? defaultStorage() : storage;
  if (!s) return;
  try {
    s.setItem(AGENT_MODE_KEY, on ? "1" : "0");
  } catch {
    /* persistence is best-effort */
  }
}
