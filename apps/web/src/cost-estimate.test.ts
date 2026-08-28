import { describe, it, expect } from "vitest";
import type { AgentEvent } from "@galley/shared";
import {
  estimateTokens,
  accumulateUsage,
  formatUsage,
  checkBudget,
  type UsageEstimate,
} from "./cost-estimate.js";

describe("estimateTokens — ~chars/4 heuristic", () => {
  it("is 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("rounds up so non-empty text costs at least 1 token", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("scales ~4 chars per token", () => {
    expect(estimateTokens("x".repeat(40))).toBe(10);
    expect(estimateTokens("x".repeat(41))).toBe(11);
  });
});

/** A representative run: text deltas (output) + tool/diagnostic feedback (input). */
const EVENTS: AgentEvent[] = [
  { type: "run_started", runId: "r1", baseRevision: 0 },
  { type: "assistant_text", text: "Let me read the document first." }, // 31 chars → 8
  { type: "tool_call", tool: "read_document", args: {} },
  { type: "tool_result", tool: "read_document", summary: "read 1234 bytes" }, // 15 chars → 4
  { type: "iteration", index: 1, max: 6 },
  {
    type: "diagnostics",
    diagnostics: [
      {
        severity: "error",
        message: "unexpected token", // 16 chars → 4
      },
    ],
  },
  { type: "assistant_text", text: "Fixing it now." }, // 14 chars → 4
  { type: "run_finished", runId: "r1", outcome: "compiled_clean" },
];

describe("accumulateUsage", () => {
  it("sums completion tokens from assistant_text and prompt tokens from feedback", () => {
    const u = accumulateUsage(EVENTS);
    // completion: 8 (31ch) + 4 (14ch) = 12
    expect(u.completionTokens).toBe(12);
    // prompt: 4 (tool summary, 15ch) + 4 (diag message, 16ch) = 8
    expect(u.promptTokens).toBe(8);
    expect(u.totalTokens).toBe(20);
  });

  it("omits cost when no rates are provided", () => {
    expect(accumulateUsage(EVENTS).estimatedCostUsd).toBeUndefined();
  });

  it("computes cost when rates are provided", () => {
    const u = accumulateUsage(EVENTS, {
      usdPer1kPrompt: 1, // 8/1000 * 1 = 0.008
      usdPer1kCompletion: 2, // 12/1000 * 2 = 0.024
    });
    expect(u.estimatedCostUsd).toBeCloseTo(0.032, 6);
  });

  it("treats a missing rate side as 0 but still emits a cost", () => {
    const u = accumulateUsage(EVENTS, { usdPer1kCompletion: 2 });
    expect(u.estimatedCostUsd).toBeCloseTo(0.024, 6);
  });

  it("is all-zero for an empty event array", () => {
    expect(accumulateUsage([])).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });
});

describe("checkBudget — soft token limit", () => {
  const u: UsageEstimate = { promptTokens: 8, completionTokens: 12, totalTokens: 20 };

  it("never exceeds with no limit", () => {
    expect(checkBudget(u).overSoftLimit).toBe(false);
  });

  it("never exceeds with a non-positive limit", () => {
    expect(checkBudget(u, 0).overSoftLimit).toBe(false);
    expect(checkBudget(u, -5).overSoftLimit).toBe(false);
  });

  it("is under at the threshold and over past it", () => {
    expect(checkBudget(u, 20).overSoftLimit).toBe(false);
    expect(checkBudget(u, 19).overSoftLimit).toBe(true);
  });
});

describe("formatUsage", () => {
  it("renders a compact approximate string without cost", () => {
    expect(formatUsage({ promptTokens: 8, completionTokens: 12, totalTokens: 20 })).toBe(
      "~20 tok (8 in / 12 out)",
    );
  });

  it("appends cost when present", () => {
    expect(
      formatUsage({
        promptTokens: 8,
        completionTokens: 12,
        totalTokens: 20,
        estimatedCostUsd: 0.032,
      }),
    ).toBe("~20 tok (8 in / 12 out) · ~$0.0320");
  });
});
