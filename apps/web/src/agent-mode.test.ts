import { describe, it, expect } from "vitest";
import {
  AGENT_MODE_KEY,
  loadAgentMode,
  saveAgentMode,
  type AgentStorage,
} from "./agent-mode.js";

/**
 * Pure-core tests for agent-mode persistence (#14) — the MIRROR of focus mode.
 * The module reads/writes a single boolean flag through a minimal `Storage`
 * subset, so we drive it with a plain in-memory stand-in and keep the gate in
 * the `node` environment (no jsdom, the repo's test layer).
 *
 * Contract:
 *   - Default OFF: unset / invalid / unavailable storage → `false`.
 *   - "1" round-trips to `true`, "0" (and anything else) to `false`.
 *   - Persistence is best-effort: throwing storage never escapes.
 *   - Importing the module touches nothing.
 */

function memStorage(seed: Record<string, string> = {}): AgentStorage & {
  data: Record<string, string>;
} {
  const data: Record<string, string> = { ...seed };
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe("agent-mode persistence (#14)", () => {
  it("uses the dedicated, focus-mode-distinct storage key", () => {
    expect(AGENT_MODE_KEY).toBe("galley.agentMode");
  });

  it("defaults OFF when the key is unset", () => {
    expect(loadAgentMode(memStorage())).toBe(false);
  });

  it("defaults OFF when storage is unavailable", () => {
    expect(loadAgentMode(null)).toBe(false);
  });

  it("reads '1' as ON", () => {
    expect(loadAgentMode(memStorage({ [AGENT_MODE_KEY]: "1" }))).toBe(true);
  });

  it("reads '0' (and any non-'1' value) as OFF", () => {
    expect(loadAgentMode(memStorage({ [AGENT_MODE_KEY]: "0" }))).toBe(false);
    expect(loadAgentMode(memStorage({ [AGENT_MODE_KEY]: "true" }))).toBe(false);
    expect(loadAgentMode(memStorage({ [AGENT_MODE_KEY]: "" }))).toBe(false);
  });

  it("persists ON as '1' and OFF as '0'", () => {
    const s = memStorage();
    saveAgentMode(true, s);
    expect(s.data[AGENT_MODE_KEY]).toBe("1");
    saveAgentMode(false, s);
    expect(s.data[AGENT_MODE_KEY]).toBe("0");
  });

  it("round-trips through save → load", () => {
    const s = memStorage();
    saveAgentMode(true, s);
    expect(loadAgentMode(s)).toBe(true);
    saveAgentMode(false, s);
    expect(loadAgentMode(s)).toBe(false);
  });

  it("swallows read failures, returning the OFF default", () => {
    const throwing: AgentStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
    };
    expect(loadAgentMode(throwing)).toBe(false);
  });

  it("swallows write failures (best-effort persistence)", () => {
    const throwing: AgentStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => saveAgentMode(true, throwing)).not.toThrow();
  });
});
