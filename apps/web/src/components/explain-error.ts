/**
 * Explain-this-error payload builder + advice-only guard (roadmap #18.4).
 *
 * A located diagnostic offers a second one-click action beside the #11.4b
 * quick-fix lightbulb: ask the agent to EXPLAIN the Typst error in plain
 * language — a learning aid for users new to Typst. It rides the same scoped-
 * request substrate as the quick-fix, but the output is ADVICE, not a diff:
 * an explain run never modifies the document, so there is no Accept gate.
 *
 * Two layers enforce "advice only":
 *   - `explainForDiagnostic` builds a request that explicitly forbids edits
 *     (the soft guard — a well-behaved model just answers in text).
 *   - `adviceOnlyModel` wraps the `LanguageModelClient` and STRIPS every
 *     `propose_edit` tool call from the model's steps (the hard guard — even a
 *     misbehaving model can never reach the agent loop's edit path, so the
 *     scratch stays byte-for-byte the base source and no diff can exist).
 *
 * Pure: no DOM, no network, no React, no extra deps. The snippet/location work
 * is reused from the #11.4b quick-fix builder (its `contextSnippet` is public
 * API), so both diagnostic actions quote the exact same code.
 */

import type { Diagnostic } from "@galley/shared";
import type {
  LanguageModelClient,
  ModelStep,
  ModelTextDelta,
  ModelTurnInput,
} from "@galley/agent";
import { quickFixForDiagnostic } from "./quick-fix.js";

/**
 * A scoped, advice-only agent request derived from a single diagnostic.
 *
 *  - `request`         — the natural-language instruction for the agent run.
 *  - `diagnostic`      — the original diagnostic this explains (unchanged).
 *  - `contextSnippet`  — the source lines covered by the span ± context, as
 *                        plain text (same slice the quick-fix quotes).
 */
export interface ExplainRequest {
  request: string;
  diagnostic: Diagnostic;
  contextSnippet: string;
}

/**
 * Whether an explain action can be offered for this diagnostic.
 *
 * PURE. Same gate as the quick-fix: true only when the diagnostic carries a
 * usable `span` — without a location there is no code to explain against.
 */
export function explainAvailable(diagnostic: Diagnostic): boolean {
  return diagnostic.span !== undefined;
}

/**
 * Build a scoped, advice-only agent request explaining exactly `diagnostic`.
 *
 * The returned `request` quotes the compiler message, the 1-based line/column
 * of the span's start, any compiler hints, and the spanned snippet (± context
 * lines, default 2 — same slice as the quick-fix). It asks for a plain-language
 * explanation aimed at someone new to Typst and explicitly forbids editing the
 * document or calling `propose_edit` (the soft half of the no-edit guard;
 * `adviceOnlyModel` is the hard half).
 *
 * Total: a span-less diagnostic yields a location-free request and an empty
 * snippet rather than throwing (mirrors `quickFixForDiagnostic`).
 */
export function explainForDiagnostic(
  diagnostic: Diagnostic,
  source: string,
  opts?: { contextLines?: number },
): ExplainRequest {
  // Reuse the quick-fix's public snippet extraction so both actions quote the
  // exact same code for the same diagnostic.
  const { contextSnippet } = quickFixForDiagnostic(diagnostic, source, opts);
  const span = diagnostic.span;

  const location = span
    ? `line ${span.start.line}, column ${span.start.column}`
    : "the reported location";

  const hints =
    diagnostic.hints && diagnostic.hints.length > 0 ? diagnostic.hints : undefined;

  const parts: string[] = [];
  parts.push(
    `Explain the Typst ${diagnostic.severity} "${diagnostic.message}" at ${location} ` +
      `in plain language, for someone new to Typst: what it means, why it happens, ` +
      `and how such errors are typically resolved.`,
  );
  if (contextSnippet) {
    parts.push(`The code it points at is:\n${contextSnippet}`);
  }
  if (hints) {
    const rendered = hints.map((h) => `- ${h}`).join("\n");
    parts.push(`Compiler hint(s):\n${rendered}`);
  }
  parts.push(
    "This is an explanation request only. Do NOT edit the document and " +
      "do NOT call propose_edit — answer in plain text.",
  );

  return {
    request: parts.join("\n\n"),
    diagnostic,
    contextSnippet,
  };
}

/** Drop every `propose_edit` call from a step; reading/compiling stays allowed. */
function stripEdits(step: ModelStep): ModelStep {
  const toolCalls = step.toolCalls.filter((call) => call.name !== "propose_edit");
  return toolCalls.length === step.toolCalls.length ? step : { ...step, toolCalls };
}

/**
 * The HARD no-edit guard: wrap a model so `propose_edit` can never reach the
 * agent loop. Every step (whole-turn and streaming) has its `propose_edit`
 * calls stripped before the loop sees them; `read_document` and `compile` pass
 * through, so the model can still look at the code it is explaining. With no
 * edit calls the loop never touches the scratch — the run's `finalSource` stays
 * the base source and the run classifies as `no_edits`.
 *
 * `config`/`probe` pass through unchanged, and `stepStream` is only exposed
 * when the inner model implements it (the loop's fallback contract).
 */
export function adviceOnlyModel(model: LanguageModelClient): LanguageModelClient {
  const inner = model;
  const guarded: LanguageModelClient = {
    config: inner.config,
    probe: () => inner.probe(),
    async step(input: ModelTurnInput): Promise<ModelStep> {
      return stripEdits(await inner.step(input));
    },
  };
  if (inner.stepStream) {
    guarded.stepStream = async function* (
      input: ModelTurnInput,
    ): AsyncGenerator<ModelTextDelta, ModelStep, void> {
      const stream = inner.stepStream!(input);
      let next = await stream.next();
      while (!next.done) {
        yield next.value;
        next = await stream.next();
      }
      return stripEdits(next.value);
    };
  }
  return guarded;
}
