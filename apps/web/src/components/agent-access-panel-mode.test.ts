import { describe, it, expect } from "vitest";
import {
  effectiveAgentMode,
  agentModeWrites,
} from "./agent-access-panel-mode.js";

/**
 * Offline unit tests for the Agent access panel's pure mode policy (ADR-0025 §1,
 * Task 8). The load-bearing invariant: a mode selection with NO active grant
 * writes ONLY the in-app project store and NEVER the MCP grant store — a plain
 * project setting must not authorize MCP auto-apply.
 */

describe("effectiveAgentMode — what the Ask/Auto control shows", () => {
  it("defaults to Ask when both stores are Ask", () => {
    expect(effectiveAgentMode("ask", "ask")).toBe("ask");
  });

  it("shows Ask when there is no grant and the project setting is Ask", () => {
    expect(effectiveAgentMode(null, "ask")).toBe("ask");
  });

  it("shows Auto when the in-app project setting is Auto (no grant)", () => {
    expect(effectiveAgentMode(null, "auto")).toBe("auto");
  });

  it("shows Auto when the MCP grant is Auto even if the project setting lags at Ask", () => {
    expect(effectiveAgentMode("auto", "ask")).toBe("auto");
  });

  it("shows Auto when both stores are Auto", () => {
    expect(effectiveAgentMode("auto", "auto")).toBe("auto");
  });

  it("shows Ask when the grant exists but is Ask and the project is Ask", () => {
    expect(effectiveAgentMode("ask", "ask")).toBe("ask");
  });
});

describe("agentModeWrites — which authoritative stores a selection touches", () => {
  it("selecting Auto WITH an active grant writes BOTH stores", () => {
    const w = agentModeWrites("auto", true);
    expect(w).toEqual({ mode: "auto", project: true, grant: true });
  });

  it("selecting Auto with NO active grant writes ONLY the project store", () => {
    const w = agentModeWrites("auto", false);
    expect(w.project).toBe(true);
    expect(w.grant).toBe(false);
  });

  it("the kill-switch (selecting Ask) WITH a grant resets BOTH stores", () => {
    const w = agentModeWrites("ask", true);
    expect(w).toEqual({ mode: "ask", project: true, grant: true });
  });

  it("the kill-switch with NO grant resets ONLY the project store", () => {
    const w = agentModeWrites("ask", false);
    expect(w.project).toBe(true);
    expect(w.grant).toBe(false);
  });

  it("never writes the grant store without an active grant, for either mode", () => {
    expect(agentModeWrites("auto", false).grant).toBe(false);
    expect(agentModeWrites("ask", false).grant).toBe(false);
  });
});
