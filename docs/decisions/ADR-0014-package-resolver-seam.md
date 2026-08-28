# ADR-0014 — Package-resolver seam (offline-first, fail-closed)

- **Status:** Accepted
- **Relates to:** ADR-0013 (multi-file projects). Foundation for Typst Universe
  package/template resolution; the real fetch path is gated on server-side compile
  (roadmap #3).

## Context

Multi-file projects (ADR-0013) resolve virtual `#import "/lib.typ"` between
project files. The next step the roadmap names is Typst **Universe** packages
(`#import "@preview/cetz:0.2.0": …`). Two facts, verified against typst.ts 0.7:

- A `@preview/…` import does **not** resolve from `addSource`'d shadow files.
  typst.ts fails **closed** with *"failed to load package (Dummy Registry, please
  initialize compiler with withPackageRegistry())"* — i.e. today, package imports
  fail with **no network access attempted**.
- typst.ts exposes a low-level WASM hook `set_package_registry(context,
  real_resolve_fn)` — a fetch **callback** — that is **not** on the high-level
  compiler API and is **not wired**.

The roadmap explicitly defers real, trusted, sandboxed registry fetching to
server-side compile; "until then, examples stay bundled + built-in." Fetching and
compiling third-party package code is security-sensitive (SSRF, path traversal,
spoofing, DoS, untrusted code), so we design the seam now and defer the fetch.

## Decision

Ship the **resolver seam** + an **offline `FakeRegistry`**, with the browser
compile path **fail-closed** (the typst.ts package callback stays unwired). The
seam (`@galley/compiler/package-resolver.ts`) bakes in the safety constraints up
front so a future server-side resolver plugs into the same validated shape:

- **`PackageSpec` = `{ namespace, name, version }`**, parsed by `parsePackageSpec`
  with **strict ASCII** validation (lowercase alnum+hyphen ≤63; strict 3-part
  SemVer, optional prerelease, no build metadata). Rejects URLs, uppercase,
  Unicode confusables, floating versions (`latest`, `^1`), and traversal — a spec
  can never carry a fetch target or spoof another package.
- **`parsePackageImports(source)`** — a **bounded, ReDoS-safe** linear scan
  (no nested quantifiers; capped scan length + result count) for the coordinates a
  project needs.
- **`resolvePackagePaths(spec, files, limits)`** — normalizes a package's files
  under its **own canonical VFS root** (`/packages/<ns>/<name>/<version>/…`),
  rejecting absolute paths, `..`/`.`/empty segments, backslashes, control chars,
  disallowed extensions (only `.typ`/`.toml` — no plugin/WASM/asset smuggling),
  and duplicates; enforces per-file / total-bytes / file-count caps (DoS guard).
- **`PackageResolver { resolve(spec): ProjectFile[] | null }`** — synchronous,
  in-memory by contract (no network, no FS, no URLs), and **`FakeRegistry`**, an
  offline map-backed resolver that pre-validates every entry at construction.

The engine is **unchanged**: a `@preview` import still fails closed (a regression
test locks this). The seam has no in-browser consumer yet — wiring it to typst.ts's
package callback is the deferred server-side work.

## Security (from a Security-Analyst review)

Boundary rated **LOW risk** for this offline slice *because* it stays fail-closed,
validated, and size-bounded. Constraints adopted now (above) and the must-haves for
the future server-side `real_resolve_fn` (recorded so the seam already supports
them):

- Allow-list namespaces (initially only `@preview`); pin exact versions.
- Never derive the upstream URL from user input — map validated specs to a fixed
  registry host; no client-supplied URLs; no (or same-host only) redirects;
  restrict network egress at the infra level.
- Verify artifact integrity/hash before loading; cap response / archive /
  decompressed size, file count, recursion depth, compression ratio.
- Normalize + traversal-check archive paths before extraction (reject
  symlinks/hardlinks/device files).
- Run fetch/extract/compile in a sandbox with CPU/memory/wall-clock/output limits;
  log only canonical package IDs, never source bodies or secrets.

Compiling attacker-supplied Typst in WASM is sandboxed (no FS/process/network from
within a compile); the residual risk is DoS (infinite loops / huge output), already
mitigated by the compile timeout + the size caps here.

## Consequences

- The product is unchanged; `@preview` imports fail closed with no network.
- The seam + `FakeRegistry` are the offline-first foundation; tests pin the
  validation/traversal/DoS/ReDoS guards so they don't regress when fetching lands.
- Real Universe resolution = wire typst.ts's package callback to a sandboxed
  server-side fetch behind this seam (its own ADR + a follow-up security review).
