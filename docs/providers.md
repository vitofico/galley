# Providers (Bring-Your-Own-Model)

> Supported provider types, the capability model, the security/privacy posture of
> client-side keys, and CORS caveats.

## Goal

Run the agent against **any** suitable model endpoint — cloud or local — with
model choice as **config, not code**. Adding a provider should mean filling in a
`ProviderConfig`, not editing the loop.

## The abstraction

```
@galley/agent
  └─ LanguageModelClient          ◄─ the only model interface the loop knows
        └─ (default impl) wraps the Vercel AI SDK
              └─ openai-compatible | anthropic | ollama transports
```

- The **Vercel AI SDK** is the default engine (streaming + tool-calling across
  providers behind one API). It lives **behind** `LanguageModelClient` so the
  loop never imports `ai` directly — providers stay swappable and the loop stays
  testable with a fake client. (ADR:
  [`decisions/ADR-0002-ai-sdk-adapter.md`](decisions/ADR-0002-ai-sdk-adapter.md).)
- **Instantiate providers explicitly** (OpenAI-compatible / Anthropic / Ollama
  with an explicit `baseUrl`). Do **not** route a bare model string through a
  hosted gateway — that would contradict the BYO / local-first positioning.

## Provider kinds

| `kind` | Transport | Notes |
| --- | --- | --- |
| `openai-compatible` | OpenAI Chat Completions API | Covers OpenAI itself and the many compatible servers; `baseUrl` is user-set. |
| `anthropic` | Anthropic Messages API | Native tool-calling + streaming. |
| `ollama` | OpenAI-compatible transport, **local** | `isLocal: true` drives the "stays on your machine" privacy state. |

`ProviderConfig` (`@galley/shared/provider.ts`): `{ kind, label, baseUrl, model,
isLocal, transport }`. The API key is not top-level — it lives in the `direct`
branch of `transport` (see the transports section below).

## Capability gating (don't assume — probe)

BYO-model is **capability-gated, not just config-gated.** Endpoints differ in:

- streaming support,
- tool-calling support (and dialect),
- auth scheme / required headers,
- strict-JSON / schema behavior,
- CORS policy from a browser.

So before first use, **probe** the endpoint and surface the result via a **"Test
connection" button** (load-bearing for trust and debuggability):

```
probe() → ProviderCapabilities {
  reachable, supportsStreaming, supportsToolCalls, supportsImageInput, error?
}
```

The honest promise is *"any configured endpoint that supports the required
capabilities (streaming + tool calls)."* If an endpoint lacks tool-calling, the
agent loop can't run against it — say so clearly rather than failing cryptically
mid-run.

## Two transports: `direct` and `proxy`

`ProviderConfig.transport` is a discriminated union (`@galley/shared/provider.ts`):

| Mode | Path | Key location | Use for |
| --- | --- | --- | --- |
| `direct` | browser → provider | client-side (`localStorage`) | local models (Ollama), and cloud endpoints that allow browser origins and where the user accepts key exposure |
| `proxy` | browser → `@galley/proxy` → provider | **server-side** (proxy env) | cloud keys you don't want in the browser, and CORS-blocked endpoints |

The proxy is **thin, stateless, optional, and self-hostable** (ADR-0004). See
[`@galley/proxy`](../apps/proxy) and
[`architecture.md`](architecture.md#model-transport-direct-vs-proxy).

## CORS (the browser caveat)

Direct browser calls are **endpoint-dependent**: the majors mostly allow them
(often behind an explicit opt-in), but many OpenAI-compatible/self-hosted
endpoints do not.

- **Local endpoints (Ollama)** are the smoothest `direct` path and align with
  local-first; Ollama can be configured to allow the origin.
- **CORS-blocked cloud endpoints** → use `proxy` mode. The proxy sets a CORS
  allowlist (`ALLOWED_ORIGINS`) for the app origin, so the browser call succeeds.
- `probe()` must return a **clear CORS-specific error** in `direct` mode so the UI
  can suggest switching that provider to `proxy` mode.

## Local testing with Ollama (dev workflow)

When developing or exercising anything on the agent/model path, the smoothest
test target is **Ollama running locally on the dev machine** — no cloud key, no
proxy, and it doubles as the canonical `isLocal` / `direct` path. Pick any
pulled model that supports tool calls.

```bash
# Start the server (skip if already running); pull the chosen model once.
ollama serve &
ollama pull gpt-oss:120b-cloud
```

Configure a `direct` Ollama provider in the app:

| Field | Value |
| --- | --- |
| `kind` | `ollama` |
| `baseUrl` | `http://localhost:11434/v1` (OpenAI-compatible endpoint) |
| `model` | `gpt-oss:120b-cloud` (or any pulled model that supports tool calls) |
| `isLocal` | `true` |

Two caveats that bite in the browser:

- **CORS.** A `direct` call from the web origin needs Ollama to allow it — start
  it with `OLLAMA_ORIGINS=http://localhost:5173` (or `*` for throwaway local
  testing). `probe()` returns a CORS-specific error if this is missing.
- **Tool calls.** The agent loop requires tool-calling — pick a model that
  supports it, or `probe()`'s `supportsToolCalls` will come back false and the
  loop can't run.

> **Ollama transport: `direct` for a local machine, `proxy` for a server/cluster.**
> Pick the transport that matches where Ollama runs:
>
> - **`direct` (default, local-first).** Ollama on the **same machine** as the
>   browser: point at `http://localhost:11434/v1` and set `OLLAMA_ORIGINS` on the
>   Ollama server for CORS. Keyless, nothing leaves the device. This is the
>   zero-config path and stays the default when you select `ollama`.
> - **`proxy` (self-hosted / in-cluster).** Ollama on a **server or cluster**,
>   reached by a **deployed** (HTTPS) Galley. A direct browser call would fail on
>   CORS + mixed-content, so route through `@galley/proxy`: add a keyless
>   `UPSTREAM_OLLAMA_URL` upstream (e.g. the cluster-internal
>   `http://ollama.<ns>.svc.cluster.local:11434/v1`) and select it by id. The
>   proxy hop is server-to-server, so there is no CORS/mixed-content problem and
>   the cluster endpoint never needs public exposure.
>
> The settings UI offers both for `ollama` (it is **not** pinned to `direct`).
> The privacy copy is honest about the difference: a proxied self-hosted model
> stays on **infrastructure you control**, never a third-party cloud, but the
> document does leave the browser to your proxy.

## Security & privacy of keys

### `direct` mode — client-side key

The key is entered by the user and stored **client-side only** (`localStorage`).
Acceptable **only if handled honestly**:

- **Never logged.** Redact the key in every log line, telemetry event, and error
  report. The `AgentEvent` stream must never carry it.
- **Never committed.** `.gitignore` covers `.env*`; keys live in browser storage.
- **Exposed by definition.** A key in the browser is visible to anyone with
  access to that browser/profile. State this in the UI where the key is entered.
- **Scope advice.** Encourage a scoped/limited key.

### `proxy` mode — server-side key

The key lives **only** in the proxy's environment and **never reaches the
browser**. Proxy-side rules (ADR-0004, [`@galley/proxy`](../apps/proxy)):

- **Named upstreams only.** Forward to env-configured upstreams selected by id
  (`x-galley-upstream` header), never a client-supplied URL → no SSRF/open-relay.
- **Never log bodies or keys.** Request/response bodies carry document context;
  the auth header carries the key. Neither is logged or echoed back.
- **Stateless.** No DB, no disk, no sessions.
- **Stream through unbuffered**, so the agent loop's streaming is preserved.

## Privacy: local vs remote (tie back to local-first)

The app must reflect, in the UI, where document context goes when the agent runs:

- **Local model** (`isLocal: true`, `direct`) → "Your document stays on your
  machine."
- **Cloud model, `direct`** → "Your document context is sent to `<baseUrl>`."
- **Cloud model, `proxy`** → "Your document context goes to your proxy
  (`<proxyUrl>`), then to the provider." Run the proxy locally/self-hosted to keep
  the first hop yours; the provider still sees the context (inherent to any cloud
  model).

See [`vision.md#what-local-first-means-and-doesnt`](vision.md#what-local-first-means-and-doesnt).
Local-first is fully true only when the model is also local; the UI must not
imply otherwise. The proxy keeps the **key** off the browser — it does not make a
cloud model private.

## Adding a provider later

Because the loop only knows `LanguageModelClient`, a new provider is: a new
transport behind the adapter + an entry in the `ProviderKind` union + UI for its
config fields. No changes to the agent loop. That's the test of whether this
abstraction is doing its job.
