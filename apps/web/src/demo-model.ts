/**
 * A zero-config, offline "Demo" model (implements `LanguageModelClient`). It
 * lets you try the full agent loop — and drives the deterministic offline e2e —
 * without configuring a provider.
 *
 * It scripts the thesis on ANY document: read the document, append a section but
 * introduce a deliberate compile error, see the diagnostic, then self-correct to
 * a clean compile. State is derived from the conversation (not stored), so it is
 * correct across the loop's repeated `step` calls.
 */
import type {
  LanguageModelClient,
  ModelStep,
  ModelTextDelta,
  ModelTurnInput,
} from "@galley/agent";
import type { ProviderCapabilities, ProviderConfig } from "@galley/shared";

export const DEMO_CONFIG: ProviderConfig = {
  kind: "openai-compatible",
  label: "Demo (offline)",
  baseUrl: "demo://local",
  model: "galley-demo",
  isLocal: true,
  transport: { mode: "direct" },
};

const BROKEN_SUFFIX = "\n\n= Demo Section\n#let unfinished =";
const FIXED_TEXT = "Inserted by the Galley demo agent.";

let seq = 0;
const id = () => `demo-${++seq}`;

/** Strip `read_document` line-number prefixes back to raw source. */
function stripLineNumbers(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\|\s?/, ""))
    .join("\n");
}

/**
 * The deterministic per-turn decision. Both `step` (whole turn) and `stepStream`
 * (token-level) derive their `ModelStep` from this single function, so streaming
 * changes ONLY the granularity of the assistant text — the scripted tool calls
 * (read → broken edit → fix → done) are byte-for-byte identical, keeping the
 * offline e2e green.
 */
function decideStep(input: ModelTurnInput): ModelStep {
  const toolMessages = input.messages.filter((m) => m.role === "tool");
  const lastRead = [...toolMessages].reverse().find((m) => m.toolName === "read_document");
  const proposals = input.messages.filter(
    (m) => m.role === "assistant" && m.toolCalls?.some((t) => t.name === "propose_edit"),
  ).length;

  // 1) First, read the document.
  if (!lastRead) {
    return {
      text: "Let me read the document first.",
      toolCalls: [{ id: id(), name: "read_document", args: {} }],
    };
  }

  // `read_document` results are always plain text; narrow off the (now
  // multimodal-capable) content union before stripping line numbers.
  const doc = stripLineNumbers(typeof lastRead.content === "string" ? lastRead.content : "");

  // 2) Append a section, but with a deliberate compile error.
  if (proposals === 0) {
    return {
      text: "I'll add a demo section.",
      toolCalls: [
        {
          id: id(),
          name: "propose_edit",
          args: { edits: [{ search: doc, replace: doc + BROKEN_SUFFIX }] },
        },
      ],
    };
  }

  // 3) The last compile failed — fix it.
  const lastTool = toolMessages[toolMessages.length - 1];
  if (lastTool && typeof lastTool.content === "string" && /error|failed/i.test(lastTool.content)) {
    return {
      text: "That introduced a compile error; fixing it.",
      toolCalls: [
        {
          id: id(),
          name: "propose_edit",
          args: { edits: [{ search: "#let unfinished =", replace: FIXED_TEXT }] },
        },
      ],
    };
  }

  // 4) Clean — done.
  return { text: "Done — the document compiles cleanly.", toolCalls: [] };
}

/** Split assistant text into per-word chunks (keeping trailing whitespace). */
function streamChunks(text: string): string[] {
  return text ? (text.match(/\S+\s*/g) ?? [text]) : [];
}

/** A small delay so the streamed preamble is visibly incremental in the UI. */
const STREAM_DELAY_MS = 35;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createDemoModel(): LanguageModelClient {
  return {
    config: DEMO_CONFIG,
    async probe(): Promise<ProviderCapabilities> {
      // The Demo model is text-only: it scripts a fixed Typst editing loop and
      // never consumes image content parts, so it claims no image-input support.
      return {
        reachable: true,
        supportsStreaming: true,
        supportsToolCalls: true,
        supportsImageInput: false,
      };
    },
    async step(input: ModelTurnInput): Promise<ModelStep> {
      return decideStep(input);
    },
    // Token-level streaming: emit the turn's assistant text as visible word
    // chunks (with a small delay), then return the SAME ModelStep `step` would —
    // so the agent still proposes its compiling edit and the e2e stays green.
    async *stepStream(input: ModelTurnInput): AsyncGenerator<ModelTextDelta, ModelStep, void> {
      const step = decideStep(input);
      for (const chunk of streamChunks(step.text)) {
        if (input.signal?.aborted) break;
        await sleep(STREAM_DELAY_MS);
        // Re-check AFTER the delay: a Stop during the sleep must halt streaming
        // promptly (no further deltas). It may still `return step` below — the
        // run-agent abort guard is what enforces no post-abort tool side effects.
        if (input.signal?.aborted) break;
        yield { type: "text-delta", text: chunk };
      }
      return step;
    },
  };
}
