# How the Typst Universe is connected

> Audience: operators wiring up the optional [server-side compile
> service](server-side-compile.md), and contributors reasoning about package
> security. Design references:
> [ADR-0014](decisions/ADR-0014-package-resolver-seam.md) (resolver seam),
> [ADR-0015](decisions/ADR-0015-server-side-compile.md) (architecture),
> [ADR-0016](decisions/ADR-0016-registry-fetch-security.md) (fetch/extract
> security).

Galley does **not** trust the Typst Universe index. It compiles `@preview/…`
imports only against packages an operator has explicitly curated, version-pinned,
fetched once, and frozen by hash. The connection is two phases joined by one
artifact — an **integrity manifest** — and everything is **fail-closed**: a
package with no hash entry can never be fetched.

```
                    BUILD PHASE (ops, offline)              RUNTIME PHASE (request path)
                    ───────────────────────────             ─────────────────────────────
  apps/compile/                                              REGISTRY_BASE_URL ─┐
  universe-catalog.json  ──┐                                                    │
  (UNIVERSE_CATALOG)       │   pnpm --filter @galley/compile build:manifest     ▼
   "@preview/cetz:0.2.2"   ├──▶  build-manifest-cli.ts ──▶ universe-integrity.json ──▶ compile service
   "@preview/tablex:…"     │       fetch + gunzip +          { "@preview/cetz:0.2.2":   (server.ts)
   …pinned specs…          │       strict-untar +              { sha256, size }, … }       │
                           │       resolvePackagePaths                ▲                     │  POST /compile
                           │       → record observed                 │                     │  scan @preview imports
                           │         {sha256,size}     REGISTRY_INTEGRITY_FILE ─────────────┤  prewarm each (fail-closed)
                           │                                                                │  verify hash/size → resolver
   operator pins what      │                                                                ▼
   they trust ─────────────┘                                                         MutablePackageResolver
                                                                                     (set per request, cleared after)
```

## Phase 1 — Build (ops, offline)

An operator decides which Universe packages to trust and at which exact versions.

1. **Curate the catalog.** Edit
   [`apps/compile/universe-catalog.json`](../apps/compile/universe-catalog.json) — a
   JSON array of `"@preview/name:version"` strings, or `{ "packages": [...] }`.
   Every version must be exact; an unpinned or mistyped spec is reported as a
   `SKIP` and simply won't be in the manifest.

2. **Snapshot it into a manifest.** Run the build tool. It fetches each pinned
   artifact from the live registry through the **same audited network edge and
   hardened archive reader the runtime uses** (`fetchRegistryArtifact`:
   https/loopback-only, no redirects, compressed-size cap, abort timeout), proves
   the bytes are usable (`gunzip → strict ustar untar → resolvePackagePaths`),
   and only then records the `{ sha256, size }` it observed. Anything that fails
   any step is omitted and printed as `SKIP` — never hashed-as-garbage. This is
   the **only** place in Galley that computes a package hash from the network; the
   runtime only ever *verifies* one.

```bash
# 1. Pin the @preview/name:version set you trust in the catalog.
$EDITOR apps/compile/universe-catalog.json

# 2. Snapshot → integrity manifest.
REGISTRY_BASE_URL=https://packages.typst.org \
  pnpm --filter @galley/compile build:manifest \
  apps/compile/universe-catalog.json ./packages.lock.json
```

Config resolution (flags override env override defaults):

| Input | Source (precedence) | Default |
| --- | --- | --- |
| catalog | `argv[2]` → `UNIVERSE_CATALOG` → | `./universe-catalog.json` |
| out file | `argv[3]` → `REGISTRY_INTEGRITY_FILE` → | `./universe-integrity.json` |
| registry | `REGISTRY_BASE_URL` → | `https://packages.typst.org` |

Example output (`packages.lock.json`):

```json
{
  "@preview/cetz:0.2.2": { "sha256": "…64 hex chars…", "size": 184320 },
  "@preview/tablex:0.0.8": { "sha256": "…", "size": 40960 }
}
```

The CLI exits **non-zero** if the catalog is unreadable/empty or if *zero*
packages snapshot successfully, so CI never ships an empty (silently fail-closed)
manifest by accident. Per-package failures are printed but don't fail the run as
long as at least one package succeeded.

Treat the manifest as a **reviewed supply-chain artifact**: commit it, diff hash
changes deliberately, and don't auto-refresh it from live responses without
review. Because hashes are frozen at snapshot time, a later upstream change to a
pinned version is **rejected** at compile (size/hash mismatch).

## Phase 2 — Runtime (request path)

The [compile service](server-side-compile.md) opts in to Universe resolution via
two env vars:

| Var | Meaning |
| --- | --- |
| `REGISTRY_BASE_URL` | The Universe host (`https://packages.typst.org`). **Unset → packages fail closed**, no network, `@preview` imports error. |
| `REGISTRY_INTEGRITY_FILE` | Path to the manifest from Phase 1. **Required** when `REGISTRY_BASE_URL` is set (`server.ts` throws on start otherwise — ADR-0016: no hash, no fetch). |

On each `POST /compile` request the flow is:

1. **Scan** the input's sources for distinct `@preview/…` imports
   (`scanCompileInputImports`).
2. **Prewarm** each requested spec (`prewarmFromRegistry` → `prewarmRegistry`):
   look it up in the loaded manifest. **No entry → no fetch** (fail closed). If
   present, fetch from `REGISTRY_BASE_URL`, **verify the bytes against the pinned
   `{ sha256, size }`**, decompress within caps, strictly extract, and validate
   paths via `resolvePackagePaths`. Any package that fails any step is omitted —
   it simply won't resolve, so the compile fails closed for imports of it (never a
   partial or poisoned resolve).
3. **Bind** the verified packages to the engine for *this* request via a
   `MutablePackageResolver` holder, then **clear** the holder after the compile
   (even on throw). typst.ts's package callback is synchronous and per-compile;
   the single engine serializes compiles, so the holder is never accessed
   concurrently.

Server start example (registry mode requires `GALLEY_COMPILE_ISOLATION=inline` —
worker isolation is the default and is incompatible with a registry, so the
server throws at startup if you omit it):

```bash
PORT=3001 ALLOWED_ORIGINS=http://localhost:5173 \
  GALLEY_COMPILE_ISOLATION=inline \
  REGISTRY_BASE_URL=https://packages.typst.org \
  REGISTRY_INTEGRITY_FILE=./packages.lock.json \
  pnpm --filter @galley/compile start
```

## Why fail-closed matters

The catalog pins **what humans trust**; nothing trusts the whole index. The
manifest is the trust boundary, enforced twice:

- **No hash entry → no fetch.** A package the document imports but the manifest
  doesn't pin cannot be requested over the network at all.
- **Hash mismatch → compile fails.** Even a pinned package whose upstream bytes
  drifted (a re-published version, a tampered mirror) is rejected on size/hash
  mismatch before it can reach the engine.

So the worst an attacker controlling document source can do is import a package
that isn't in the manifest — and get a fail-closed "unresolved import", never an
arbitrary fetch or an unverified artifact. Network-level egress allow-listing to
the registry host is the recommended backstop (see the
[deployment sandboxing checklist](server-side-compile.md#deployment-sandboxing-checklist)).

## Known limitation: worker isolation

Terminable per-compile `worker_thread` isolation is the **default** since the
2026-07 flip (`GALLEY_COMPILE_ISOLATION` unset = `worker`), but it is
**incompatible with registry packages today** — the per-request worker thread has
no resolver holder, so the service throws on start if a registry is set while
isolation resolves to `worker` (including when the var is left unset). Registry
deployments MUST therefore set `GALLEY_COMPILE_ISOLATION=inline` explicitly
(`server.ts`). Choose one: registry packages on the inline engine, or worker
isolation without registry packages.

## Where the code lives

| Concern | File |
| --- | --- |
| Curated catalog | `apps/compile/universe-catalog.json` |
| Build CLI | `apps/compile/src/build-manifest-cli.ts` |
| Build core + verification | `apps/compile/src/build-manifest.ts` |
| Server wiring (env → backend) | `apps/compile/src/server.ts` |
| Per-request scan + holder | `apps/compile/src/package-compile.ts` |
| Fetch / integrity / extract | `apps/compile/src/registry-resolver.ts` |
| Tests (build) | `apps/compile/src/build-manifest.test.ts` |
| Tests (runtime resolution) | `apps/compile/src/registry-resolver.test.ts` |
