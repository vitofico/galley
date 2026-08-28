/**
 * Figure alt-text / caption suggestion core — multimodal, riding the E3 seam.
 *
 * A PURE, offline, framework-free core scoped to ONE job: given a figure image
 * (and optional surrounding context), ask a vision-capable model for ONE concise
 * alt-text / caption line that a human then reviews and accepts. The model is an
 * injected seam (`LanguageModelClient`), so this is unit-testable with the fake.
 *
 * The user turn is MULTIMODAL: a text instruction plus an `image` part (the E3
 * widening of `ModelMessage.content`). We call `model.step` with no tools and
 * normalize the assistant TEXT into a single line.
 *
 * HUMAN-ACCEPT GATE invariant: this PRODUCES a suggestion for review — it never
 * writes the caption into any document. It returns a string only.
 */

import type { ContentPart, LanguageModelClient, ModelMessage } from "./model.js";

/** A figure image: data-URL/URL string or raw bytes, optional mime type. */
export interface AltTextImage {
  data: string | Uint8Array;
  mimeType?: string;
}

export interface AltTextInput {
  image: AltTextImage;
  /** Optional surrounding context (caption nearby, section title, …). */
  context?: string;
  model: LanguageModelClient;
}

/**
 * Hard cap on the returned suggestion length. Alt text should be concise; if the
 * model rambles we truncate on a word boundary so the human gets a usable seed
 * rather than a paragraph. (Documented behavior — see tests.)
 */
const MAX_ALT_TEXT_LENGTH = 240;

const ALT_TEXT_SYSTEM_PROMPT = [
  "You write concise, descriptive alt text for figures in a document.",
  "Given a figure image, reply with ONE short sentence (a single line) that",
  "describes the figure for a reader who cannot see it. Be specific and factual.",
  "Do NOT include prose, prefixes like 'Alt text:', markdown, or quotes — output",
  "the bare caption line only.",
].join("\n");

/**
 * Suggest a concise alt-text / caption line for a figure image. The human
 * reviews and accepts; nothing is written automatically. Returns the suggestion
 * as a single trimmed, length-capped line (empty string if the model says
 * nothing usable).
 */
export async function suggestAltText(input: AltTextInput): Promise<string> {
  const { model, image, context } = input;

  const userMessage: ModelMessage = {
    role: "user",
    content: buildAltTextContent(image, context),
  };

  const step = await model.step({
    system: ALT_TEXT_SYSTEM_PROMPT,
    messages: [userMessage],
    tools: [],
  });

  return normalizeAltText(step.text);
}

/**
 * Build the multimodal user content: a text instruction (optionally with the
 * surrounding context) followed by the figure image part. E3 `ContentPart[]`.
 */
export function buildAltTextContent(
  image: AltTextImage,
  context?: string,
): ContentPart[] {
  const instruction = context
    ? `Describe this figure for alt text. Surrounding context:\n${context}`
    : "Describe this figure for alt text.";
  const imagePart: ContentPart =
    image.mimeType !== undefined
      ? { type: "image", image: image.data, mimeType: image.mimeType }
      : { type: "image", image: image.data };
  return [{ type: "text", text: instruction }, imagePart];
}

/**
 * Collapse the assistant reply to a single concise line: take the first
 * non-empty line, strip a leading "Alt text:"/"Caption:" label and wrapping
 * quotes, and cap the length on a word boundary.
 */
export function normalizeAltText(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!firstLine) return "";

  let line = firstLine.replace(/^(alt\s*text|caption|description)\s*:\s*/i, "").trim();
  line = line.replace(/^["'“”]+|["'“”]+$/g, "").trim();

  if (line.length <= MAX_ALT_TEXT_LENGTH) return line;
  const clipped = line.slice(0, MAX_ALT_TEXT_LENGTH);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trimEnd() + "…";
}
