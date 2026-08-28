/**
 * Provider transport resolution + honest privacy copy (docs/providers.md,
 * docs/architecture.md "Model transport"). Pure, framework-agnostic logic the
 * model client and the settings UI both build on.
 *
 * The MVP's two transports:
 *   - direct: browser → provider. Auth header carries the client-side key.
 *   - proxy:  browser → @galley/proxy → provider. The client sends NO key; it
 *     selects a named upstream via `x-galley-upstream` and the proxy injects the
 *     key server-side. The call target is `${proxyUrl}/forward`.
 *
 * Invariants covered here: the key never appears in proxy-mode output, and
 * `redactedConfig` strips it for logging (keys are never logged — providers.md).
 */

import type { ProviderConfig } from "@galley/shared";
import { GALLEY_UPSTREAM_HEADER } from "@galley/shared";

export interface ResolvedTransport {
  /** Effective base URL the model client should call. */
  baseUrl: string;
  /** Extra request headers (auth in direct mode; upstream selector in proxy). */
  headers: Record<string, string>;
}

/**
 * Ollama transport is a free choice, like every other provider:
 *   - DIRECT → browser → Ollama on the user's OWN machine (`localhost:11434`).
 *   - PROXY  → browser → @galley/proxy → an Ollama on a server/cluster.
 * The proxy path is what makes a self-hosted (e.g. in-cluster) Ollama reachable
 * from a deployed HTTPS Galley with no CORS / mixed-content problems — the proxy
 * forwards to a keyless `UPSTREAM_OLLAMA_URL` server-side. The config is taken
 * as-is (no transport coercion), so both topologies work from one generic UI.
 */

/** Compute the call target + headers for a provider's configured transport. */
export function resolveTransport(config: ProviderConfig): ResolvedTransport {
  if (config.transport.mode === "proxy") {
    return {
      baseUrl: `${config.transport.proxyUrl.replace(/\/+$/, "")}/forward`,
      headers: { [GALLEY_UPSTREAM_HEADER]: config.transport.upstreamId },
    };
  }
  // direct: attach the client-side key in the provider's auth scheme.
  const headers: Record<string, string> = {};
  const key = config.transport.apiKey;
  if (key) {
    if (config.kind === "anthropic") {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["authorization"] = `Bearer ${key}`;
    }
  }
  return { baseUrl: config.baseUrl, headers };
}

export type PrivacyPosture = "local" | "cloud-direct" | "cloud-via-proxy";

/** Where the document context actually goes when the agent runs. */
export function privacyPosture(config: ProviderConfig): PrivacyPosture {
  if (config.isLocal) return "local";
  return config.transport.mode === "proxy" ? "cloud-via-proxy" : "cloud-direct";
}

/** Honest, UI-ready privacy statement (local-first has edges; reflect them). */
export function privacyStatement(config: ProviderConfig): string {
  if (config.isLocal) {
    // A self-hosted model is never sent to a third-party cloud — but if it is
    // reached THROUGH a proxy (e.g. an in-cluster Ollama), the document still
    // leaves this browser to that infrastructure. Be honest about which.
    if (config.transport.mode === "proxy") {
      return `Your document context goes to your proxy (${config.transport.proxyUrl}) and on to your self-hosted model — it stays on infrastructure you control, never a third-party cloud.`;
    }
    return "Your document stays on your machine.";
  }
  if (config.transport.mode === "proxy") {
    return `Your document context goes to your proxy (${config.transport.proxyUrl}), then to the provider — run the proxy yourself to keep the first hop private. The provider still sees the context.`;
  }
  return `Your document context is sent directly to ${config.baseUrl}. Your API key is stored in this browser.`;
}

/** A copy of the config safe to log: the API key is redacted (never logged). */
export function redactedConfig(config: ProviderConfig): ProviderConfig {
  if (config.transport.mode === "direct" && config.transport.apiKey) {
    return { ...config, transport: { ...config.transport, apiKey: "[redacted]" } };
  }
  return config;
}
