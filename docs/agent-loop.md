# The Agent Loop

> The core of Galley. The state machine, the tools, the iteration/error/cancel
> rules, and the event stream. Get this right and the thesis holds.

## Thesis

Typst's fast, structured compile lets the agent **verify its own work** before a
human sees it. The loop runs edits against a scratch copy, reads the compiler's
diagnostics, and self-corrects until the document compiles cleanly — then stops
and asks the human to Accept or Reject.

## Tools exposed to the model

| Tool | Signature | Effect |
| --- | --- | --- |
| `read_document` | `() → string` | Returns the current scratch source **with line numbers** (for the model's reference; edits use search/replace, not line numbers). |
| `propose_edit` | `(edits: EditBlock[]) → CheckResult` | Applies search/replace blocks to the **scratch copy**, then auto-runs `check()` and returns its diagnostics. The model's main lever. |
| `compile` | `() → CheckResult` | Compiles the current scratch copy for diagnostics + page count, without editing. |

`EditBlock` = `{ search, replace }` (unique exact match). See
[`editing-and-diff.md`](editing-and-diff.md) for the full apply contract,
including failure handling — apply failures are returned to the model as
structured `EditFailure`s, not exceptions.

### Project-scoped read-only tools (seam-gated, default OFF)

When a run is given an optional **project seam** (the multi-file editor and the
MCP control surface pass one; a bare single-document run does not), the loop
additionally offers read-only tools over the *whole project*, appended after the
core trio:

| Tool | Signature | Effect |
| --- | --- | --- |
| `list_files` | `() → string` | List the project's file paths. |
| `read_file` | `(path) → string` | Read one project file by path (line-numbered, size-capped). |
| `search_project` | `(query) → string` | Literal, case-insensitive substring search across every file. |
| `list_bibliography` | `() → string` | Compact, de-duplicated, globally-uniquely-keyed list of every `.bib` entry (`key — authors (year). title. doi/url`). **Prefer it over `read_file` for a bibliography** — a large `.bib` usually exceeds `read_file`'s cap and is silently truncated, whereas this returns one bounded line per entry. Only BibTeX `.bib` is covered, **not** Hayagriva `.yml`. |

These are **default OFF**: without the seam they are neither advertised nor
runnable, and the request payload is byte-for-byte the legacy core-trio set. Both
the parsing *work* and the *output* are bounded by explicit caps (a tool result
can never blow the model context), and every echoed field — a peer-authored path,
a `.bib` cite key or title — is escaped, so it cannot fake tool-output lines.

> **Note:** the loop's per-iteration feedback is **textual** — diagnostics and
> page count; the loop never consumes the rendered output. *Visual* layout
> judgment (sending a render thumbnail to a vision-capable model) exists as a
> separate, capability-gated feature outside the loop. Compile-clean is the
> loop's contract.

## State machine

```
        ┌──────────┐
        │  START   │  snapshot base {source, revision, hash}; iter = 0
        └────┬─────┘
             ▼
        ┌──────────┐   model may call read_document / compile freely here
        │  THINK   │◄────────────────────────────┐
        └────┬─────┘                              │
             │ model calls propose_edit           │
             ▼                                    │
        ┌──────────┐                              │
        │  APPLY   │  applyEdits(scratch, blocks) │
        └────┬─────┘                              │
        ok? ─┤── fail ──► return EditFailure[] to model ─┐
             │ ok                                        │
             ▼                                           │
        ┌──────────┐                                     │
        │ COMPILE  │  compiler.check(scratch)            │
        └────┬─────┘                                     │
             ▼                                           │
        errors? ──yes── iter<max? ──yes── iter++ ───────►┘ (feed diagnostics back)
             │                  └─ no ─► STOP (max_iters_reached)
             │ no errors
             ▼
        ┌──────────┐
        │   DONE   │  outcome = compiled_clean; emit accumulated diff
        └──────────┘
```

### Stop conditions (outcomes)

| Outcome | When |
| --- | --- |
| `compiled_clean` | scratch `check()` returns no errors |
| `max_iters_reached` | hit `maxIters` (default **5**) still with errors — stop anyway, present what we have, warn the user |
| `no_edits` | model answered without proposing any edit (e.g. a question) — present text, no diff |
| `cancelled` | user cancelled, or new run started, or `AbortSignal` fired |
| `error` | model/transport/compiler error the loop couldn't recover from |

Warnings (not errors) do **not** block `compiled_clean`; they are surfaced to the
human in the diff review.

## Loop rules

- **Scratch only.** The loop holds a scratch string seeded from the base
  snapshot. It has no handle to live document state. (Architecture invariant —
  see [`architecture.md`](architecture.md).)
- **Never auto-apply.** Reaching `compiled_clean` does **not** modify the live
  document. It produces a diff for human review.
- **Bounded.** `maxIters` caps self-correction (default `DEFAULT_MAX_ITERS`,
  currently 5).
- **Cancellable.** An `AbortSignal` (new request, user cancel, navigation)
  cleanly stops the run, aborts any in-flight model stream and compile, and emits
  `run_finished` with `cancelled`.
- **Timeouts.** Each model call and each compile has a timeout; a hung compile
  terminates/restarts the worker. A timeout becomes a normal error fed back to
  the model (if iterations remain) or stops the run.
- **Deterministic core, injected edges.** `runAgent` takes an injected
  `LanguageModelClient` and `AgentCompiler`, so the loop is unit-testable with a
  **fake model + fake compiler** — no real provider or WASM needed in core tests.
  This is a required testing seam, not a nicety.

## Context assembly

Each run assembles, at minimum:

- The current scratch **source** (line-numbered via `read_document`).
- The **user request**.
- On revision turns: the **diagnostics** from the last `check()`, so the model
  corrects against concrete errors.

By default the whole document is sent. For large documents a run can opt into
**retrieval mode** (`RunAgentOptions.context = { mode: "retrieval" }`, active
only above a size threshold): `read_document` then returns a BM25-selected view
with true full-document line numbers and explicit omitted-line markers, pinning
chunks that overlap the latest compile errors so self-correction always sees
the erroring region. Edits still apply against the full scratch — retrieval
only governs what the model *reads*.

## Event stream

`runAgent` is an `AsyncGenerator<AgentEvent>`. We stream **progress, tool calls,
diagnostics, and assistant text** — *not* raw model "reasoning," which not all
providers expose. Event types (`@galley/shared/agent-events.ts`):

| Event | Meaning |
| --- | --- |
| `run_started` | run id + base revision |
| `assistant_text` | incremental assistant message chunk |
| `tool_call` | model invoked a tool (name + args) |
| `tool_result` | tool returned (short summary) |
| `iteration` | entering self-correction iteration *i* of *max* |
| `diagnostics` | latest compile diagnostics |
| `edit_applied` / `edit_failed` | scratch edit succeeded / failed (with reasons) |
| `run_finished` | terminal, carries the `AgentRunOutcome` |
| `error` | unrecoverable error |

The UI renders these as a live, legible trace so the user trusts what the agent
is doing — which is most of why streaming matters here.
