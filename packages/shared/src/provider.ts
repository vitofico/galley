/**
 * Provider configuration & capability model.
 *
 * "Bring-your-own-model" is capability-gated, not just config-gated (GPT's
 * finding). Two endpoints with the same shape can differ in whether they
 * support streaming, tool calling, or a given auth scheme. The app must probe
 * capabilities, not assume them. See docs/providers.md.
 */

export type ProviderKind =
  | "openai-compatible" // any endpoint speaking the OpenAI Chat Completions API
  | "anthropic"
  | "ollama"; // local; treated as openai-compatible transport but flagged local

/**
 * How the client reaches the provider. A provider is EITHER called directly
 * from the browser, OR routed through the optional @galley/proxy (which holds
 * the key server-side and solves CORS). See docs/providers.md and ADR-0004.
 */
export type ProviderTransport =
  | {
      mode: "direct";
      /**
       * API key, when the endpoint needs one. Stored CLIENT-SIDE ONLY
       * (localStorage) and exposed by definition. Never logged, never committed,
       * redacted in all telemetry, never placed on the AgentEvent stream.
       */
      apiKey?: string;
    }
  | {
      mode: "proxy";
      /** URL of the @galley/proxy instance (often localhost / self-hosted). */
      proxyUrl: string;
      /**
       * Which env-configured upstream the proxy should forward to (an id like
       * "openai", never a URL). The key lives in the proxy, never the client.
       */
      upstreamId: string;
    };

export interface ProviderConfig {
  kind: ProviderKind;
  /** Display label, user-chosen. */
  label: string;
  /**
   * The semantic upstream endpoint, e.g. "https://api.openai.com/v1". Used as
   * the call target in `direct` mode and for display; in `proxy` mode the proxy
   * owns the real URL and this is informational.
   */
  baseUrl: string;
  /** Model identifier as the endpoint expects it, e.g. "gpt-4o". */
  model: string;
  /** Whether the model runs locally (Ollama, llama.cpp). Drives privacy UI. */
  isLocal: boolean;
  /** Direct browser call vs. routed through @galley/proxy. */
  transport: ProviderTransport;
}

/**
 * Result of probing a configured provider before first use. Surfaced to the
 * user via a "Test connection" button (load-bearing for good UX per GPT).
 */
export interface ProviderCapabilities {
  reachable: boolean;
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
  /**
   * Whether the transport can carry image content parts (E3's `ContentPart`
   * image) on the wire. This is a CLIENT/transport capability, not a model
   * one: model-level vision is still the user's model choice. The UI uses it
   * to honestly gate multimodal affordances.
   */
  supportsImageInput: boolean;
  /** Populated when a probe fails, e.g. CORS, 401, network, model-not-found. */
  error?: string;
}
