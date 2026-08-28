/**
 * Sketch → Typst (CeTZ) core (roadmap #8, sketch half) — multimodal, riding E3.
 *
 * The image-input twin of `figure-to-typst.ts`: instead of a text description,
 * the user turn carries a SKETCH image part (the E3 widening of
 * `ModelMessage.content`), and the model is asked to reproduce it as a
 * compilable CeTZ snippet. Same iterate-until-clean discipline against an
 * injected compiler, same deterministic offline fallback (the `cetzScaffold`
 * reused from figure-to-typst), so the whole core is unit-testable with the
 * package's fake model + fake compiler — no provider, no network, no WASM.
 *
 * HUMAN-ACCEPT GATE invariant: this PRODUCES a draft snippet for review — it
 * never writes into any document. It returns a `FigureResult` only.
 */

import type { Diagnostic } from "@galley/shared";
import type { ContentPart, LanguageModelClient, ModelMessage } from "./model.js";
import type { AgentCompiler } from "./run-agent.js";
import { cetzScaffold } from "./figure-to-typst.js";
import type { FigureResult } from "./figure-to-typst.js";

export type { FigureResult } from "./figure-to-typst.js";

/** A hand-drawn sketch image: data-URL/URL string or raw bytes, optional mime. */
export interface SketchImage {
  data: string | Uint8Array;
  mimeType?: string;
}

export interface SketchFigureInput {
  sketch: SketchImage;
  /** Optional words to disambiguate the sketch (labels, intent). */
  description?: string;
  model: LanguageModelClient;
  compiler: AgentCompiler;
  /** Cap on self-correction rounds. Defaults to 3. */
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;

const SKETCH_SYSTEM_PROMPT = [
  "You convert a hand-drawn sketch image into a Typst figure using the CeTZ",
  "drawing package.",
  'Reply with ONLY a Typst snippet: a `#import "@preview/cetz:..."` line followed',
  "by a `#cetz.canvas({ ... })` block that reproduces the sketch as closely as",
  "you can. Do NOT include prose, explanations, or markdown code fences — output",
  "raw Typst source only. Keep it self-contained and syntactically valid.",
].join("\n");

/**
 * Convert a sketch image into a compilable CeTZ snippet, self-correcting against
 * the injected compiler. Returns a human-reviewable draft — never auto-applied.
 */
export async function figureFromSketch(
  input: SketchFigureInput,
): Promise<FigureResult> {
  const { model, compiler, sketch } = input;
  const maxAttempts = Math.max(1, input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const description = input.description ?? "";

  // The running conversation. The first user turn is MULTIMODAL: a text
  // instruction (with the optional words + a deterministic scaffold seed) plus
  // the sketch image part. Retries append text-only feedback turns, mirroring
  // figure-to-typst's threading so diagnostics are visible on the next round.
  const messages: ModelMessage[] = [
    { role: "user", content: buildInitialContent(sketch, description) },
  ];

  let bestSnippet = cetzScaffold(scaffoldSeed(description));
  let lastDiagnostics: Diagnostic[] = [];
  let attempts = 0;

  for (let round = 0; round < maxAttempts; round++) {
    const step = await model.step({
      system: SKETCH_SYSTEM_PROMPT,
      messages,
      tools: [],
    });

    messages.push({ role: "assistant", content: step.text });

    const snippet = extractSnippet(step.text) || cetzScaffold(scaffoldSeed(description));
    bestSnippet = snippet;

    const check = await compiler.check(snippet);
    attempts = round + 1;
    lastDiagnostics = check.diagnostics;

    if (check.ok) {
      return { typst: snippet, ok: true, attempts, diagnostics: [] };
    }

    if (round < maxAttempts - 1) {
      messages.push({
        role: "user",
        content: buildRetryPrompt(snippet, check.diagnostics),
      });
    }
  }

  return { typst: bestSnippet, ok: false, attempts, diagnostics: lastDiagnostics };
}

/** A non-empty seed for the scaffold comment/label when no words were given. */
function scaffoldSeed(description: string): string {
  return description.trim() || "figure from sketch";
}

/**
 * Build the multimodal first-turn content: a text instruction (optional words +
 * a deterministic scaffold the model can fill) followed by the sketch image
 * part. E3 `ContentPart[]`.
 */
export function buildInitialContent(
  sketch: SketchImage,
  description: string,
): ContentPart[] {
  const seed = scaffoldSeed(description);
  const lines = [
    "Reproduce this hand-drawn sketch as a CeTZ Typst figure.",
  ];
  if (description.trim()) {
    lines.push("", "Notes about the sketch:", description.trim());
  }
  lines.push(
    "",
    "You may start from this scaffold and replace its body:",
    "",
    cetzScaffold(seed),
  );
  const imagePart: ContentPart =
    sketch.mimeType !== undefined
      ? { type: "image", image: sketch.data, mimeType: sketch.mimeType }
      : { type: "image", image: sketch.data };
  return [{ type: "text", text: lines.join("\n") }, imagePart];
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
 * Pull a Typst snippet out of an assistant reply: strip a single markdown fence
 * if present, else trim the whole text. (Same discipline as figure-to-typst.)
 */
function extractSnippet(text: string): string {
  const fence = text.match(/```(?:typ|typst|typc)?\s*\n([\s\S]*?)```/i);
  if (fence) return fence[1]!.trim();
  return text.trim();
}
