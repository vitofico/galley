# @galley/compiler

Framework-agnostic wrapper around [`typst.ts`](https://github.com/Myriad-Dreamin/typst.ts).
Turns a Typst source string into diagnostics, rendered pages, or a PDF.

**Status:** implemented (**M0**).

## Public surface

```ts
const compiler = connectCompilerWorker(createWorker, assets);  // loads WASM + fonts
await compiler.check(input);    // { ok, diagnostics, pageCount } — agent loop
await compiler.render(input);   // SVG pages — live preview
await compiler.export(input);   // PDF bytes — download
compiler.cancel();              // drop in-flight job
compiler.dispose();             // tear down worker
```

`input` is a `CompileInput` — a bare Typst source string or a multi-file `ProjectInput`.

## Design rules

- **Runs off the UI thread.** The WASM compile happens in a **Web Worker** from
  day one (ADR-0001). Live preview and agent scratch compiles must never block
  typing.
- **`check` ≠ `render`.** Diagnostics-only compiles are cheap and run every agent
  iteration; preview rendering only happens for the human.
- **No framework imports.** Reusable server-side later (roadmap: server compile).
- **Fonts are bundled**, not fetched from a CDN at runtime (see `docs/compiler.md`).

See [`docs/compiler.md`](../../docs/compiler.md) for the worker protocol,
diagnostics normalization, and font strategy.
