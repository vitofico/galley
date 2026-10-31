# @galley/proxy

A **thin, stateless, optional** forward-proxy for model APIs
([ADR-0004](../../docs/decisions/ADR-0004-model-proxy.md)). The implemented runtime
is Hono on Node; `src/server.ts` starts the service and `src/index.ts` exports the
testable handler.

## Why it exists

Keep an upstream model key server-side and avoid per-endpoint browser CORS
restrictions. The proxy selects a configured upstream, injects its authentication
header and relays the response stream. Document context still transits the proxy
and the selected model endpoint; this does not make a cloud model local.

Local Ollama or a CORS-friendly endpoint can use direct transport. A model on a
private server or cluster may instead need a proxy so the browser can reach it
without mixed-content or CORS failures. Provider transport is configured as
`{ mode: "direct" }` or `{ mode: "proxy", proxyUrl, upstreamId }`; see
[`provider.ts`](../../packages/shared/src/provider.ts).

```
direct:  browser ───────────────────► provider          (key client-side)
proxy:   browser ──► @galley/proxy ──► provider          (key server-side)
```

## Service contract

- **Named upstreams only.** `x-galley-upstream` selects an environment-configured
  upstream, never a client-supplied URL.
- **Streaming.** `POST`/`GET /forward/*` preserve the API path and query after
  `/forward`; response bodies pass through without buffering.
- **Key handling.** Client authentication is stripped before the configured
  upstream header is injected. Request bodies and keys are never logged.
- **Bounds.** Requests have a 16 MiB default body cap, streaming size checks and
  inbound request timeouts. Allowed browser origins are configured explicitly.
- **Optional bearer gate.** With `PROXY_ACCESS_TOKEN` set, `/forward/*` requires
  the matching `Authorization: Bearer …` before upstream authentication is
  injected. This is defense in depth alongside edge authentication, not account
  management. The Kubernetes auth overlay configures web/sync, not this gate.
- **Stateless.** No document storage, sessions or database. `GET /healthz`
  provides liveness. Local development uses port 8787 by default.

## Configure and run

From the repository root, after installing dependencies:

```bash
cp apps/proxy/.env.example apps/proxy/.env
# Edit the copied file: allowed origins and named upstream URLs/header values.
# Node 20.6+ supports --env-file; pnpm exec runs from apps/proxy.
pnpm --filter @galley/proxy exec tsx --env-file=.env src/server.ts
```

The `dev` and `start` package scripts read **process environment variables**;
they do not load `.env` automatically. If your process manager already supplies
them, use `pnpm --filter @galley/proxy dev` for watch mode or
`pnpm --filter @galley/proxy start` to run normally. Never commit real keys.

See [`.env.example`](.env.example), the [provider contract](../../docs/providers.md)
and the [security model](../../docs/security-model.md) for deployment controls.
The root Compose stack starts this service on a loopback-bound published port;
its upstreams still need explicit configuration.
