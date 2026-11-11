# Self-hosting Galley

`docker compose up` **runs** Galley — it doesn't just build it. Architecture and
the design rationale are in
[ADR-0017](decisions/ADR-0017-self-host-packaging.md).

> The web app is **standalone by default** — it compiles Typst in an in-browser
> Web Worker and keeps drafts in a local CRDT, so the **web service alone is a
> complete Galley**. The `proxy`, `sync`, and `compile` services are **opt-in**
> from the browser (query params / settings) and add cloud models, real-time
> collaboration, and server-side compile respectively.

## Quick start (Docker Compose)

```bash
# web + proxy + sync (the default profile)
docker compose up --build
# → open http://localhost:8080

# also run the optional server-side compile service
docker compose --profile compile up --build
```

## Enabling server-side compile

Server-side compile is **opt-in** — the heavier compile image (WASM + optional
Universe package fetch) is **not** run by the default `docker compose up`, so a
plain start advertises no compile URL and `/settings → Compile` reports
**"Not configured for this deployment"** (Server/Auto stay safely on the local
in-browser compiler). To turn it on, use the ready-to-run overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.compile.yml \
  --profile compile up --build
# → open http://localhost:8080, then Settings → Compile → Server / Auto
```

What the overlay does: it pre-sets the `web` service's
`GALLEY_COMPILE_URL=http://127.0.0.1:3001/compile` — the **browser-reachable**
endpoint (the compile service publishes `127.0.0.1:3001`, the handler is mounted
at `POST /compile`, and the web client POSTs to that URL verbatim). The
web-server serves this at `/config.js` so the SPA's Compile toggle sees a real
URL with no rebuild. `--profile compile` is what actually starts the `compile`
service (Compose merges the `profiles` list across `-f` files, so the overlay
cannot drop the profile — it only pre-wires the URL). CORS and CSP already permit
this call (`ALLOWED_ORIGINS` lists `:8080`; `connect-src` allows http/https).

Without the overlay you can do the same by hand:

```bash
export GALLEY_COMPILE_URL=http://127.0.0.1:3001/compile
docker compose --profile compile up --build
```

The default `docker compose up` remains web-only and unchanged.

| Service | Port (localhost) | What it is | Default |
| --- | --- | --- | --- |
| `web` | 8080 | static server for the built SPA | on |
| `proxy` | 8787 | model-API proxy (keys server-side, ADR-0004) | on |
| `sync` | 1234 | collaboration relay (ADR-0008) | on |
| `compile` | 3001 | server-side Typst compile (ADR-0015) | `--profile compile` |

Ports bind to **127.0.0.1** by default. `proxy` has **no authentication** and
`sync` is **open unless you enable `GALLEY_SYNC_AUTH`** (see "Authentication") — do
not bind either to a public interface without an auth layer in front.

### Smoke test

```bash
./scripts/smoke-selfhost.sh            # web + proxy + sync
./scripts/smoke-selfhost.sh --compile  # also compile
```
Brings the stack up, asserts every health endpoint answers and that `/` serves
the real SPA (with deep-link fallback + missing-asset 404), then tears it down.

## Using the optional services from the browser

All opt-in via the URL (or the in-app settings):

- **Cloud models via the proxy:** configure a provider in Settings with the
  `proxy` transport pointing at the proxy origin; set `UPSTREAM_<ID>_URL` /
  `UPSTREAM_<ID>_KEY` on the proxy (keys stay server-side). The key goes in
  `Authorization` unless `UPSTREAM_<ID>_AUTH_HEADER` says otherwise: a native
  Anthropic upstream (provider kind `anthropic`) needs
  `UPSTREAM_<ID>_AUTH_HEADER=x-api-key` and the bare key, see
  [providers.md](providers.md#proxy-mode--server-side-key). CORS is controlled
  by `ALLOWED_ORIGINS`.
- **Collaboration:** open a share/join link `/join/<room>?sync=ws://localhost:1234&role=editor` (or use the in-app **Share** action, which builds this link).
- **Server-side compile:** `?serverCompile=1&compileUrl=http://localhost:3001/compile`
  (the URL is POSTed verbatim, so include the `/compile` path). Easier: use the
  compose overlay — see "Enabling server-side compile" above.

## Configuration (env)

| Service | Env | Meaning |
| --- | --- | --- |
| web | `PORT` (8080), `WEB_ROOT` | listen port; SPA dir (defaults to the built `apps/web/dist`) |
| web | `CSP` | CSP override — unset = WASM-safe default; `off` = omit; else verbatim |
| proxy | `PORT` (8787), `ALLOWED_ORIGINS`, `UPSTREAM_<ID>_URL/_KEY/...` | CORS allowlist; named upstreams |
| sync | `PORT` (1234) | listen port |
| compile | `PORT` (3001), `ALLOWED_ORIGINS`, `REGISTRY_BASE_URL`, `REGISTRY_INTEGRITY_FILE` | Universe fetch is fail-closed unless both registry vars are set (ADR-0016). Registry mode requires `GALLEY_COMPILE_ISOLATION=inline` (below). |
| compile | `GALLEY_COMPILE_ISOLATION` (default `worker`), `GALLEY_COMPILE_TIMEOUT_MS` (20000) | **Default since 2026-07: `worker`** — run each compile in a terminable `worker_thread` with a hard, validated timeout (a runaway compile → 503, service stays up). Set `inline` to run WASM on the event loop; **`inline` is required with `REGISTRY_BASE_URL`** (a registry-aware worker isn't supported — the server **throws at startup** if a registry is set while isolation is `worker`, including when the var is unset). Any other value **fails loud** at startup. Worker isolation runs a real synthetic compile through a worker **before binding the port** and **refuses to start** if it fails — a worker that cannot run would otherwise 503 every request forever, which looks exactly like healthy load-shedding. Cost (measured in the runtime image, tiny docs): ~200–250 ms on the FIRST compile (thread + one-time WASM module compile, ~106 ms of it), then ~1–2 ms over inline in steady state, since V8 reuses the compiled WASM module across threads; the first compile after a runaway kill re-instantiates but does not recompile. Memory at 4 concurrent compiles ≈ inline (~218 MiB against the 512 MiB pod limit). |
| web | `GALLEY_AUTH_MODE=oidc`, plus the OIDC issuer/client env | enable OIDC (Auth Code + PKCE). Any non-empty value other than `oidc`/`off` **throws at startup** (no silent disable). Requires `GALLEY_SESSION_DIR` (below). |
| web + sync | `GALLEY_SESSION_DIR`, `GALLEY_DATA_DIR` | durable, **shared** session + data dirs. Mount the SAME volume into both containers — a session minted by `web` is validated by `sync` by reading these dirs. Under OIDC, `GALLEY_DATA_DIR` on `web` additionally hosts the **capability-room registry** (`capability-rooms/`): Share/Agent-Access rooms are registered there by `web` and authorized from it by `sync`. `web` without it logs a startup warning and Share/Agent Access fail closed against an auth-required relay. |
| sync | `GALLEY_SYNC_AUTH=required` | gate the ws upgrade on session + project membership; reserved `share-…` capability rooms (Share / Agent Access) are instead gated on an **active registration** in the shared registry (see "Capability rooms" below). Any non-empty value other than `required`/`off` **throws at startup**. Requires the shared `GALLEY_SESSION_DIR` + `GALLEY_DATA_DIR` **and** `GALLEY_SYNC_ALLOWED_ORIGINS` or the service **refuses to start** (fail-closed — see Security notes). |
| sync | `GALLEY_SYNC_ALLOWED_ORIGINS` | comma-separated exact browser Origins allowed to open a ws upgrade (CSWSH defense). Optional with auth off (unset = no Origin check, unchanged). **REQUIRED under `GALLEY_SYNC_AUTH=required`** — capability rooms are authorized by registration, not cookies, so the Origin wall is what stops a hostile page from driving a leaked room id; an auth-required relay without it refuses to start. Native (non-browser) clients send no Origin and pass only for an active registered capability room. |
| sync | `GALLEY_SYNC_PERSIST_DIR`, `GALLEY_SYNC_PERSIST_ROOMS` | optional durable volume for room state. Unset = the relay keeps nothing on disk (default). `GALLEY_SYNC_PERSIST_ROOMS` chooses what is kept: `all` (default) or `connector`, only projects connected to the hosted connector (needs `GALLEY_SYNC_AUTH=required`). Any other value **throws at startup**. |
| connector, web | `GALLEY_CONNECTOR_STATE_DIR` | optional volume for Auto mode: the connector writes checkpoints and an activity trail there, web mounts it read-only to show them to the project's owner. Unset on the connector = it never applies a change itself. Must not be `GALLEY_DATA_DIR`. |
| connector | `GALLEY_DATA_DIR`, `GALLEY_CONNECTOR_SYNC_URL`, `GALLEY_CONNECTOR_COMPILE_URL`, `PORT` | the hosted connector service (see "Hosted connector" below). The data dir and the relay address (`ws://` or `wss://`) are required; the compile address (`http://` or `https://`) is optional, and without it the `compile` tool reports `not_configured`. `PORT` defaults to 8790. A missing or malformed value **throws at startup**. |
| web | `GALLEY_HOSTED_CONNECTOR=1` | let signed-in people connect a project to the hosted connector (see "Hosted connector" below). Default off. Requires `GALLEY_AUTH_MODE=oidc` and `GALLEY_DATA_DIR`, or the service **refuses to start**. |
| web + sync | `GALLEY_INSECURE_COOKIES=1` | dev only: use the non-`__Host-` cookie name over plain HTTP. Never set in production. |
| web | `GALLEY_OIDC_ALLOW_HTTP=1` | dev only: let OIDC discovery accept a plain-`http:` issuer and that issuer's plain-`http:` endpoints. Unset = https-only (default). Anyone on the network path can then forge a login as any user — never set in production. |

**Plain-http local deploys.** `GALLEY_INSECURE_COOKIES=1` and
`GALLEY_OIDC_ALLOW_HTTP=1` are the two **dev/local-only** escape hatches and they
pair up: the first keeps the session cookie usable without TLS (no `Secure`, no
`__Host-` prefix), the second lets startup discovery accept an `http://` issuer
and that issuer's `http://` endpoints, so `web` can sign in against a local IdP
that has no certificate — a Keycloak on `http://idp.localtest.me:8090` in a kind
cluster, say. Both are **off unless set to the literal `1`**; any other value
leaves the strict behavior in place, so a typo can never quietly downgrade a
deploy. `GALLEY_OIDC_ALLOW_HTTP` is read **only under `GALLEY_AUTH_MODE=oidc`** —
with auth off it does nothing at all and no warning is logged.

Be clear about what the second one costs, because it is **not** merely "traffic
is visible". Galley learns which keys may sign an ID token by fetching the
discovery document and the JWKS from the issuer, and over plain HTTP nothing
authenticates those responses. **Anyone on the network path can serve their own
document and signing keys and forge a login as any user, including an admin.**
The remaining checks (exact `issuer` match, endpoint shape, signature-algorithm
allowlist, nonce, audience, expiry) all still run, but on an untrusted path every
value they are checked against is supplied by the attacker, so they are not a
defense there. Use this only where the whole path is trusted: a laptop, or
pod-to-pod inside a local kind cluster. `web` logs a loud startup warning for as
long as the hatch is on. One thing it will **not** do is downgrade a real IdP: an
`https://` issuer never gets `http://` endpoints even with the flag set, so a
production Keycloak behind a proxy with a misconfigured `KC_HOSTNAME` still fails
at startup instead of quietly exchanging the authorization code in plaintext.

The runtime image runs each service by exec'ing its package-local `tsx` directly,
so **container startup performs no network fetch** (offline-first / air-gapped OK).

### Authentication (optional, fail-closed)

Auth is **off by default** (open rooms / no login — the zero-config local mode). To
enable OIDC for a networked deploy you must configure auth on **both** `web` and
`sync` **and** give them a shared durable session volume:

- `web`: `GALLEY_AUTH_MODE=oidc` + the OIDC issuer/client config + `GALLEY_SESSION_DIR`.
- `sync`: `GALLEY_SYNC_AUTH=required` + the **same** `GALLEY_SESSION_DIR` and `GALLEY_DATA_DIR`,
  **plus** `GALLEY_SYNC_ALLOWED_ORIGINS` pinned to your browser origin(s) (e.g.
  `https://galley.example.com`) — an auth-required relay refuses to start without it.
- Mount one shared volume at those paths in both containers (Compose: the optional
  commented `galley-sessions` volume; k8s: a `ReadWriteMany` PVC — see the commented
  blocks in `docker-compose.yml` / `deploy/k8s/`).

If auth is requested but the shared session dir is missing, the service **refuses to
start** rather than silently falling back to a per-process in-memory store (which
could never validate a session minted in the other container — auth would look "on"
while authorizing no one). A typo in the mode value also fails closed at startup.

With OIDC on, the served runtime config (`/config.js`) carries `auth: true` and the
SPA gates boot on a `GET /auth/me` session check: signed-out visitors get a
full-screen **Sign in** (→ `/auth/login`, returning to the page they asked for), and
signed-in users see an account chip (the IdP `name`/`email`) with **Sign out**. The
SPA never probes for auth — it trusts the served flag — so auth-off deploys serve
byte-for-byte the ungated app.

#### Capability rooms (Share links & Agent Access) under sync auth

With `GALLEY_SYNC_AUTH=required`, the unguessable `share-…` rooms behind **Share**
and **Agent Access** must be **registered** before the relay admits anyone:

- The signed-in browser registers the room automatically (a same-origin,
  cookie-authenticated `POST /auth/capability-rooms`) **before** the link or the
  pairing command is shown; if registration fails (signed out, cap reached, server
  unreachable) the UI shows the error and nothing connects. This requires
  `GALLEY_DATA_DIR` to be mounted into **`web` as well as `sync`** (the SAME shared
  volume) — the registry is how the relay learns which capability rooms are live.
- Per-user limits: at most **128 active capability rooms** and **8 active Agent
  Access (control) rooms**. Control rooms expire with the login session; share
  rooms live until revoked.
- **"Stop sharing" / Revoke** also revoke the room server-side. Revocation
  **closes the door, not active sessions**: new joins and reconnects are denied
  immediately, while peers already connected stay until they disconnect.
- **The Origin allowlist is mandatory under sync auth.** Capability rooms are
  authorized by registration, not cookies, so `GALLEY_SYNC_ALLOWED_ORIGINS` is
  what stops a hostile web page from driving a leaked room id from a visitor's
  browser; the relay refuses to start without it when auth is required. The
  cookie-less MCP kernel (no Origin header) is still admitted — but only into an
  active registered capability room.
- **Migration — no grandfathering.** Turning sync auth on fail-closes every
  capability link or pairing command minted **before** auth was enabled (those
  rooms were never registered). Re-click Share / re-enable Agent Access to mint
  and register fresh ones.

With auth **off** (the default), none of this machinery runs: Share and Agent
Access behave exactly as in the zero-config local mode.

#### Hosted connector (connected projects)

The hosted connector lets an AI chat client work on a project with no Galley
tab open ([ADR-0033](decisions/ADR-0033-hosted-connector.md)). It is being
built in steps. **This release reads and writes:** connected projects, access
tokens, and an endpoint an AI client can use to list, read, search and compile
a connected project and to change it. In Ask mode a change is stored in the
project as a proposal and waits for its owner to accept it in Galley. In Auto
mode the server applies it, provided you gave the connector a state volume
(below); without one a project set to Auto is reviewed like one set to Ask.

A project lives in the browser. For the server to work on it with no tab open,
the server needs its own copy, so connecting a project means exactly that:

- In **Settings → Agent Access → Hosted connector**, a signed-in person
  connects a project. The browser registers a durable `connector` room for it
  and, whenever the project is open, keeps it synced into that room. The relay
  stores the room on disk. **The server then holds the project in plain text**,
  readable by whoever operates it, until the project is disconnected.
- Each connected project has a review mode, **Ask** (default) or **Auto**,
  recorded with the room. In Ask a change from the connector appears as a
  review card the next time the project is open in Galley, and nothing changes
  until it is accepted there. In Auto the connector applies it at once. Before
  each such change it saves a checkpoint of the whole project and writes an
  entry to the project's activity trail, both on its state volume
  (`$GALLEY_CONNECTOR_STATE_DIR/checkpoints/`, `…/activity/`). The owner sees
  the trail in the same Settings card and returns to a checkpoint from the
  project's History. The newest 50 checkpoints are kept per project, and at
  most 500 file operations or 16 MiB are applied per project per hour; past
  that, changes wait for review.
- **Disconnect** revokes the room. The relay drops any connection to it and
  erases the stored copy within about half a minute; the connector erases the
  project's checkpoints and activity trail on the same schedule. The project in the
  browser is untouched.
- Limits: 32 connected projects per person, one room per project.
- **Access tokens** are created in the same Settings card, one per AI client.
  A token (`gly_…`) acts as the person who created it, on every project they
  have connected and on nothing else. It is shown once, at creation; the server
  stores only its SHA-256 fingerprint, under
  `$GALLEY_DATA_DIR/connector-tokens/`, so a leaked data volume or backup does
  not yield usable tokens. A token lasts 90 days by default (30 or 365 on
  request), and revoking it deletes the record. Limit: 16 live tokens per
  person.

- **The endpoint** is a separate small service from the same image
  (`apps/mcp/src/hosted/main.ts`), answering `POST /mcp`. A client proves who
  it is with an access token, sent as `Authorization: Bearer gly_…` or, for
  chat apps that accept only an address, inside the path: `/mcp/gly_…`. It
  keeps no session. For each call it checks the token, looks up the caller's
  connected projects, joins the project's room on the relay as one more peer,
  answers and leaves. It reads the data volume and never writes it, and it
  never opens the relay's stored files. The only thing it writes is its own
  state volume.

To enable it, set the switches on **all three** services. They are parts of one
feature, in containers that cannot check each other:

```
# web
GALLEY_HOSTED_CONNECTOR=1
# sync (a volume mounted at the persist dir)
GALLEY_SYNC_PERSIST_DIR=/var/lib/galley/crdt
GALLEY_SYNC_PERSIST_ROOMS=connector
# connector (the web service's data volume, mounted read-only)
GALLEY_DATA_DIR=/var/lib/galley/projects
GALLEY_CONNECTOR_SYNC_URL=ws://galley-sync
GALLEY_CONNECTOR_COMPILE_URL=http://galley-compile   # optional
# connector + web, for Auto mode: a volume the connector writes and web reads
GALLEY_CONNECTOR_STATE_DIR=/var/lib/galley/connector
```

Route `/mcp` on the web app's own host to the connector (the Settings page
shows `https://<your host>/mcp` as the address). On Kubernetes the
`deploy/k8s/components/connector` component does all of this, composed in
`overlays/auth-compile-connector`.

**Keep `/mcp` out of your access logs.** With the path form the address is the
credential, and an access log line would record it. The connector itself never
logs a request line, and the bundled Ingress turns its access log off; do the
same on any proxy, CDN or load balancer in front of it.

With only the first, people can "connect" a project whose copy disappears when
they close the tab. With `GALLEY_SYNC_PERSIST_ROOMS` left at its default, the
relay keeps **every** room on disk, including plain Share rooms; use
`connector` unless that is what you want. Back up the persist volume and the
connector's state volume with the data volume: they now hold documents.

## Docker image

One shared multi-stage image (the Dockerfile `runtime` target) runs every service;
the build/test stages and the green-gate (`docker-compose.test.yml`) are untouched.

```bash
docker build --target runtime -t galley-runtime .
docker run -p 8080:8080 galley-runtime          # serves the SPA
```

It builds the whole workspace (`pnpm -r build` → `apps/web/dist` incl. the typst
WASM; tsc for the Node services), runs as the non-root `node` user, and `EXPOSE`s
8080/8787/1234/3001.

### Serving Galley under a subpath

Galley is served from the root (`/`) by default. To host it under a path prefix
(a reverse proxy at `example.com/galley`, or the GitHub Pages demo), build the
bundle with a matching Vite base:

```bash
pnpm --filter @galley/web exec vite build --base=/galley/
```

The base is baked into the bundle at build time: the router strips it off
`location.pathname`, the worker loads its WASM + fonts from under it, and share
links carry it. Serve the built `apps/web/dist` at exactly that prefix, and make
sure unknown paths under it fall back to `index.html` (the app owns its routes).
The default build is unchanged and needs none of this.

## Kubernetes

Manifests + apply order live in [`deploy/k8s/`](../deploy/k8s/README.md). Defaults
are deliberately conservative: **only `web` is exposed**
via Ingress; `proxy`/`sync` are ClusterIP-only behind a default-deny NetworkPolicy
until you add an auth layer (`90-expose-proxy-sync.opt-in.yaml`). Every pod runs
under PodSecurity `restricted`.

## Security notes

- **proxy** holds cloud API keys — never expose it without auth; CORS is not auth.
- **sync** is **open by default** (every connected peer trusted) — keep it private
  unless you enable auth. With `GALLEY_SYNC_AUTH=required` + a shared session/data
  volume it gates each ws upgrade on session + project membership (**fail-closed**:
  it refuses to start if misconfigured, and denies the upgrade — closing 1008 before
  any data — for a missing/expired session or a non-member). See "Authentication".
- **compile** runs WASM; a runaway compile is reclaimed by **container CPU/mem/PID
  limits** (a JS timeout can't preempt sync WASM — ADR-0015 §4). If you enable
  Universe fetch, restrict egress to the registry host and keep the **required**
  integrity manifest (ADR-0016).
- The static server adds a WASM-safe CSP + `X-Frame-Options`/`Referrer-Policy`/
  `Permissions-Policy`; tune via the `CSP` env.
