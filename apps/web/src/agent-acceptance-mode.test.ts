import { describe, it, expect } from "vitest";
import {
  getProjectAcceptanceMode,
  setProjectAcceptanceMode,
  type AcceptanceModeStorage,
} from "./agent-acceptance-mode.js";

/**
 * Offline unit tests for the IN-APP agent's per-project acceptance mode (ADR-0025
 * §7). This is a PLAIN localStorage value (no MAC — in-app edits are generated in
 * the user's own browser and need no signature); it must NEVER be read by the MCP
 * auto-apply path (that authority stays in the MAC'd grant). The pins prove the
 * default is "ask", a set round-trips, two project ids are independent, and a
 * garbage stored value fails closed to "ask".
 */

function makeStore(): { store: AcceptanceModeStorage; map: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    store: {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => void m.set(k, v),
    },
    map: m,
  };
}

describe("agent-acceptance-mode — per-project in-app setting", () => {
  it("defaults to \"ask\" when unset", () => {
    const s = makeStore();
    expect(getProjectAcceptanceMode("proj-1", s.store)).toBe("ask");
  });

  it("setProjectAcceptanceMode persists and reads back", () => {
    const s = makeStore();
    setProjectAcceptanceMode("proj-1", "auto", s.store);
    expect(getProjectAcceptanceMode("proj-1", s.store)).toBe("auto");
    setProjectAcceptanceMode("proj-1", "ask", s.store);
    expect(getProjectAcceptanceMode("proj-1", s.store)).toBe("ask");
  });

  it("two different project ids are independent", () => {
    const s = makeStore();
    setProjectAcceptanceMode("proj-1", "auto", s.store);
    expect(getProjectAcceptanceMode("proj-1", s.store)).toBe("auto");
    expect(getProjectAcceptanceMode("proj-2", s.store)).toBe("ask");
    setProjectAcceptanceMode("proj-2", "auto", s.store);
    expect(getProjectAcceptanceMode("proj-1", s.store)).toBe("auto");
    expect(getProjectAcceptanceMode("proj-2", s.store)).toBe("auto");
  });

  it("the persisted key namespaces by project id under agentAcceptanceMode", () => {
    const s = makeStore();
    setProjectAcceptanceMode("proj-1", "auto", s.store);
    const keys = [...s.map.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain("agentAcceptanceMode");
    expect(keys[0]).toContain("proj-1");
  });

  it("a garbage stored value fails closed to \"ask\"", () => {
    const s = makeStore();
    setProjectAcceptanceMode("proj-1", "auto", s.store);
    // Overwrite the persisted value with something invalid.
    const key = [...s.map.keys()][0]!;
    s.map.set(key, "nonsense");
    expect(getProjectAcceptanceMode("proj-1", s.store)).toBe("ask");
  });
});
