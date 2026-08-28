# @galley/agent

The agent loop, its tools, and the model-provider abstraction. Framework-agnostic.

**Status:** implemented (**M1–M2**).

## What it does

Given a user request and a base document, it drives a tool-using model through
an **edit → compile → read diagnostics → revise** loop against a **scratch copy**
until the document compiles cleanly or a max-iteration cap is hit — then stops
and hands the accumulated diff back for the human to Accept or Reject.

```ts
for await (const event of runAgent({ userRequest, baseSource, baseRevision, model, compiler })) {
  // event: AgentEvent — render progress, tool calls, diagnostics, text
}
```

## Design rules

- **The Vercel AI SDK lives behind `LanguageModelClient`** (ADR-0002). The loop
  never imports `ai` directly, so providers are swappable and the loop is
  testable with a fake model.
- **Compiler is injected** (`AgentCompiler`), so the loop is testable with a fake
  compiler and never depends on typst.ts.
- **Scratch-only, never auto-apply.** The loop cannot mutate live document state.
- **Capability-gated providers.** `probe()` before first use; do not assume
  streaming/tool-calling support.

See [`docs/agent-loop.md`](../../docs/agent-loop.md) for the state machine and
[`docs/providers.md`](../../docs/providers.md) for the provider abstraction.
