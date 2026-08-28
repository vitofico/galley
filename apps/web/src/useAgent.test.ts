import { describe, it, expect } from "vitest";
import type { AgentRunResult } from "@galley/agent";
import type { AgentEvent } from "@galley/shared";
import { endOfRun } from "./useAgent.js";
import { accumulateUsage } from "./cost-estimate.js";

const RESULT: AgentRunResult = {
  outcome: "compiled_clean",
  finalSource: "= Title\n",
  blocks: [{ search: "a", replace: "b" }],
  check: null,
};

describe("endOfRun — cancel resolves to a CLEAN stopped state", () => {
  it("an abort yields stopped: not running, no error, no held result", () => {
    expect(endOfRun({ kind: "aborted" })).toEqual({
      running: false,
      stopped: true,
      result: null,
      error: null,
    });
  });

  it("a finished run holds the result and is not stopped/errored", () => {
    expect(endOfRun({ kind: "finished", result: RESULT })).toEqual({
      running: false,
      stopped: false,
      result: RESULT,
      error: null,
    });
  });

  it("a thrown error surfaces the message and offers no result", () => {
    expect(endOfRun({ kind: "threw", error: new Error("boom") })).toEqual({
      running: false,
      stopped: false,
      result: null,
      error: "boom",
    });
  });

  it("stringifies non-Error throws", () => {
    expect(endOfRun({ kind: "threw", error: "weird" }).error).toBe("weird");
  });
});

/**
 * The hook exposes an additive `usage` estimate derived from its collected
 * events via `accumulateUsage` (see useAgent.ts). This guards that contract:
 * the derivation the hook performs is event-driven and starts at zero.
 */
describe("useAgent usage — additive estimate derived from events", () => {
  it("is all-zero before any events", () => {
    expect(accumulateUsage([])).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });

  it("grows as the hook accumulates streamed events", () => {
    const events: AgentEvent[] = [
      { type: "run_started", runId: "r1", baseRevision: 0 },
      { type: "assistant_text", text: "Working on it now." }, // 18 chars → 5 (out)
    ];
    const u = accumulateUsage(events);
    expect(u.completionTokens).toBe(5);
    expect(u.totalTokens).toBe(5);
    expect(u.estimatedCostUsd).toBeUndefined();
  });
});
