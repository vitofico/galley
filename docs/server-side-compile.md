# Server-side compile (`apps/compile`)

> Optional. The browser compiles Typst in a Web Worker by default; this service
> exists for **trusted Universe package access** (`#import "@preview/…"`) and
> heavier projects. Design: [ADR-0015](decisions/ADR-0015-server-side-compile.md)
> (architecture) + [ADR-0016](decisions/ADR-0016-registry-fetch-security.md)
> (fetch/extract security). For the end-to-end catalog → manifest → runtime story,
> see [How the Typst Universe is connected](UNIVERSE_INTEGRATION.md).

## What it is

A thin Hono service that runs `@galley/compiler`'s `TypstEngine` in Node and
answers the same `check` / `render` / `export` contract the browser worker does,
over HTTP. The browser can point a `RemoteCompilerClient` at it instead of the
worker — same `Compiler` interface, so preview / agent / diff are unchanged.

```
POST /compile   { op: "check"|"render"|"export", input: <source string | ProjectInput> }
                → CheckResult | RenderResult | ExportResultWire   (PDF base64)
GET  /healthz   → { ok: true }
```

## Configuration (env)

| Var | Required | Meaning |
| --- | --- | --- |
| `PORT` | no (default `3001`) | Listen port. |
| `ALLOWED_ORIGINS` | no | Comma-separated CORS allowlist (the web app origin). Empty = same-origin only. |
| `GALLEY_COMPILE_ISOLATION` | no (default `worker`) | `worker` (the default, incl. when unset) runs each compile in a terminable `worker_thread` with a hard timeout — a runaway compile → 503, service stays up. `inline` runs WASM on the event loop and is **required with `REGISTRY_BASE_URL`** (a registry-aware worker isn't supported yet — the server **throws at startup** if a registry is set and isolation is `worker`). Any other value **fails loud** at startup. `GALLEY_COMPILE_TIMEOUT_MS` (default 20000) tunes the timeout. |
| `REGISTRY_BASE_URL` | no | Opt in to Universe package resolution. **Unset → packages fail closed** (the default; `@preview` imports error, no network). Must be `https://` (or `http://` loopback for tests). Requires `GALLEY_COMPILE_ISOLATION=inline`. |
| `REGISTRY_INTEGRITY_FILE` | **yes, if `REGISTRY_BASE_URL` is set** | Path to the integrity manifest. **No hash → no fetch** (ADR-0016). |

### Integrity manifest

JSON mapping each pinned package to its expected artifact hash + size:

```json
{
  "@preview/cetz:0.2.0": { "sha256": "<hex>", "size": 123456 }
}
```

A package the document imports but the manifest doesn't pin **cannot be fetched**
— it simply won't resolve, so the compile fails closed for that import. Generate
this manifest in a controlled mirroring/packaging step you run and review; the
same file works against the offline test fixture.

#### Generating the manifest from the real Universe

`build:manifest` produces this file from a curated, version-pinned catalog by
snapshotting each artifact from the live registry — fetched through the **same**
audited edge the runtime uses (`fetchRegistryArtifact`: https/loopback-only, no
redirects, compressed cap, abort timeout) and validated through
`gunzip → strict-untar → resolvePackagePaths` **before** its observed hash is
recorded. Anything that fails any step is omitted (printed as `SKIP`), never
hashed-as-garbage:

```bash
# Edit apps/compile/universe-catalog.json to pin the @preview/name:version set you trust.
REGISTRY_BASE_URL=https://packages.typst.org \
  pnpm --filter @galley/compile build:manifest \
  apps/compile/universe-catalog.json ./packages.lock.json
```

Hashes are frozen at snapshot time, so a later upstream change to a pinned version
is **rejected** at compile (size/hash mismatch). Treat the output as a reviewed
supply-chain artifact: **commit it, diff hash changes, and don't auto-refresh it
from live responses without review.** The catalog only lists what you trust;
nothing trusts the whole index.

## Input caps (built in)

The handler rejects oversized requests with **413** before compiling
(`DEFAULT_COMPILE_LIMITS`: 8 MB request, 256 files, 2 MB/file, 8 MB total). Fetch
+ extract enforce their own caps (compressed/decompressed size, file count, per-
file bytes) and a strict archive parser (regular files only; checksum-verified;
rejects symlink/hardlink/device, GNU/PAX, base-256, truncation, trailing garbage).

## Deployment sandboxing checklist

A Typst **compile** has no filesystem / process / network access from within, so
the residual risks are the package **fetch** (handled in-app: fixed host, no
redirects, required integrity, caps) and compile/CPU **exhaustion**. *Killing* a
runaway compile (e.g. an infinite loop) is **not** something the in-process JS
service can do — a JS timeout can't preempt synchronous WASM. Enforce it at the
deployment layer:

- **Resource limits** on the container: CPU quota, memory limit (OOM-kills a
  runaway), and a **PID limit**. A wedged compile is then reclaimed by the platform,
  not the app. (The browser client already times out, so callers never hang.)
- **Read-only root filesystem** + a small tmpfs if needed. The service writes
  nothing to disk (packages live in memory).
- **`no-new-privileges`**, **drop all Linux capabilities**, non-root user.
- **Egress allow-list**: permit outbound only to the configured registry host
  (and only when `REGISTRY_BASE_URL` is set). This is the real defense against a
  hostile/compromised base URL resolving to internal infrastructure (DNS
  rebinding) — the app rejects userinfo / non-loopback http, but network-level
  egress control is the backstop.
- **Multi-tenant?** Don't share one process across tenants for untrusted input.
  Isolate per tenant (separate container / gVisor / a terminable worker pool).
  Single-tenant self-host is the supported default; public multi-tenant compile is
  out of scope until an isolation substrate is chosen (ADR-0015).
- **Logging**: the service returns generic failures and logs only canonical
  package IDs + reason codes + byte counts — never document/response bodies, URLs
  with credentials, or secrets.

## Running locally

```bash
pnpm --filter @galley/compile start          # packages fail closed (no registry); worker isolation (default)
# With Universe resolution — GALLEY_COMPILE_ISOLATION=inline is REQUIRED (worker
# isolation is incompatible with a registry; the server throws at startup if both
# GALLEY_COMPILE_ISOLATION=worker (the default) and REGISTRY_BASE_URL are set):
PORT=3001 ALLOWED_ORIGINS=http://localhost:5173 \
  GALLEY_COMPILE_ISOLATION=inline \
  REGISTRY_BASE_URL=https://packages.typst.org \
  REGISTRY_INTEGRITY_FILE=./packages.lock.json \
  pnpm --filter @galley/compile start
```
