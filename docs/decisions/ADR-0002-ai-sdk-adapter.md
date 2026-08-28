# ADR-0002 — Vercel AI SDK behind an internal `LanguageModelClient` adapter

- **Status:** Accepted
- **Date:** 2026-06-06
- **Deciders:** Galley founding work

## Context

Galley is **model-agnostic**: the agent must run against OpenAI-compatible
endpoints, Anthropic, and local Ollama, with model choice as config not code. We
need streaming and tool-calling across all of them. The Vercel AI SDK provides
exactly this — a unified streaming + tool-calling API with provider
implementations and OpenAI-compatible/custom-`baseUrl` support — and is the
pragmatic default rather than hand-rolling transport per provider.

But "any BYO endpoint" is broader than any single SDK guarantees: endpoints
differ in streaming support, tool-call dialects, auth, strict-JSON behavior, and
browser CORS. Coupling the agent loop directly to the SDK would make providers
hard to swap and the loop hard to test.

## Decision

1. Use the **Vercel AI SDK** as the default engine for streaming + tool calling.
2. Put it **behind an internal `LanguageModelClient` interface** in
   `@galley/agent`. The loop depends only on that interface; it never imports
   `ai` directly.
3. **Instantiate providers explicitly** (OpenAI-compatible / Anthropic / Ollama
   with explicit `baseUrl`). Do **not** route bare model strings through a hosted
   gateway — that contradicts BYO / local-first.
4. Expose `probe()` → `ProviderCapabilities` so capabilities are **detected, not
   assumed**, and surfaced via a "Test connection" button.

## Consequences

- ✅ Adding a provider is config + a transport behind the adapter — no loop
  changes.
- ✅ The loop is unit-testable with a **fake `LanguageModelClient`** (no real
  provider in core tests).
- ✅ If the SDK ever becomes a constraint, it can be replaced behind the adapter
  without touching the loop.
- ⚠️ The adapter must normalize capability/tool-call differences; the abstraction
  is only as good as that normalization.
- ⚠️ Browser CORS and client-side keys remain real constraints regardless of the
  SDK (see [`providers.md`](../providers.md)).

## Alternatives considered

- **Call each provider's SDK/REST directly, no unified layer.** Rejected: more
  transport code, duplicated streaming/tool-call handling.
- **Couple the loop to the AI SDK directly (no adapter).** Rejected: providers
  not swappable, loop not testable without a real model.
