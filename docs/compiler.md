# Compiler (`@galley/compiler`)

> typst.ts init, the Web Worker protocol, font strategy, diagnostics
> normalization, and the check/render/export split.

## Responsibility

Turn a Typst **source string** into one of three outputs:

- `check(source) → CheckResult` — diagnostics + page count. **Cheap; the agent
  loop's per-iteration call.**
- `render(source) → RenderResult` — SVG pages for the live preview.
- `export(source) → ExportResult` — PDF bytes for download.

Nothing else. No React, no app state, no document ownership. (ADR:
[`decisions/ADR-0001-browser-typst.md`](decisions/ADR-0001-browser-typst.md).)

## Why `check` is separate from `render`

The agent loop runs a compile **every iteration** but only needs diagnostics and
page count — it never looks at the rendered preview. Rendering SVG for every
agent iteration would waste work and slow the loop. So `check()` skips visual
output; `render()` is only invoked for the human.

## The Web Worker model

The actual WASM compile runs in a **Web Worker**. Live preview compiles and
agent `check()` compiles otherwise contend on the main thread and jank typing /
freeze the UI.

### Lifecycle

```
createCompiler(opts)
  └─ spawn Worker
  └─ load typst WASM module        ◄─ async, can be slow on first load
  └─ load default fonts            ◄─ async
  └─ resolve Compiler              ◄─ callers MUST show a loading state until here
```

> typst.ts needs its WASM module *and* fonts loaded before the first compile —
> `createCompiler` resolves only when both are ready, and callers show a
> loading state until then.

### Message protocol

`main ⇄ worker`, request/response keyed by a job id
(`packages/compiler/src/worker-protocol.ts`). `input` is a `CompileInput`: a
bare source string or a multi-file `ProjectInput`.

| Request | Response |
| --- | --- |
| `init { wasmUrl, rendererUrl, fontAssetPrefix? }` | `ready` / `init_error` |
| `check { jobId, input }` | `check_result { jobId, result }` |
| `render { jobId, input, sourceMap? }` | `render_result { jobId, result }` |
| `export { jobId, input }` | `export_result { jobId, result }` |
| `cancel { jobId }` | (drops the job; no result emitted) |

- **Cancellation:** when newer input arrives, `cancel()` the stale job so the
  preview doesn't render an out-of-date document.
- **Timeout / hang:** a compile that exceeds its budget terminates and restarts
  the worker; the caller gets an error result.
- **Concurrency:** the worker processes one job at a time; the main thread is
  responsible for debouncing preview requests and for not interleaving a live
  render with an agent's scratch check in a way that confuses results (each call
  carries its own source, so results are pure functions of input).

## Diagnostics normalization

typst.ts surfaces structured diagnostics, but the exact shape is a typst.ts
implementation detail. `@galley/compiler` **normalizes** them into the
`Diagnostic` type (`@galley/shared/diagnostics.ts`):

- `severity`: `"error" | "warning"`.
- `message`: the compiler's human-readable text.
- `span`: normalized to `{ offset, endOffset, start:{line,col}, end:{line,col} }`
  with **1-based** line/column in **UTF-16** units (to match CodeMirror and JS
  strings). Offsets are canonical; line/column are derived.
- `hints`: compiler hints if present.

`@galley/compiler` also post-processes normalized diagnostics to **append a
human hint** when typst reports an image-decode failure. typst's raw message
(e.g. `"failed to parse image"`) does not say WHICH formats `image()` accepts —
the supported set is **PNG, JPEG, GIF, SVG**; PDF, EPS, TIFF, WebP and AVIF are
not decodable by `image()` and must be converted first. The hint is purely
additive (the original message is preserved) and lives in `diagnostics.ts`
(`enrichImageHint`).

> Typst spans are byte offsets into UTF-8; the mapping to JS string indices is
> the kind of thing that silently off-by-ones. The byte-offset → UTF-16
> line/column mapping lives in `offset-map.ts` and is pinned by focused tests.

## Font strategy

- **A small default font set is bundled** as local assets; fonts are **not**
  fetched from GitHub/CDN at runtime. Remote font fetches would add a network
  dependency that breaks the local-first promise and the first-compile latency.
- The WASM compiler asset ships locally too.

## Preview format

- **Live preview:** SVG pages (or canvas) from `render()`. SVG is crisp and
  cheap to update.
- **Export:** PDF bytes via `export()`, for download. (PNG export in the app
  rasterizes the rendered SVG; the compiler itself emits PDF.) PDF is never
  shown in the live preview — SVG is the interactive path, PDF is the artifact.

## Testing

- The agent package depends on an injected `AgentCompiler` (just `check`), so the
  agent loop is tested with a **fake compiler**.
- `@galley/compiler` itself gets focused tests for diagnostics normalization and
  the span/offset mapping (the parts most likely to be subtly wrong), plus a
  smoke test that a known-bad document yields the expected error and a known-good
  one yields a page count.
