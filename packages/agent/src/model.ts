/**
 * The model-conversation seam (ADR-0002, docs/providers.md, docs/agent-loop.md).
 *
 * `LanguageModelClient` is the ONLY model interface the agent loop knows. The
 * default implementation wraps the Vercel AI SDK (added in M1); tests inject a
 * fake. Keeping the loop's tool orchestration here — rather than inside the
 * client — is what lets a fully scripted `FakeModel` drive the loop offline.
 *
 * One turn = one `step()`: given the running conversation and the tool specs,
 * the model returns its assistant text plus any tool calls it wants executed.
 * The loop runs the tools (they touch the scratch + compiler) and calls `step`
 * again with the results appended, until the model stops calling tools.
 */

import type {
  AgentToolName,
  ProviderCapabilities,
  ProviderConfig,
} from "@galley/shared";

export type ModelRole = "user" | "assistant" | "tool";

/** A tool invocation the model asked for in a turn. */
export interface ModelToolCall {
  /** Provider-assigned id, echoed back on the matching tool result. */
  id: string;
  name: AgentToolName;
  /** Raw arguments object (validated by the loop, e.g. via `parseEdits`). */
  args: unknown;
}

/**
 * A typed piece of message content. The seam carries either plain text or an
 * image; this is the multimodal widening of `ModelMessage.content` (ADR-0002,
 * additive). `image` is a data-URL/URL string or raw bytes; `mimeType` is the
 * optional IANA media type (e.g. `image/png`).
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string | Uint8Array; mimeType?: string };

/**
 * Concatenate the text parts of a message's content into a plain-text view,
 * ignoring any images. A plain `string` is returned verbatim. Use this for any
 * reader that needs text from a (possibly multimodal) message — existing readers
 * stay on the `string` path and never call this.
 */
export function messageText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content.reduce((acc, part) => (part.type === "text" ? acc + part.text : acc), "");
}

/** One message in the model conversation. */
export interface ModelMessage {
  role: ModelRole;
  /**
   * The message body. `string` is the common case and stays byte-for-byte on
   * the wire; a `ContentPart[]` carries typed multimodal parts (text + images).
   */
  content: string | ContentPart[];
  /** role "assistant": tool calls made this turn. */
  toolCalls?: ModelToolCall[];
  /** role "tool": which call this is the result for. */
  toolCallId?: string;
  toolName?: AgentToolName;
}

/** A tool advertised to the model (name + description + JSON-Schema params). */
export interface ToolSpec {
  name: AgentToolName;
  description: string;
  parameters: Record<string, unknown>;
}

/** The result of one model turn. */
export interface ModelStep {
  /** Full assistant text for this turn (may be empty when only calling tools). */
  text: string;
  /** Tool calls to execute; an empty array means this is the final turn. */
  toolCalls: ModelToolCall[];
}

/**
 * An incremental text delta yielded while a turn is streaming. Each delta is the
 * NEXT chunk of assistant text (not cumulative); the loop concatenates them. Tool
 * calls are NOT streamed — they arrive whole in the final `ModelStep`.
 */
export interface ModelTextDelta {
  type: "text-delta";
  /** The next chunk of assistant text for the current turn. */
  text: string;
}

export interface ModelTurnInput {
  system: string;
  messages: ModelMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

/**
 * The model abstraction the agent loop depends on. The loop never imports the
 * AI SDK directly — providers stay swappable and the loop stays testable with a
 * fake (manifest invariant; docs/providers.md).
 */
export interface LanguageModelClient {
  readonly config: ProviderConfig;
  /** Probe the endpoint before first use (the "Test connection" button). */
  probe(): Promise<ProviderCapabilities>;
  /** Execute one model turn over the conversation + tools. */
  step(input: ModelTurnInput): Promise<ModelStep>;
  /**
   * OPTIONAL streaming turn. When implemented, the loop drives this instead of
   * `step`: it yields incremental `text-delta`s as the assistant text arrives,
   * then RETURNS the final `ModelStep` (full text + tool calls) — identical to
   * what `step` would have returned. A client that omits `stepStream` is fully
   * supported: the loop falls back to `step` and emits the text as one chunk.
   * Additive by design (ADR-0002): every existing non-streaming implementer
   * still satisfies this interface unchanged.
   */
  stepStream?(input: ModelTurnInput): AsyncGenerator<ModelTextDelta, ModelStep, void>;
}
