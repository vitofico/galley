/**
 * The default `LanguageModelClient`, backed by the Vercel AI SDK (ADR-0002).
 * This is the ADAPTER: the AI SDK is imported HERE and nowhere else in the agent
 * package, so the loop stays SDK-agnostic and testable with fakes.
 *
 * One `step()` = one `generateText` turn with the agent tools declared but NOT
 * executed by the SDK (no `execute`), so the SDK returns the model's text + tool
 * calls and our loop runs the tools. Providers are instantiated explicitly from
 * the `ProviderConfig` + resolved transport (direct vs proxy) — no hosted
 * gateway (docs/providers.md).
 */

import { generateText, jsonSchema, streamText, tool } from "ai";
import type { ModelMessage as AiSdkMessage, Tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { AgentToolName, ProviderCapabilities, ProviderConfig } from "@galley/shared";
import type {
  ContentPart,
  LanguageModelClient,
  ModelMessage,
  ModelStep,
  ModelTextDelta,
  ModelTurnInput,
  ToolSpec,
} from "./model.js";
import { messageText } from "./model.js";
import { AGENT_TOOLS } from "./tools.js";
import { resolveTransport } from "./provider-transport.js";

/** A handle to an instantiated AI SDK language model (kept opaque). */
type LanguageModelV2 = Parameters<typeof generateText>[0]["model"];

/**
 * Map a multimodal `ContentPart[]` to the AI SDK's user content-part array
 * (`Array<TextPart | ImagePart>`, AI SDK v6). Text parts pass through; image
 * parts carry the data/URL plus the optional media type. A plain `string` never
 * reaches here — it stays a bare string so its emitted message is unchanged.
 */
function toAiUserContent(parts: ContentPart[]): unknown[] {
  return parts.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    return {
      type: "image",
      image: part.image,
      ...(part.mimeType ? { mediaType: part.mimeType } : {}),
    };
  });
}

/** Map our conversation to the AI SDK's ModelMessage[] (shapes verified by spike). */
function toAiMessages(messages: ModelMessage[]): AiSdkMessage[] {
  return messages.map((m): AiSdkMessage => {
    if (m.role === "user") {
      // String stays a bare string (byte-for-byte as before); parts map to the
      // AI SDK's multimodal content-part array.
      if (typeof m.content === "string") return { role: "user", content: m.content };
      return { role: "user", content: toAiUserContent(m.content) as never };
    }
    // Assistant text and tool-result values are plain text on the wire; derive a
    // string view (verbatim for the string case, so the emitted message is
    // unchanged) for the few callers that pass parts.
    const text = messageText(m.content);
    if (m.role === "assistant") {
      if (m.toolCalls && m.toolCalls.length > 0) {
        const parts: unknown[] = [];
        if (text) parts.push({ type: "text", text });
        for (const tc of m.toolCalls) {
          parts.push({ type: "tool-call", toolCallId: tc.id, toolName: tc.name, input: tc.args });
        }
        return { role: "assistant", content: parts as never };
      }
      return { role: "assistant", content: text };
    }
    // tool result
    return {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: m.toolCallId ?? "",
          toolName: m.toolName ?? "",
          output: { type: "text", value: text },
        },
      ] as never,
    };
  });
}

function toAiTools(specs: ToolSpec[]): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const spec of specs) {
    out[spec.name] = tool({ description: spec.description, inputSchema: jsonSchema(spec.parameters) });
  }
  return out;
}

class AiSdkClient implements LanguageModelClient {
  constructor(
    readonly config: ProviderConfig,
    private readonly model: LanguageModelV2,
  ) {}

  async step(input: ModelTurnInput): Promise<ModelStep> {
    const result = await generateText({
      model: this.model,
      system: input.system,
      messages: toAiMessages(input.messages),
      tools: toAiTools(input.tools),
      ...(input.signal ? { abortSignal: input.signal } : {}),
    });
    return {
      text: result.text ?? "",
      toolCalls: result.toolCalls.map((tc) => ({
        id: tc.toolCallId,
        name: tc.toolName as AgentToolName,
        args: tc.input,
      })),
    };
  }

  /**
   * Streaming turn (the AI SDK's `streamText`). We forward the text deltas as
   * they arrive, then await the settled `text`/`toolCalls` promises and return
   * the same `ModelStep` shape `step` would have produced — so the loop's tool
   * orchestration and outcome classification are byte-for-byte identical whether
   * a turn streamed or not.
   */
  async *stepStream(input: ModelTurnInput): AsyncGenerator<ModelTextDelta, ModelStep, void> {
    const result = streamText({
      model: this.model,
      system: input.system,
      messages: toAiMessages(input.messages),
      tools: toAiTools(input.tools),
      ...(input.signal ? { abortSignal: input.signal } : {}),
    });
    for await (const delta of result.textStream) {
      if (delta) yield { type: "text-delta", text: delta };
    }
    const [text, toolCalls] = await Promise.all([result.text, result.toolCalls]);
    return {
      text: text ?? "",
      toolCalls: (toolCalls ?? []).map((tc) => ({
        id: tc.toolCallId,
        name: tc.toolName as AgentToolName,
        args: tc.input,
      })),
    };
  }

  async probe(): Promise<ProviderCapabilities> {
    try {
      await generateText({
        model: this.model,
        messages: [{ role: "user", content: "ping" }],
        tools: toAiTools(AGENT_TOOLS),
        maxOutputTokens: 16,
        maxRetries: 0, // a connection test should fail fast, not retry with backoff
      });
      // Reached the endpoint and it accepted a tool-enabled request. The real
      // AI-SDK transports (openai-compatible / anthropic / ollama) all accept
      // the multimodal content-part array E3 added, so the CLIENT can send
      // images; whether the chosen model uses them is the user's responsibility.
      return {
        reachable: true,
        supportsStreaming: true,
        supportsToolCalls: true,
        supportsImageInput: true,
      };
    } catch (err) {
      return classifyProbeError(err);
    }
  }
}

/** Turn a probe failure into actionable capabilities (CORS, auth, etc.). */
export function classifyProbeError(err: unknown): ProviderCapabilities {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  let hint = message;
  if (lower.includes("cors") || lower.includes("failed to fetch")) {
    hint = "Network/CORS error — the endpoint may not allow browser calls. Try proxy mode.";
  } else if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("api key")) {
    hint = "Unauthorized — check the API key.";
  } else if (lower.includes("404") || lower.includes("not found")) {
    hint = "Not found — check the base URL and model id.";
  }
  // A failed probe claims no capability — including image input.
  return {
    reachable: false,
    supportsStreaming: false,
    supportsToolCalls: false,
    supportsImageInput: false,
    error: hint,
  };
}

/**
 * Build a `LanguageModelClient` from a `ProviderConfig`. Adding a provider is a
 * new branch here + a `ProviderKind` entry + UI — the loop never changes.
 */
export function createModelClient(config: ProviderConfig): LanguageModelClient {
  const { baseUrl, headers } = resolveTransport(config);

  if (config.kind === "anthropic") {
    const directKey = config.transport.mode === "direct" ? config.transport.apiKey : undefined;
    const anthropic = createAnthropic({
      baseURL: baseUrl,
      // proxy injects the key server-side; the placeholder is stripped by the proxy.
      apiKey: directKey ?? "proxy-injected",
      headers:
        config.transport.mode === "proxy"
          ? headers
          : { "anthropic-dangerous-direct-browser-access": "true" },
    });
    return new AiSdkClient(config, anthropic(config.model));
  }

  // openai-compatible covers OpenAI itself, Ollama, and compatible servers.
  const provider = createOpenAICompatible({
    name: config.label || "galley",
    baseURL: baseUrl,
    headers,
  });
  return new AiSdkClient(config, provider(config.model));
}
