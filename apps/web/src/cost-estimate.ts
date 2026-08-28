/**
 * Token & cost ESTIMATION for an agent run — NOT billing-grade.
 *
 * This is a deliberately rough, provider-agnostic heuristic. Real providers
 * tokenize differently (BPE/SentencePiece variants, special tokens, system
 * prompts, tool schemas, image tokens, …) and bill on their own server-side
 * counts. We never see those numbers here; we only see the AgentEvent stream.
 * So treat every number below as an ESTIMATE for live UX feedback (a meter and
 * a soft budget warning), never as an invoice. When in doubt it under-counts:
 * it ignores the hidden system prompt, tool schemas, and conversation scaffold.
 *
 * Framework-free and pure: no React, no DOM, no I/O. Safe to unit-test directly.
 */
import type { AgentEvent } from "@galley/shared";

/**
 * Estimate the token count of a string with the common ~4-characters-per-token
 * rule of thumb (English-ish prose under BPE). Empty/whitespace → 0. We round
 * up so any non-empty text costs at least 1 token.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chars = text.length;
  if (chars === 0) return 0;
  return Math.ceil(chars / 4);
}

export interface UsageEstimate {
  /** Estimated tokens attributed to the prompt/context side (input). */
  promptTokens: number;
  /** Estimated tokens the model produced (output). */
  completionTokens: number;
  /** promptTokens + completionTokens. */
  totalTokens: number;
  /** Estimated USD cost — present ONLY when per-1k rates were supplied. */
  estimatedCostUsd?: number;
}

export interface AccumulateOpts {
  /** USD per 1k prompt (input) tokens. Omit to skip cost estimation. */
  usdPer1kPrompt?: number;
  /** USD per 1k completion (output) tokens. Omit to skip cost estimation. */
  usdPer1kCompletion?: number;
}

/**
 * Fold an AgentEvent stream into a usage estimate.
 *
 * Attribution (an ESTIMATE — see file header):
 *   - `assistant_text` chunks  → completion (output) tokens. This is the only
 *     event that carries actual model output text, so it is the most trustworthy
 *     signal here.
 *   - `tool_result.summary` and `diagnostics` text → prompt (input) tokens. The
 *     agent feeds these back into the next turn as context, so we approximate
 *     them as prompt-side load. This UNDER-counts real prompt usage (it omits
 *     the system prompt, the document body, and tool-call args) — intentionally,
 *     since those are not in the event stream.
 *
 * Cost is computed only when BOTH a prompt and/or completion rate is provided;
 * a missing rate contributes 0 for that side.
 */
export function accumulateUsage(
  events: AgentEvent[],
  opts: AccumulateOpts = {},
): UsageEstimate {
  let promptTokens = 0;
  let completionTokens = 0;

  for (const event of events) {
    switch (event.type) {
      case "assistant_text":
        completionTokens += estimateTokens(event.text);
        break;
      case "tool_result":
        promptTokens += estimateTokens(event.summary);
        break;
      case "diagnostics":
        for (const d of event.diagnostics) {
          promptTokens += estimateTokens(d.message ?? "");
        }
        break;
      default:
        break;
    }
  }

  const usage: UsageEstimate = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };

  const { usdPer1kPrompt, usdPer1kCompletion } = opts;
  if (usdPer1kPrompt !== undefined || usdPer1kCompletion !== undefined) {
    const promptCost = (promptTokens / 1000) * (usdPer1kPrompt ?? 0);
    const completionCost = (completionTokens / 1000) * (usdPer1kCompletion ?? 0);
    usage.estimatedCostUsd = promptCost + completionCost;
  }

  return usage;
}

/**
 * A compact, human-readable one-liner for a usage estimate. The leading "~"
 * signals it is approximate. Cost is appended only when present.
 */
export function formatUsage(u: UsageEstimate): string {
  let s = `~${u.totalTokens} tok (${u.promptTokens} in / ${u.completionTokens} out)`;
  if (u.estimatedCostUsd !== undefined) {
    s += ` · ~$${u.estimatedCostUsd.toFixed(4)}`;
  }
  return s;
}

export interface BudgetState {
  /** True when the total estimate exceeds the soft token limit. */
  overSoftLimit: boolean;
}

/**
 * Compare a usage estimate against an optional soft token budget. With no limit
 * (or a non-positive one) the budget is never considered exceeded.
 */
export function checkBudget(u: UsageEstimate, softLimitTokens?: number): BudgetState {
  if (softLimitTokens === undefined || softLimitTokens <= 0) {
    return { overSoftLimit: false };
  }
  return { overSoftLimit: u.totalTokens > softLimitTokens };
}
