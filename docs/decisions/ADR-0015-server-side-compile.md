# ADR-0015 — Server-side compile + sandboxing (architecture)

- **Status:** Accepted (architecture); built core-first in slices.
- **Relates to:** ADR-0001 (browser typst.ts), ADR-0013 (multi-file projects),
  ADR-0014 (package-resolver seam). Opens roadmap **#3**.
- **Review:** architecture validated by the Architect (GPT) expert; the package
  callback de-risked by an offline spike before any slice (see Decision §1).

## Context

Roadmap #3 wants an **optional** server-side compile path for two things the
browser WASM compile can't do: (a) **trusted Typst Universe package access**
(`#import "@preview/…"`), which the browser leaves fail-closed by ADR-0014, and
(b) heavier projects. The framework-agnostic `@galley/compiler` (`TypstEngine`,
which already runs in Node) and the ADR-0014 `PackageResolver` seam exist
precisely to make this a **lift, not a rewrite**.

Hard constraint: the canonical green-gate is **offline Docker** — no live Universe
during tests. So every slice must be verifiable against an offline test double
(`FakeRegistry` / a local HTTP fixture), never the real registry.

## Decision

Build an **optional `apps/compile` service** that reuses `@galley/compiler`'s
Node-capable `TypstEngine`. Keep all security-sensitive logic behind the ADR-0014
seam (one validation path). Default OFF; the browser/worker path is unchanged.

### 1. Engine: typst.ts WASM-in-Node (not the `typst` binary)

Reuse `TypstEngine` as-is. The real `typst` binary would fork diagnostics
normalization, packaging, Docker images, temp-file handling, and sandboxing
earlier than needed, for a performance win we haven't shown we need. Defer the
binary behind the same `Compiler` interface *only if* heavy-project benchmarks
later prove WASM insufficient.

**De-risked first (offline spike):** typst.ts 0.7 exposes the package callback via
the high-level API — `compiler.init({ beforeBuild: [withAccessModel(am),
withPackageRegistry(reg)] })`. A `@preview/…` import resolves in Node **only**
when package files are inserted into the **`/@memory` namespace** (any other path
is "outside the project root") and the registry writes into the **same**
`MemoryAccessModel` the compiler is given. This was unknown (ADR-0014 called it
"unwired"); it is now proven and encoded in `package-registry-bridge.ts`.

### 2. Service: a new `apps/compile` (Hono), not folded into proxy/sync

Compile is CPU- and package-fetch-sensitive; `apps/proxy` is a stateless model
relay and `apps/sync` a websocket doc relay. A new thin Hono service (env config,
`/healthz`, integration-tested like the others) keeps concerns separated. The
browser opts in behind a flag (`?serverCompile=1` + a compile-service URL) via a
transport seam so the Web Worker and a remote service are interchangeable behind
the existing `Compiler` interface.

### 3. Resolver: bridge ADR-0014 → typst.ts's callback

`packageRegistryBeforeBuild(resolver)` (in `@galley/compiler`) adapts a
`PackageResolver` to typst.ts's `PackageRegistry` + a `MemoryAccessModel`,
re-rooting ADR-0014's `/packages/<ns>/<name>/<version>/…` paths under
`/@memory/galley`. It adds **no** validation of its own — `resolvePackagePaths`
remains the single gate. The server-side `RegistryResolver` (a later slice) does
the sandboxed HTTPS fetch → tar-extract → `resolvePackagePaths` → warmed,
synchronous `PackageResolver`; the gate tests it against a local HTTP fixture.

### 4. Sandbox: minimal-now, deployment-deferred

A Typst compile has no FS/process/network access from within, so the residual
risk is the package **fetch** and compile **DoS**. **Build now** (testable):
fixed-host egress (never a client-supplied URL), the ADR-0014 fetch/extract/size
hardening, a killable compile worker with wall-clock/output/memory caps, and
redacted logs. **Defer to deployment** (documented, not gate-tested): container /
K8s / gVisor / seccomp isolation strength — an infra choice, single-tenant first.

## Build sequence (each slice green offline in Docker)

1. **Package-registry bridge** `[core/unit]` — `packageRegistryBeforeBuild` +
   `TypstEngine` `packageResolver` option. ✅ **done** (this ADR; real typst.ts,
   `FakeRegistry`, fail-closed without a resolver).
2. **Remote compiler seam** `[core/unit]` — shared wire types + a
   `RemoteCompilerClient` implementing `Compiler` over HTTP (fake-fetch tested).
3. **`apps/compile` skeleton** `[integration]` — Hono `/healthz` + `POST /compile`
   returning diagnostics/SVG/PDF for a `CompileInput`; real WASM, no network.
4. **Killable worker + caps** `[integration]` — compile off the event loop;
   request/size/wall-clock/output caps; worker restart on timeout.
5. **`RegistryResolver` fetch/extract/cache** `[integration]` — sandboxed fetch
   from a fixed host → tar extract → `resolvePackagePaths`; local-HTTP-fixture
   tested (valid, redirect/namespace reject, traversal/symlink/oversize/hash).
6. **Package-enabled server compile** `[integration]` — scan imports, prefetch,
   warm the resolver, compile through `TypstEngine`.
7. **Web opt-in** `[e2e]` — `?serverCompile=1` + service URL; `initCompiler`
   chooses remote vs worker; existing e2e unchanged without the flag.
8. **Deployment sandbox docs** `[deploy-only]` — single-tenant default + the
   multi-tenant isolation checklist.

## Addendum — browser-routed compile fallback (MCP, F9/F5)

The MCP kernel's `compile` tool exposes diagnostics to a paired agent. It has **two
diagnostics sources**, in strict **precedence order**:

1. **Loopback `--compile-url` service** (the `apps/compile` service above). When the
   operator starts the kernel with `--compile-url`, `compile` POSTs the project to
   that loopback host and relays its diagnostics. The document never leaves the
   loopback host. This source **always wins** when configured.
2. **Browser-routed fallback** (F9) — when **no** `--compile-url` is configured, the
   kernel sends a `compile` control RPC to the **paired browser**, which relays the
   diagnostics it **already computed for its live preview** (no new compile work; no
   document leaves the browser). The kernel tags the result `source: "browser"`
   (loopback results carry `source: "loopback"` for symmetry).

**Security posture.** The fallback rides the **same per-project content-consent gate**
as the other content ops (`read_file`, `export_compiled`, …): it exposes build
feedback over the project text, so an ungranted-but-paired agent cannot even learn
whether a project compiles. It is **diagnostics-only** — PDF bytes remain
`export_compiled`'s separate, blob-channel path. Both sides bound the diagnostics
(the browser slices to `COMPILE_MAX_DIAGNOSTICS` and caps each message; the kernel
schema re-bounds the array + per-message length) so a hostile/huge list cannot
overflow the control-RPC record cap or flood a downstream model. It is **fail-closed**:
a refusal, a parse failure, or a control-RPC timeout (the default
`CONTROL_RPC_TIMEOUT_MS`, ~10s) becomes an honest one-line error, never a stack and
never a silent "compiled". A large project's preview compile may exceed that timeout
on a slow machine — agents should treat a timeout as "unknown", not as a compile
failure, and the timeout is **not** raised to the open_project level (there is no
human-consent wait here).

**F5 — agent validation path.** This gives MCP agents a validation path **without a
server compiler**: after `propose_files` / `propose_edit`, an agent **should** call
`compile` to confirm the change set type-checks **before** asking the human to Accept.
The browser-compile result also carries room liveness (ADR-0024 §1), so the agent
knows whether a browser is actually watching.

Cross-references: ADR-0020 / ADR-0021 (the MCP kernel + the control mailbox / pairing
posture this RPC rides), ADR-0024 (honest liveness on every per-project result).

## Consequences

- The browser/worker compile is unchanged and stays fail-closed; package
  resolution is opt-in and, for now, only reachable with an explicit resolver.
- The two true forks (Architect-flagged) get **safe defaults** under autonomy:
  **package integrity** → require an expected hash and fail closed when absent
  (broaden only once a canonical Universe checksum source is confirmed);
  **multi-tenant isolation substrate** → ship single-tenant self-hosted compile
  only; do not offer public multi-tenant compile until the operator picks the
  platform. Either fork, if it must change behavior, gets its own ADR.
