# ADR-0004 — A thin, optional, self-hostable model-API proxy in the MVP

- **Status:** Accepted
- **Date:** 2026-06-06
- **Deciders:** Galley founding work
- **Amends:** the original brief's "no server" MVP non-goal (narrowly)

> **Amendment (2026-06-17): Ollama may use the proxy when self-hosted.** The
> original decision said local providers stay `direct`. That holds for an Ollama
> on the **user's own machine** (and remains the default). But a **server/cluster**
> Ollama reached by a **deployed (HTTPS) Galley** cannot be called directly from
> the browser (CORS + mixed-content), so it is now a supported `proxy` topology:
> add a **keyless** `UPSTREAM_OLLAMA_URL` upstream (no key to inject — Ollama is
> keyless; the proxy just relays) and select it from a `proxy`-mode Ollama
> provider. The transport is no longer coerced to `direct` for Ollama, and the
> settings UI offers both. The "named upstreams only / no client URL" SSRF
> guard is unchanged. Access control for an exposed proxy is the proxy's optional
> `PROXY_ACCESS_TOKEN` bearer gate or a fronting reverse-proxy (e.g. Authentik
> forward-auth) — not RBAC on the keyless local model.

## Context

Galley is local-first and browser-only: the document is edited and **compiled
client-side**. But the agent must call model APIs, and for **cloud** providers
that creates two problems from the browser:

- **Key exposure.** An API key in the browser is visible to anyone with access
  to that browser/profile.
- **CORS.** Direct browser calls are endpoint-dependent — the majors mostly allow
  it (often behind an opt-in), but many OpenAI-compatible/self-hosted endpoints
  do not.

Local models (Ollama) have neither problem. Pure-client-only would either expose
keys or restrict the MVP to local models. We want "bring your own cloud key and
it works" in the MVP without breaking local-first.

## Decision

Ship a **thin, stateless, optional forward-proxy** (`@galley/proxy`) in the MVP.

- **Optional.** A provider's `transport` is either `direct` (browser → provider,
  key client-side) or `proxy` (browser → `@galley/proxy` → provider, key
  server-side). Local providers stay `direct`. The type system models this as a
  discriminated union (`@galley/shared/provider.ts`).
- **Thin & stateless.** One job: inject the key and relay the request, streaming
  the response through verbatim. No DB, no disk, no sessions, no business logic.
- **Self-hostable / localhost by default.** It ships in the repo and runs on the
  user's own machine/infra. It is **not** a central Galley-operated service.
- **Named upstreams only.** It forwards to env-configured upstreams selected by
  id via the `x-galley-upstream` header — never a client-supplied URL. This
  prevents SSRF / open-relay.
- **Implementation:** Hono (TS-native; runs on Node / serverless / edge),
  finalized in M1. Lives at `apps/proxy`.

## Consequences

- ✅ "Paste your OpenAI/Anthropic key and it works" is in the MVP, without the key
  ever entering the browser.
- ✅ CORS is solved for proxied providers.
- ✅ Document edit + compile remain 100% client-side; local-first holds.
- ✅ The client ⇄ proxy boundary is a typed contract in `@galley/shared`
  (`proxy.ts`) — the "interfaces are the API" principle in practice; it's also
  the first concrete step of the roadmap's server story.
- ⚠️ **Honest privacy caveat:** when a cloud model is used via the proxy, document
  context transits the proxy host. Run it locally/self-hosted to keep that within
  your control. The cloud provider still sees the context — inherent to any cloud
  model, proxy or not. Local models keep everything on-device. The UI must state
  this (see [`providers.md`](../providers.md), [`vision.md`](../vision.md)).
- ⚠️ Adds a second deployable to the MVP. Kept minimal and optional to contain the
  cost; it is skippable entirely for local-model users.

## Alternatives considered

- **Pure client, proxy = just a `baseUrl` the user supplies themselves.** Rejected
  as the default: pushes real friction (running a relay) onto every cloud user
  and offers no key protection out of the box. The `transport` union still allows
  a user to point `proxyUrl` at any compatible relay, so this remains possible.
- **Local-models-only MVP.** Rejected: caps agent quality at what the user can run
  locally during the critical dogfooding phase.
- **Full server (auth/DB/sessions) now.** Rejected: premature; violates the
  roadmap. This proxy is deliberately *not* that.
