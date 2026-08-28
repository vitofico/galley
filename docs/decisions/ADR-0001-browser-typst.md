# ADR-0001 — Compile Typst in the browser via typst.ts WASM, in a Web Worker

- **Status:** Accepted
- **Date:** 2026-06-06
- **Deciders:** Galley founding work

## Context

Galley's two headline properties — *local-first* and *agentic* — both hinge on
where and how fast Typst compiles. The compile must be (a) local, to keep the
document on the user's machine, and (b) fast and structured, to make the
edit→compile→correct loop cheap. Typst is a Rust compiler with `comemo`
incremental compilation and structured diagnostics, and ships a WASM build via
[`typst.ts`](https://github.com/Myriad-Dreamin/typst.ts).

Two streams of compiles run concurrently: the **live preview** (recompiles on
debounced keystrokes) and the **agent loop** (`check()` per iteration against a
scratch copy). On the main thread these contend and would jank typing / freeze
the UI.

## Decision

1. Compile Typst **in the browser** using `typst.ts` (WASM). No server compile in
   the MVP.
2. Run the WASM compile **in a Web Worker from day one** (M0), behind the
   `@galley/compiler` package, exposing `check()` / `render()` / `export()` as
   async messages with **cancellation** and **timeout/restart**.
3. **Bundle** the WASM module and a small default font set as local assets — no
   runtime CDN/GitHub font fetches.

## Consequences

- ✅ Document and compilation never leave the machine (the model may, separately —
  see ADR-0002 / providers).
- ✅ Live preview and agent compiles don't block the UI.
- ✅ `compiler` stays framework-agnostic and reusable server-side later.
- ⚠️ WASM module + fonts must load before the first compile — requires explicit
  async init and a visible loading state (a known gotcha if left late).
- ⚠️ Span/offset → line-column mapping (UTF-8 byte offsets → UTF-16 JS indices)
  needs an early spike and tests; easy to off-by-one.
- ⚠️ Large documents / images / packages can make compiles non-trivial; the
  "compile is always cheap" assumption holds for warm, small docs, not all.

## Language choice: TypeScript for the app (not Rust or Python)

A recurring question: Typst is Rust and has equally-performant Rust and Python
bindings — why is the app TypeScript?

**The compiler's speed is a constant, not a variable.** Typst is one Rust crate
exposed through several bindings — `typst.ts` (JS/WASM), `typst` on PyPI (PyO3),
and the native CLI/crate. Compilation runs at the same Rust speed in all of them;
the binding language never changes compile speed. So performance does not decide
the app language — **where the code runs** does.

**The MVP runs in the browser** (local-first = compile on the user's machine), and
the browser runs JS/WASM:

- **Rust → WASM for the whole app** is possible, but the editor (CodeMirror 6) and
  the model layer (Vercel AI SDK) are JS-native with no mature Rust-WASM
  equivalents; you would interop with them across a `wasm-bindgen` boundary — i.e.
  back to JS anyway — for glue code that is not CPU-bound. The one CPU-bound part
  (the compile) is already Rust via `typst.ts`. ~80% of the app is UI/orchestration
  where Rust's strengths do not pay and its costs (web-frontend ecosystem, OSS
  contributor pool) do.
- **Python** has no viable in-browser runtime (Pyodide is too heavy for a snappy
  editor). The `typst` PyPI binding is equally fast but runs **server-side**, which
  would force a server compile — abandoning local-first and adding a network
  round-trip per agent iteration, the exact latency the thesis avoids.

**Where Rust and Python do belong** (and the architecture keeps open): native
server-side compile for heavy projects and a possible Tauri desktop core (Rust);
the heavy server-side AI/data layer — retrieval, embeddings, citations (Python,
which can also use the `typst` binding for server compile). The pattern: **Rust
for native/compute, Python for server-side ML/data, TypeScript for the browser app
and the fast local loop** — chosen per runtime, since compile speed is identical
everywhere. The framework-agnostic `compiler`/`agent` packages exist so these
services can be added without rewriting the core. See
[`server-and-collaboration.md`](../server-and-collaboration.md).

## Alternatives considered

- **Server-side compile (typst binary).** Rejected for MVP: breaks local-first,
  adds infra. Kept as a roadmap enhancement for heavy projects.
- **Compile on the main thread.** Rejected: contention janks typing and freezes
  the UI during agent runs.
- **Whole app in Rust (→ WASM) or Python (server).** Rejected — see "Language
  choice" above. Compile speed is equal across bindings; runtime environment, not
  performance, dictates the app language.
