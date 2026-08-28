# ADR-0017 — Self-host packaging: runtime image + compose topology

- **Status:** Accepted (architecture); built core-first in slices.
- **Relates to:** ADR-0004 (model proxy), ADR-0008 (sync server), ADR-0015
  (server-side compile). Opens roadmap **#5**.
- **Review:** runtime-image / compose-topology design fork validated by the
  Architect (GPT) expert; the network-exposed surface (static server, compose
  defaults, k8s exposure) reviewed by the Security Analyst (GPT) before promotion.

## Context

Roadmap #5 wants `docker compose up` to **run** Galley, not just build it. Today
the `Dockerfile` has only build/test stages (`base`/`deps`/`source`/`unit`/`test`)
and `docker-compose.yml` merely runs `pnpm build` — there is **no runtime/`serve`
target and no EXPOSE**. The deliverable: serve the built `@galley/web` SPA bundle
statically and run the optional `apps/proxy`, `apps/sync`, and `apps/compile`
services as their own containers with healthchecks; then Kubernetes manifests.

Hard constraint: the canonical green-gate (the Docker `test`/`unit` stages + the
`docker-compose.test.yml` command) must stay **byte-for-byte stable** — self-host
packaging is purely **additive**. The web app is **standalone by default**
(in-browser worker compile, local CRDT); the proxy/sync/compile services are all
**opt-in from the browser** via query params / settings, so a self-host deploy
that runs only the web container is a complete, working Galley.

## Decision

Add a tiny first-party **static web server** (`@galley/web-server`) and **one
shared runtime Docker image**; `docker compose up` runs each service as its own
container. Defer runtime config injection (the SPA learns service URLs via query
params today). Decisions on each design fork (Architect consult):

### 1. Static serving — a tiny Hono static server (not nginx, not `serve`)

`@galley/web-server` reuses the `hono` + `@hono/node-server` stack already in
`apps/proxy`/`apps/compile` — Hono-everywhere consistency, unit-testable in the
existing Vitest Docker gate, no second serving stack (nginx) or CLI black box
(`serve`). It serves the built `dist/` with: extension→content-type mapping, an
**SPA navigation fallback** (a no-extension route → `index.html`), a real **404
for a missing *asset*** (extensioned — never masked by the shell), `/healthz`,
HEAD, 405 on mutating methods, hashed-asset immutable caching + `index.html`
no-cache, and `X-Content-Type-Options: nosniff`. No COOP/COEP (typst WASM needs
none — confirmed in M0).

### 2. Location — a new `apps/web-server` package (not folded into `apps/web`)

`apps/web` stays Vite/browser-only (no Node server deps). `apps/web-server` is a
sibling Node service like proxy/sync/compile. Adding it followed the package
ritual: regenerate the lockfile, COPY its `package.json` in **both** the `deps`
and `test` Dockerfile stages.

### 3. Runtime image — ONE shared `runtime` stage (not per-service images)

Build the workspace once (reuse `base`/`deps`/`source`, run `pnpm build`); compose
runs `web-server`/`proxy`/`sync`/`compile` from the **same image** with different
`command:`s. Per-service images are a later optimization only if measured
size/startup pain appears.

### 4. `tsx` in the runtime (not compiled JS) — for now

The Node services run via `tsx src/server.ts`, matching their existing `start`
scripts and avoiding a package-exports refactor (workspace exports currently point
at `src/*.ts`). `pnpm build` still runs during the image build so type/build
failures surface. Moving to a pruned compiled-JS runtime is a later hardening
slice.

### 5. Compose topology — web/proxy/sync default, compile profile-gated

`docker compose up` starts `web` + `proxy` + `sync` (lightweight edges) with
healthchecks; `compile` is behind a `--profile compile` opt-in (heavier: WASM +
optional registry fetch). Ports bind to **localhost** by default. Runtime config
injection (a served `/config.json`) is **deferred** — query params + provider
settings already cover opt-in services, and standalone-web is the default.

### 6. Core↔wiring seam — an injected `StaticFiles`

`createWebServerApp({ files })` takes an injected `StaticFiles`
(`read(relPath) → bytes | null`); the routing/traversal/fallback **core** is
unit-tested offline with an in-memory fake. `server.ts` wires a disk-backed
provider rooted at the dist dir + binds the socket (the only non-offline part).

## Security (network-exposed surface)

- **Path traversal: three independent layers.** `toSafeRelPath` rejects any `..`
  segment / NUL / backslash (directly unit-tested); the WHATWG URL parser resolves
  `..`/`%2e%2e` to an in-root path before the handler; the disk-backed
  `StaticFiles` re-checks `resolve()` containment within root. None can serve
  out-of-root bytes.
- **Defaults bind localhost**; sync has **no auth/persistence** yet (called out in
  docs + k8s exposure notes — closing the open rooms is roadmap #4's authz seam).
- Proxy/compile keep their existing CORS allowlists; no secret is ever baked into
  an image or logged.

## Consequences

- `docker compose up` → a working Galley on a port, no host toolchain; the build/
  test gate is untouched.
- The `tsx`-in-runtime choice keeps dev deps in the runtime image (larger, dev
  deps present) — mitigated by a non-root runtime user, no mounted source/secrets,
  pinned lockfile, and a future compiled/pruned-image slice.
- One image for all services keeps the build cache hot and the topology simple;
  splitting later is a contained change (per-service targets).

## Slices

1. **`apps/web-server` static server core** ✅ — the Hono app + injected
   `StaticFiles`, +14 offline unit tests.
2. **Docker `runtime` stage** — reuse base/deps/source, `pnpm build`, EXPOSE,
   default CMD = web-server.
3. **`docker compose up` profile + smoke** — web/proxy/sync default + compile
   profile, healthchecks, a curl smoke check.
4. **Kubernetes manifests** — Deployment/Service/Ingress for web + proxy + sync;
   Security-Analyst review of the exposed surface.
