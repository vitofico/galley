# AGENTS.md — rules for AI agents working ON Galley

You are an agentic coding assistant helping build Galley. Read this and the
[`docs/`](docs) set before writing code. This file governs how you work in this
repo; the design lives in `docs/`.

> See the [CHANGELOG](CHANGELOG.md) for what's built and
> [`docs/roadmap.md`](docs/roadmap.md) for what's next. The invariants below
> are load-bearing; don't violate them without a new ADR. If a task is
> genuinely ambiguous or conflicts with an invariant, **stop and ask.**

## What Galley is (one paragraph)

An open-source, local-first, model-agnostic, AI-native document workspace built
on Typst. The product is a tight **edit → compile → read diagnostics →
self-correct** agent loop over a Typst document, with a mandatory human Accept/
Reject step. See [`docs/vision.md`](docs/vision.md).

## Start here

| Read | For |
| --- | --- |
| [`docs/vision.md`](docs/vision.md) | Why, principles, honest definitions, non-goals |
| [`docs/architecture.md`](docs/architecture.md) | Package boundaries, worker model, source-of-truth rules |
| [`docs/roadmap.md`](docs/roadmap.md) | What's built, what's gated on config, future directions |
| [`docs/agent-loop.md`](docs/agent-loop.md) | The core loop (the thing you're building) |
| [`docs/editing-and-diff.md`](docs/editing-and-diff.md) | Search/replace + Accept/Reject |
| [`docs/compiler.md`](docs/compiler.md) · [`docs/providers.md`](docs/providers.md) | Compile + model abstraction |
| [`docs/decisions/`](docs/decisions) | Why key decisions were made (ADRs) |

## Non-negotiable invariants

These are architecture, not preference. Don't violate them without a new ADR.

1. **Human-in-the-loop is mandatory.** No in-app agent edit reaches the live
   document without an explicit user **Accept**; the in-app loop never auto-applies.
   (External MCP agents may be granted opt-in, off-by-default, signed + checkpointed
   + revertable auto-accept that drives this same Accept path —
   [ADR-0023](docs/decisions/ADR-0023-mcp-auto-accept-provenance.md).)
2. **Scratch isolation.** The agent loop operates on a scratch copy and has **no
   handle to live document state.** Concurrent user typing must never corrupt a
   run.
3. **Conflict-aware Accept.** On Accept, re-match edit blocks against *current*
   live source; surface conflicts, never clobber.
4. **Framework-agnostic core.** `@galley/compiler` and `@galley/agent` must not
   import React/DOM/app-state. `@galley/shared` is **types only.**
5. **Compile off the UI thread.** Typst runs in a Web Worker.
6. **Provider abstraction.** The agent loop depends only on `LanguageModelClient`,
   never on the Vercel AI SDK directly.
7. **Honest slogans.** Local-first and model-agnostic have edges (remote model =
   remote data; capability-gated providers). Reflect them in the UI.

## Package boundaries (enforced)

```
shared  → (nothing)
compiler → shared            # + typst.ts; no React
agent    → shared            # + AI SDK behind adapter; no React, no typst.ts
web      → shared, compiler, agent   # the only React package; owns live state
proxy    → shared            # separate Node runtime; thin/stateless; not imported by web
```

The proxy is **optional and thin** (ADR-0004): inject the cloud API key
server-side and stream the response through. Named upstreams only (no
client-supplied URLs → no SSRF); never log bodies or keys; stateless.

## Working conventions

- **TypeScript-first** monorepo, **pnpm** workspaces. Node ≥ 20.
- Keep `shared` to literal cross-package types. If a type needs a dependency,
  it belongs in a concrete package.
- **Test the loop with fakes.** `runAgent` takes an injected model + compiler;
  core tests use a fake model and fake compiler — no real provider or WASM.
- **Never log secrets.** `apiKey` is redacted everywhere; it never enters the
  `AgentEvent` stream, logs, or telemetry.
- When you change a cross-package type or a contract, update the matching doc in
  `docs/` in the same change.
- Match the surrounding code's style; don't introduce a formatter/lint config
  churn outside your task.

## Attribution

Write commits, PRs, and docs as the human author. **Do not** add "Generated with
Claude" / "Co-Authored-By: Claude" / AI-assisted boilerplate to any artifact in
this repo.

## When unsure

If a request is ambiguous, conflicts with an invariant, or pulls in scope
beyond the task — **stop and ask** rather than guessing. Pragmatic minimalism:
the simplest thing that makes the loop feel good.
