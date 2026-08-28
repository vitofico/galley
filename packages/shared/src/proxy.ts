/**
 * The client ⇄ proxy wire contract.
 *
 * Per the "interfaces are the API contract" principle (docs/architecture.md),
 * this is the typed boundary between @galley/web and @galley/proxy. The proxy
 * is OPTIONAL: only providers configured with `transport.mode === "proxy"` go
 * through it. See docs/providers.md and ADR-0004.
 */

/**
 * Header the client sets to select which env-configured upstream the proxy
 * should forward to. The value is an upstream *id* (e.g. "openai"), never a URL
 * — the proxy resolves the id to a real URL + key, so the client can never
 * point the proxy at an arbitrary host (no SSRF).
 */
export const GALLEY_UPSTREAM_HEADER = "x-galley-upstream" as const;

/**
 * Server-side configuration for one named upstream. Lives only in the proxy
 * (loaded from env); never sent to the client. The `key` never leaves the
 * proxy process.
 */
export interface UpstreamConfig {
  /** Stable id the client references, e.g. "openai", "anthropic". */
  id: string;
  /** Upstream base URL, e.g. "https://api.openai.com/v1". */
  url: string;
  /** Auth header name to inject, e.g. "Authorization" or "x-api-key". */
  authHeader: string;
  /** Secret value for `authHeader`. Proxy-only. Never logged, never returned. */
  key: string;
}
