# Architecture

> Package boundaries, data flow, the worker model, and the source-of-truth
> rules. Read [`vision.md`](vision.md) first.

## Layers

```
┌───────────────────────────────────────────────────────────────┐
│ apps/web  (React + Vite)                                       │
│  • owns LIVE document state (the single source of truth)       │
│  • editor (CodeMirror 6), preview pane, agent panel, diff UI   │
│  • orchestrates: keystrokes→compiler, requests→agent           │
└───────────────┬───────────────────────────┬───────────────────┘
                │                           │
        injects compiler            drives agent run
                │                           │
┌───────────────▼─────────────┐ ┌───────────▼───────────────────┐
│ @galley/compiler            │ │ @galley/agent                 │
│  • createCompiler()         │ │  • runAgent() → AgentEvents   │
│  • check/render/export      │ │  • applyEdits() (search/repl) │
│  • runs typst.ts in a       │ │  • LanguageModelClient        │
│    Web Worker               │ │    (wraps Vercel AI SDK)      │
└───────────────┬─────────────┘ └───────────┬───────────────────┘
                │                           │
                └─────────────┬─────────────┘
                              ▼
                     @galley/shared (types only)
              Diagnostic · CheckResult · EditBlock ·
              AgentEvent · ProviderConfig · DocumentSnapshot
```

### Dependency rules

- `shared` depends on nothing. Types only.
- `compiler` depends only on `shared` (+ typst.ts). **No React, no app state.**
- `agent` depends only on `shared`. **No React, no DOM, no typst.ts** — it
  receives a compiler via an injected `AgentCompiler` interface and a model via
  an injected `LanguageModelClient`.
- `web` depends on `shared`, `compiler`, `agent` and is the only package allowed
  to import React. It owns live document state.
- `proxy` (`apps/proxy`) depends only on `shared` (for the wire-contract types).
  It is a **separate Node runtime**, not imported by the browser packages. See
  "Model transport" below.

Why so strict: `compiler` and `agent` are framework-agnostic so they can run
**server-side without a rewrite** — the optional compile service
([`server-side-compile.md`](server-side-compile.md)) runs the same engine in
Node. One caveat: `shared` stays *only* literal cross-package types, or it
becomes a dumping ground.

## The worker model

`typst.ts` compilation runs in a **Web Worker**, never on the UI thread. This is
load-bearing, not an optimization:

- The **live preview** recompiles on (debounced) every keystroke.
- An **agent run** issues its own `check()` compiles against the scratch copy.
- These two streams of compiles contend. On the main thread they would jank
  typing and freeze the UI during agent runs.

So `createCompiler()` spins up a worker, loads the WASM module + fonts inside it,
and exposes `check/render/export` as async messages. The worker supports
**cancellation** (drop a stale preview job when newer input arrives) and can be
**terminated/restarted** on timeout. See [`compiler.md`](compiler.md) for the
message protocol. ADR: [`decisions/ADR-0001-browser-typst.md`](decisions/ADR-0001-browser-typst.md).

```
 main thread                         worker thread
 ───────────                         ─────────────
 keystroke ─debounce─► render(src) ──► typst compile ──► SVG pages ─► preview
 agent loop ─────────► check(src)  ──► typst compile ──► diagnostics ─► loop
                       cancel()    ──► abort current job
```

## Model transport: direct vs proxy

The document is always edited and compiled **client-side**. The only thing that
may leave the browser is a **model API call**, and even that is configurable per
provider (`ProviderConfig.transport`, a discriminated union in
[`shared/provider.ts`]):

```
 direct mode (local models, CORS-friendly endpoints)
   browser ──────────────────────────────► provider        key: client-side

 proxy mode (cloud keys you don't want in the browser, CORS-blocked endpoints)
   browser ──► @galley/proxy ─────────────► provider        key: server-side
               (thin, stateless,
                self-hosted/localhost,
                named upstreams only)
```

- The proxy is **optional and thin** (ADR-0004): it injects the key from env and
  streams the response back verbatim. No state, no document storage.
- It forwards only to **named, env-configured upstreams** (selected by the
  `x-galley-upstream` header), never a client-supplied URL — no SSRF.
- The client ⇄ proxy boundary is a **typed contract** in `@galley/shared`
  (`proxy.ts`): the same "interfaces are the API" principle that lets the
  framework-agnostic packages run server-side.
- **Privacy:** in `proxy` mode with a cloud model, document context transits the
  proxy host (run it locally to keep it yours) and then the provider (unavoidable
  for any cloud model). Local models keep everything on-device. The UI must
  reflect this — see [`providers.md`](providers.md), [`vision.md`](vision.md).

[`shared/provider.ts`]: ../packages/shared/src/provider.ts

## Source of truth & state ownership

- **The live document is owned by `apps/web`** and is the single source of truth.
  It is mutated in exactly two ways: (a) the user typing in the editor, (b) the
  user clicking **Accept** on an agent diff.
- **The agent works on a scratch copy**, seeded from a `DocumentSnapshot`
  (`source` + `revision` + `hash`) taken at run start. The agent loop in
  `@galley/agent` has no reference to live state at all — it cannot, by
  construction, corrupt it.
- **Accept is conflict-aware.** When the user accepts, the app checks whether the
  live document still matches the snapshot the run started from (`baseRevision` /
  `baseHash`). If the user kept typing, the search/replace blocks are re-applied
  against current source; any block that no longer matches uniquely is reported
  as a conflict rather than applied blindly. See
  [`editing-and-diff.md`](editing-and-diff.md).

## Data flow: an agent request end-to-end

1. User types a request in the agent panel.
2. `web` snapshots the live document → `{ source, revision, hash }` and calls
   `runAgent({ userRequest, baseSource, baseRevision, model, compiler })`.
3. `agent` streams `AgentEvent`s; `web` renders them (assistant text, tool calls,
   iteration counter, diagnostics).
4. Internally the loop: `read_document` → model proposes `propose_edit` →
   `applyEdits` to scratch → `compiler.check(scratch)` → feed diagnostics back →
   repeat until clean or `MAX_ITERS`.
5. On finish, `web` computes a unified diff (base → final scratch) and shows the
   **diff review UI**.
6. **Accept** → re-apply blocks to *current* live source (conflict-aware) →
   update live state → trigger a `render()`. **Reject** → discard the scratch.

## State management (web)

`apps/web` uses plain React state (hooks + reducers; no external store). The
load-bearing constraint: **live document state** and **in-flight agent run
state** (the scratch + event log) are kept strictly separate — they have
different lifetimes and must never alias.

## Beyond the core

The layers above are the whole story for a single user in a browser. The
optional pieces — real-time collaboration (`packages/collab` + the sync relay),
the auth seam (`packages/auth`), persistence/versioning
(`packages/persistence`), the server compile service, and the MCP surface —
compose on top without changing these rules. See
[`server-and-collaboration.md`](server-and-collaboration.md) and
[`server-side-compile.md`](server-side-compile.md). One deliberate
accommodation in the core: **search/replace + conflict-aware Accept** degrades
gracefully under concurrent (CRDT) editing — a diff may be stale by the time it
is accepted, and search/replace fails safe where line numbers would silently
corrupt.
