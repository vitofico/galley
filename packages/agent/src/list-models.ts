/**
 * List the models a configured provider actually offers, so the agent pane can
 * present a real picker instead of a free-text field. PURE core + a single
 * INJECTED `fetch` IO seam, mirroring literature-search.ts's posture (fixed to
 * the user's CONFIGURED endpoint, no new SSRF surface beyond what the chat client
 * already calls, fail-closed, bounded parse).
 *
 * Per provider:
 *   - ollama            → `GET {host}/api/tags`  → `{ models: [{ name }] }`
 *                         (native "ask Ollama which models are installed"; the
 *                         configured baseUrl ends in `/v1`, stripped to the host).
 *   - openai-compatible → `GET {baseUrl}/models` → `{ data: [{ id }] }`
 *   - anthropic         → `GET {baseUrl}/models` → `{ data: [{ id }] }`
 *
 * Transport: model listing is a DIRECT-mode feature. Any provider on the proxy
 * transport (including a self-hosted Ollama reached via @galley/proxy) reports
 * `unsupported` here and the UI falls back to the configured model id — the
 * picker uses each provider's native list endpoint, which the proxy's `/forward`
 * relay doesn't expose as a discoverable models GET.
 *
 * Security: the auth header (direct key) comes from `resolveTransport`; it is
 * NEVER logged or echoed — failures are typed reasons only, never the request.
 */

import type { ProviderConfig } from "@galley/shared";
import { resolveTransport } from "./provider-transport.js";

/** Bound the parse so a hostile/huge body can't blow memory or the picker list. */
const MAX_MODELS = 500;
/** Reject absurd model ids (defense-in-depth; real ids are short). */
const MAX_MODEL_ID_LEN = 200;
/** A models list is tiny; reject an oversized body up front (Content-Length). */
const MAX_RESPONSE_BYTES = 2_000_000;

export type ListModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; reason: "unsupported" | "network" | "server" | "malformed" };

/** Strip a trailing `/v1` (and any trailing slash) to reach an Ollama host root. */
function ollamaHost(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * Walk a response array ONCE, pulling each item's id via `extract`, keeping only
 * well-formed/deduped/bounded strings and STOPPING at MAX_MODELS — so a hostile
 * 10⁶-element array never gets fully materialized. First-seen order. Pure.
 */
function collectIds(arr: unknown[], extract: (item: unknown) => unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (out.length >= MAX_MODELS) break;
    const v = extract(item);
    if (typeof v !== "string") continue;
    const id = v.trim();
    if (id.length === 0 || id.length > MAX_MODEL_ID_LEN || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** An item's `.name` (Ollama) or `.id` (OpenAI/Anthropic), when it's an object. */
const pick = (field: "name" | "id") => (item: unknown): unknown =>
  typeof item === "object" && item !== null ? (item as Record<string, unknown>)[field] : undefined;

/**
 * List the configured provider's available models. Never throws; fails closed to
 * a typed reason. Uses ONLY the injected `fetch` (auditable + offline-testable).
 */
export async function listModels(
  rawConfig: ProviderConfig,
  fetchImpl: typeof fetch,
): Promise<ListModelsResult> {
  const config = rawConfig;
  // Model listing is direct-mode only; the proxy's /forward relay exposes no
  // discoverable models GET, so proxy configs fall back to the typed model id.
  if (config.transport.mode === "proxy") return { ok: false, reason: "unsupported" };

  const isOllama = config.kind === "ollama";
  // Ollama is keyless — NEVER attach auth (a stale config could carry an apiKey
  // that resolveTransport would otherwise turn into an Authorization header).
  const baseHeaders = isOllama ? {} : resolveTransport(config).headers;
  const reqHeaders: Record<string, string> = {
    ...baseHeaders,
    accept: "application/json",
    // Anthropic's browser path needs the explicit opt-in header the chat client sets.
    ...(config.kind === "anthropic" ? { "anthropic-dangerous-direct-browser-access": "true" } : {}),
  };
  const url = isOllama
    ? `${ollamaHost(config.baseUrl)}/api/tags`
    : `${config.baseUrl.replace(/\/+$/, "")}/models`;

  let res: Response;
  try {
    // `redirect: "error"` keeps a misconfigured endpoint from bouncing the auth
    // header to an unexpected host.
    res = await fetchImpl(url, { headers: reqHeaders, redirect: "error" });
  } catch {
    return { ok: false, reason: "network" };
  }
  if (!res.ok) return { ok: false, reason: "server" };

  // Reject an oversized body up front (a models list is tiny). Defense-in-depth:
  // a lying/absent Content-Length still hits the bounded single-pass collect below.
  const declared = Number(res.headers?.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    return { ok: false, reason: "malformed" };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof json !== "object" || json === null) return { ok: false, reason: "malformed" };

  if (isOllama) {
    const models = (json as { models?: unknown }).models;
    if (!Array.isArray(models)) return { ok: false, reason: "malformed" };
    return { ok: true, models: collectIds(models, pick("name")) };
  }

  // openai-compatible + anthropic both expose `{ data: [{ id }] }`.
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return { ok: false, reason: "malformed" };
  return { ok: true, models: collectIds(data, pick("id")) };
}
