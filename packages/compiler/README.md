# @galley/compiler

Framework-agnostic wrapper around [`typst.ts`](https://github.com/Myriad-Dreamin/typst.ts).
Turns a Typst source string or project input (including resolved binary assets)
into diagnostics, rendered pages, or a PDF.

Implemented: browser worker client, reusable Node engine and optional remote
compiler client.

## Public surface

```ts
const compiler = await connectCompilerWorker(createWorker, assets); // loads WASM + fonts
await compiler.check(input); // { ok, diagnostics, pageCount } — agent loop
await compiler.render(input); // SVG pages — live preview
await compiler.export(input); // PDF bytes — download
compiler.cancel(); // drop in-flight job
compiler.dispose(); // tear down worker
```

`input` is a `CompileInput` — a bare Typst source string or a multi-file `ProjectInput`.

## Design rules

- **Browser compilation runs off the UI thread.** The worker client runs WASM in
  a **Web Worker** (ADR-0001). Live preview and agent scratch compiles must never block
  typing.
- **`check` ≠ `render`.** Diagnostics-only compiles are cheap and run every agent
  iteration; preview rendering only happens for the human.
- **No framework imports.** The Node engine is used by the optional
  [`compile service`](../../docs/server-side-compile.md); the package does not own
  document state or review/Accept policy.
- **Fonts are bundled**, not fetched from a CDN at runtime (see
  [compiler documentation](../../docs/compiler.md)).

See [`docs/compiler.md`](../../docs/compiler.md) for the worker protocol,
diagnostics normalization, and font strategy.
