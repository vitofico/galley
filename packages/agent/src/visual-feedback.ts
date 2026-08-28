/**
 * Visual layout feedback core (roadmap #10) — multimodal, riding the E3 seam.
 *
 * A PURE, offline, framework-free core scoped to ONE job: ask a vision-capable
 * model to judge the LAYOUT of a rendered page (overfull lines, spacing, float
 * placement) and parse its prose reply into a structured `LayoutFeedback`. The
 * model is an injected seam (`LanguageModelClient`), so this is unit-testable
 * with the package's fake double — no provider, no network, no DOM.
 *
 * The user turn is MULTIMODAL: we build a `ContentPart[]` of a text instruction
 * plus an `image` part carrying the rendered preview thumbnail (the E3 widening
 * of `ModelMessage.content`). We call `model.step` with no tools and parse the
 * assistant TEXT.
 *
 * HUMAN-ACCEPT GATE invariant: this PRODUCES suggestions for a human to review.
 * It NEVER auto-applies anything — it returns data and mutates no source.
 */

import type { ContentPart, LanguageModelClient, ModelMessage } from "./model.js";

/** An image to be judged: data-URL/URL string or raw bytes, optional mime type. */
export interface FeedbackImage {
  data: string | Uint8Array;
  mimeType?: string;
}

export interface VisualFeedbackInput {
  /** The Typst source that produced the rendered page (context for the model). */
  source: string;
  /** The rendered preview thumbnail to judge. */
  image: FeedbackImage;
  model: LanguageModelClient;
}

/**
 * A structured, human-reviewable layout critique. `observations` is a bullet
 * list of concrete issues; `suggestedEdits` is optional free-form guidance (NOT
 * applied automatically).
 */
export interface LayoutFeedback {
  /** A one-line gist of the critique. */
  summary: string;
  /** Concrete observations (overfull lines, spacing, float placement, …). */
  observations: string[];
  /** Optional concrete-fix guidance for the human to consider. */
  suggestedEdits?: string;
}

const VISUAL_FEEDBACK_SYSTEM_PROMPT = [
  "You are a typesetting layout reviewer for Typst documents.",
  "You are shown a rendered page image and its source. Judge the page's LAYOUT:",
  "note overfull/underfull lines, awkward spacing, widows/orphans, and float",
  "(figure/table) placement. Be specific and reference what you see.",
  "",
  "Reply in this exact shape:",
  "SUMMARY: <one line>",
  "OBSERVATIONS:",
  "- <observation>",
  "- <observation>",
  "SUGGESTED EDITS: <concrete fixes, or 'none'>",
].join("\n");

const INSTRUCTION = [
  "Judge this rendered page's layout. Note overfull lines, spacing problems, and",
  "float placement, and suggest concrete fixes. Here is the source for reference:",
].join("\n");

/**
 * Ask the model to judge a rendered page's layout and return a structured,
 * human-reviewable critique. NEVER mutates the source — returns data only.
 */
export async function judgeLayout(input: VisualFeedbackInput): Promise<LayoutFeedback> {
  const { model, image, source } = input;

  const userMessage: ModelMessage = {
    role: "user",
    content: buildMultimodalContent(source, image),
  };

  const step = await model.step({
    system: VISUAL_FEEDBACK_SYSTEM_PROMPT,
    messages: [userMessage],
    tools: [],
  });

  return parseLayoutFeedback(step.text);
}

/**
 * Build the multimodal user content: a text instruction (with the source inline)
 * followed by the rendered-page image part. This is the E3 `ContentPart[]` shape.
 */
export function buildMultimodalContent(
  source: string,
  image: FeedbackImage,
): ContentPart[] {
  const imagePart: ContentPart =
    image.mimeType !== undefined
      ? { type: "image", image: image.data, mimeType: image.mimeType }
      : { type: "image", image: image.data };
  return [{ type: "text", text: `${INSTRUCTION}\n\n${source}` }, imagePart];
}

/**
 * Parse the assistant's prose into a `LayoutFeedback`. Tolerant by design: if
 * the model ignores the template we degrade gracefully — the whole reply becomes
 * the summary and every non-empty line an observation.
 */
export function parseLayoutFeedback(text: string): LayoutFeedback {
  const trimmed = text.trim();
  if (!trimmed) {
    return { summary: "No feedback produced.", observations: [] };
  }

  const summaryMatch = trimmed.match(/^\s*summary\s*:\s*(.+)$/im);
  const suggestedMatch = trimmed.match(/^\s*suggested\s+edits\s*:\s*([\s\S]*?)$/im);

  const observations = extractObservations(trimmed);

  // Structured reply: honor the template.
  if (summaryMatch) {
    const summary = summaryMatch[1]!.trim();
    const suggestedEdits = cleanSuggested(suggestedMatch?.[1]);
    return suggestedEdits !== undefined
      ? { summary, observations, suggestedEdits }
      : { summary, observations };
  }

  // Unstructured fallback: first line is the gist, bullets/lines are observations.
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const summary = lines[0] ?? trimmed;
  const obs = observations.length > 0 ? observations : lines.slice(1);
  return { summary, observations: obs };
}

/** Pull "- " / "* " bullet lines out of the reply. */
function extractObservations(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*[-*]\s+(.+)$/);
    if (m) out.push(m[1]!.trim());
  }
  return out;
}

/** Normalize the SUGGESTED EDITS body; treat "none"/empty as absent. */
function cleanSuggested(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  const cleaned = body.trim();
  if (!cleaned || /^none\.?$/i.test(cleaned)) return undefined;
  return cleaned;
}
