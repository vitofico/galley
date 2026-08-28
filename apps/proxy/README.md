# @galley/proxy

A **thin, stateless, optional** forward-proxy for cloud model APIs. The one
server piece in the MVP (ADR-0004).

**Status:** implemented (**M1**). Entry: `src/server.ts`.

## Why it exists

So you can use a **cloud** model without putting your API key in the browser, and
without fighting per-endpoint CORS. It does exactly one thing: inject the key
server-side and relay the request, streaming the response back verbatim.

You **don't need it** for local models (Ollama) or CORS-friendly direct calls —
those use `{ mode: "direct" }` (proxied providers use `{ mode: "proxy", proxyUrl,
upstreamId }`). A provider is one or the other; see
[`@galley/shared/provider.ts`](../../packages/shared/src/provider.ts).

```
direct:  browser ───────────────────► provider          (key client-side)
proxy:   browser ──► @galley/proxy ──► provider          (key server-side)
```

## Non-negotiables

- **Named upstreams only.** Forwards to env-configured upstreams selected by id
  via the `x-galley-upstream` header — never a client-supplied URL. No SSRF.
- **Never log bodies or keys.** Bodies carry document context; the auth header
  carries the key.
- **Stream through unbuffered.** The agent loop streams; don't break it.
- **Stateless.** No DB, no disk, no sessions.
- **Self-hostable / localhost by default.** Not a central service. Run it where
  you trust it; in dev it's `http://localhost:8787`.

## Configure & run (M1)

```bash
cp .env.example .env      # set ALLOWED_ORIGINS + UPSTREAM_* ids/urls/keys
pnpm --filter @galley/proxy dev
```

See [`.env.example`](.env.example) for the upstream config pattern and
[`docs/providers.md`](../../docs/providers.md) for the full contract.

## Implementation note

Recommended runtime: **Hono** (TS-native; Node / serverless / edge). The streaming
pass-through is `return fetch(upstreamUrl, { ...injectedAuth, body, duplex: 'half' })`
— return the upstream `Response` directly so the stream is not buffered.
