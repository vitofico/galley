/**
 * Figure/sketch → Typst (CeTZ) core (roadmap #8).
 *
 * A PURE, offline, framework-free counterpart to the main agent loop, scoped to
 * ONE job: turn a natural-language figure description into a compilable CeTZ
 * Typst snippet, with the same iterate-until-clean discipline. The model and
 * compiler are injected seams (`LanguageModelClient` + `AgentCompiler`), so the
 * whole thing is unit-testable with the package's fake doubles — no provider, no
 * network, no WASM, no DOM.
 *
 * Honest scope (Architect ruling): `LanguageModelClient` message content is a
 * plain STRING today, so this is the TEXT path — "describe a figure in words →
 * generated CeTZ source". We never assume image/multimodal input. The model
 * replies with a snippet as its assistant TEXT (we do not use the edit tools
 * here); we strip any markdown fence, compile-check it, and on diagnostics feed
 * them back and retry, bounded by `maxAttempts`.
 */

import type { Diagnostic } from "@galley/shared";
import type { LanguageModelClient, ModelMessage } from "./model.js";
import type { AgentCompiler } from "./run-agent.js";

export interface FigureRequest {
  description: string;
  /** Optional hint that shapes the prompt + scaffold. Defaults to "generic". */
  kind?: "diagram" | "plot" | "generic";
}

export interface FigureResult {
  /** The best CeTZ snippet produced (clean if `ok`, else the last attempt). */
  typst: string;
  /** True iff the returned snippet compiled with no errors. */
  ok: boolean;
  /** How many model→compile rounds ran (1-based; ≥1 whenever a round ran). */
  attempts: number;
  /** Diagnostics from the FINAL compile (empty when `ok`). */
  diagnostics: Diagnostic[];
}

export interface FigureDeps {
  model: LanguageModelClient;
  compiler: AgentCompiler;
  /** Cap on self-correction rounds. Defaults to 3. */
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * The figure system prompt: instruct the model to emit ONLY a CeTZ Typst
 * snippet — no prose, no markdown fence — so the output is paste-ready source.
 */
const FIGURE_SYSTEM_PROMPT = [
  "You generate Typst figures using the CeTZ drawing package.",
  'Reply with ONLY a Typst snippet: a `#import "@preview/cetz:..."` line followed',
  "by a `#cetz.canvas({ ... })` block that draws the requested figure.",
  "Do NOT include prose, explanations, or markdown code fences — output raw Typst",
  "source only. Keep it self-contained and syntactically valid.",
].join("\n");

/**
 * A minimal, valid-shaped CeTZ snippet for `description`. Used both as the
 * deterministic seed offered to the model and as the offline fallback when the
 * model returns nothing usable. The description is embedded as a comment so the
 * snippet is a faithful (if plain) placeholder for the request.
 */
export function cetzScaffold(description: string): string {
  const safe = sanitizeComment(description);
  return [
    '#import "@preview/cetz:0.2.2"',
    "// figure: " + safe,
    "#cetz.canvas({",
    "  import cetz.draw: *",
    "  rect((0, 0), (4, 2))",
    '  content((2, 1), [' + cetzLabel(description) + "])",
    "})",
    "",
  ].join("\n");
}

export async function figureToTypst(
  req: FigureRequest,
  deps: FigureDeps,
): Promise<FigureResult> {
  const { model, compiler } = deps;
  const maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const kind = req.kind ?? "generic";

  // The running conversation. We seed it with the description + a deterministic
  // scaffold the model can fill, mirroring runAgent's message-threading so the
  // diagnostics we append on a failed round are visible on the next turn.
  const messages: ModelMessage[] = [
    { role: "user", content: buildInitialPrompt(req.description, kind) },
  ];

  let bestSnippet = cetzScaffold(req.description);
  let lastDiagnostics: Diagnostic[] = [];
  let attempts = 0;

  for (let round = 0; round < maxAttempts; round++) {
    const step = await model.step({
      system: FIGURE_SYSTEM_PROMPT,
      messages,
      tools: [],
    });

    // Record the assistant's reply in the conversation so retries see it.
    messages.push({ role: "assistant", content: step.text });

    // Extract the snippet; fall back to the deterministic scaffold if the model
    // produced nothing usable (keeps the loop offline-deterministic).
    const snippet = extractSnippet(step.text) || cetzScaffold(req.description);
    bestSnippet = snippet;

    const check = await compiler.check(snippet);
    attempts = round + 1;
    lastDiagnostics = check.diagnostics;

    if (check.ok) {
      return { typst: snippet, ok: true, attempts, diagnostics: [] };
    }

    // Not clean — feed the diagnostics (and the offending snippet) back so the
    // next turn can self-correct. Skip on the last round (no retry follows).
    if (round < maxAttempts - 1) {
      messages.push({
        role: "user",
        content: buildRetryPrompt(snippet, check.diagnostics),
      });
    }
  }

  return {
    typst: bestSnippet,
    ok: false,
    attempts,
    diagnostics: lastDiagnostics,
  };
}

function buildInitialPrompt(description: string, kind: FigureRequest["kind"]): string {
  return [
    `Create a CeTZ Typst figure for this ${kind} description:`,
    "",
    description,
    "",
    "You may start from this scaffold and replace its body:",
    "",
    cetzScaffold(description),
  ].join("\n");
}

function buildRetryPrompt(snippet: string, diagnostics: Diagnostic[]): string {
  return [
    "The snippet you produced did not compile cleanly. Fix it.",
    "",
    "Previous snippet:",
    snippet,
    "",
    "Compiler diagnostics:",
    formatDiagnostics(diagnostics),
    "",
    "Reply with ONLY the corrected CeTZ Typst snippet.",
  ].join("\n");
}

/** One diagnostic per line: "error: <message> (line:col)" when a span is present. */
function formatDiagnostics(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) return "(no diagnostics)";
  return diagnostics
    .map((d) => {
      const where = d.span ? ` (line ${d.span.start.line}, col ${d.span.start.column})` : "";
      return `${d.severity}: ${d.message}${where}`;
    })
    .join("\n");
}

/**
 * Pull a Typst snippet out of an assistant reply. The model is told to emit raw
 * source, but real models often wrap output in a ```` ```typst ```` fence — so
 * strip a single fenced block if present, else trim the whole text.
 */
function extractSnippet(text: string): string {
  const fence = text.match(/```(?:typ|typst|typc)?\s*\n([\s\S]*?)```/i);
  if (fence) return fence[1]!.trim();
  return text.trim();
}

/** Collapse a description to a single safe comment line. */
function sanitizeComment(description: string): string {
  return description.replace(/\r?\n/g, " ").trim() || "untitled";
}

/** A short, bracket-safe label for `content(...)`. */
function cetzLabel(description: string): string {
  const oneLine = description.replace(/\r?\n/g, " ").trim();
  const safe = oneLine.replace(/[[\]\\]/g, "");
  return safe.length > 40 ? safe.slice(0, 40) + "…" : safe || "figure";
}
