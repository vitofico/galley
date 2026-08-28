/**
 * Agent-assisted import REPAIR loop (roadmap #15).
 *
 * Onboarding produces a Typst draft via a DETERMINISTIC converter
 * (`markdownToTypst` / `latexToTypst`). Those converters are lossy: the draft
 * may not compile. This module applies the thesis loop — convert → compile →
 * read-diagnostics → self-correct — to that draft, iterating until it compiles
 * cleanly (or a `maxAttempts` cap). It is a PURE, offline counterpart to the
 * main agent loop, scoped to ONE job and unit-testable with the package's fake
 * doubles: the model and compiler are injected seams (`LanguageModelClient` +
 * `AgentCompiler`), so there is no provider, no network, no WASM, no DOM.
 *
 * Honest scope (Architect ruling): this is a DARK core. It does NOT re-run the
 * converters — the caller runs them first and passes `.typst` in. It NEVER
 * auto-applies anything: it only PRODUCES a proposed Typst string for downstream
 * human Accept review. The deterministic offline fallback is the INPUT draft
 * UNCHANGED, so with a fake model returning nothing usable the loop is fully
 * deterministic and returns the original draft (with `ok` reflecting whether
 * THAT draft compiles).
 */

import type { Diagnostic } from "@galley/shared";
import type { LanguageModelClient, ModelMessage } from "./model.js";
import type { AgentCompiler } from "./run-agent.js";

export interface ImportRepairRequest {
  /**
   * The INITIAL converted Typst draft to repair — the `.typst` output of
   * `markdownToTypst` / `latexToTypst`. This module does NOT re-run conversion.
   */
  typst: string;
  /** Which converter produced the draft. Shapes the prompt wording only. */
  sourceKind?: "markdown" | "latex";
  /**
   * Free-form context for the model, e.g. the unmapped/unconverted catalog the
   * converter reported (`MdConvertResult.unmapped` / `LatexConvertResult.unconverted`),
   * already stringified by the caller.
   */
  notes?: string;
}

export interface ImportRepairResult {
  /** The best draft produced (clean if `ok`, else the last attempt). */
  typst: string;
  /** True iff the returned draft compiled with no errors. */
  ok: boolean;
  /** How many model→compile rounds ran (1-based; ≥1 whenever a round ran). */
  attempts: number;
  /** Diagnostics from the FINAL compile (empty when `ok`). */
  diagnostics: Diagnostic[];
}

export interface ImportRepairDeps {
  model: LanguageModelClient;
  compiler: AgentCompiler;
  /** Cap on self-correction rounds. Defaults to 3. */
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * The repair system prompt: the model is REPAIRING a lossy import so it compiles
 * cleanly as Typst — preserve content/structure, fix only what the compiler
 * rejects, and emit ONLY raw Typst (no prose, no markdown fence).
 */
const REPAIR_SYSTEM_PROMPT = [
  "You repair imported Typst documents. The input is a lossy automated",
  "conversion (from Markdown or LaTeX) that may not compile cleanly as Typst.",
  "Your job: make it compile while PRESERVING the original content and structure.",
  "Change as little as possible — fix only what the compiler rejects; do not",
  "rewrite, summarize, or drop content.",
  "Reply with ONLY the corrected Typst document — no prose, no explanations, and",
  "no markdown code fences. Output raw Typst source only.",
].join("\n");

export async function repairImportedTypst(
  req: ImportRepairRequest,
  deps: ImportRepairDeps,
): Promise<ImportRepairResult> {
  const { model, compiler } = deps;
  const maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);

  // The deterministic offline fallback: the input draft, unchanged. Used both as
  // the seed offered to the model and whenever the model returns nothing usable,
  // keeping the loop fully deterministic.
  const draft = req.typst;

  // The running conversation, seeded with the draft + (optional) unconverted
  // catalog. We thread it like runAgent so diagnostics appended on a failed round
  // are visible on the next turn.
  const messages: ModelMessage[] = [
    { role: "user", content: buildInitialPrompt(req) },
  ];

  let bestDraft = draft;
  let lastDiagnostics: Diagnostic[] = [];
  let attempts = 0;

  for (let round = 0; round < maxAttempts; round++) {
    const step = await model.step({
      system: REPAIR_SYSTEM_PROMPT,
      messages,
      tools: [],
    });

    // Record the assistant reply so retries see it.
    messages.push({ role: "assistant", content: step.text });

    // Extract the repaired source; fall back to the input draft unchanged if the
    // model produced nothing usable (deterministic offline fallback).
    const candidate = extractTypst(step.text) || draft;
    bestDraft = candidate;

    const check = await compiler.check(candidate);
    attempts = round + 1;
    lastDiagnostics = check.diagnostics;

    if (check.ok) {
      return { typst: candidate, ok: true, attempts, diagnostics: [] };
    }

    // Not clean — feed the diagnostics (and the offending source) back so the
    // next turn can self-correct. Skip on the last round (no retry follows).
    if (round < maxAttempts - 1) {
      messages.push({
        role: "user",
        content: buildRetryPrompt(candidate, check.diagnostics),
      });
    }
  }

  return {
    typst: bestDraft,
    ok: false,
    attempts,
    diagnostics: lastDiagnostics,
  };
}

function buildInitialPrompt(req: ImportRepairRequest): string {
  const origin =
    req.sourceKind === "markdown"
      ? "Markdown"
      : req.sourceKind === "latex"
        ? "LaTeX"
        : "another format";
  const parts = [
    `This Typst document was auto-converted from ${origin} and may not compile.`,
    "Repair it so it compiles cleanly, preserving its content and structure.",
    "",
    "Draft Typst:",
    req.typst,
  ];
  const notes = req.notes?.trim();
  if (notes) {
    parts.push(
      "",
      "Constructs the converter could not map (handle these by hand if present):",
      notes,
    );
  }
  parts.push("", "Reply with ONLY the corrected Typst document.");
  return parts.join("\n");
}

function buildRetryPrompt(source: string, diagnostics: Diagnostic[]): string {
  return [
    "The Typst you produced did not compile cleanly. Fix it.",
    "",
    "Previous source:",
    source,
    "",
    "Compiler diagnostics:",
    formatDiagnostics(diagnostics),
    "",
    "Reply with ONLY the corrected Typst document.",
  ].join("\n");
}

/** One diagnostic per line: "error: <message> (line:col)" when a span is present. */
function formatDiagnostics(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) return "(no diagnostics)";
  return diagnostics
    .map((d) => {
      const where = d.span
        ? ` (line ${d.span.start.line}, col ${d.span.start.column})`
        : "";
      return `${d.severity}: ${d.message}${where}`;
    })
    .join("\n");
}

/**
 * Pull Typst source out of an assistant reply. The model is told to emit raw
 * source, but real models often wrap output in a ```` ```typst ```` fence — so
 * strip a single fenced block if present, else trim the whole text.
 */
function extractTypst(text: string): string {
  const fence = text.match(/```(?:typ|typst|typc)?\s*\n([\s\S]*?)```/i);
  if (fence) return fence[1]!.trim();
  return text.trim();
}
