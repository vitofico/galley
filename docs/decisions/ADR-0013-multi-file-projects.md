# ADR-0013 — Multi-file projects (roadmap #2), core-first behind `?project=1`

- **Status:** Accepted (building, slice-by-slice)
- **Supersedes / relates to:** ADR-0001 (browser typst), ADR-0006 (collab phase 1),
  ADR-0012 (cross-peer attribution). Enables the "virtual file system" prerequisite
  the roadmap calls out for Typst Universe packages/templates.

## Context

Today Galley compiles a single `main.typ` source string. The roadmap's item #2
(multi-file projects, packages & templates) needs a **virtual file system**: the
editor must hold several `.typ` files, `#import`s between them must resolve, and
diagnostics must route to the file they occurred in. This is also the foundation
for Universe package resolution (deferred) and the bundled examples gallery (the
parallel-built Examples picker is its single-file on-ramp).

The work must not regress the shipped product. The single-file path and the
`?collab=1` collaboration path stay **byte-for-byte unchanged**; everything here
lands behind a new `?project=1` flag, **default OFF**.

### De-risking already confirmed (against real typst.ts 0.7)

- **Virtual `#import` resolution.** `compiler.addSource(path, source)` loads a
  file into typst.ts's VFS; `compile({ mainFilePath })` then resolves
  `#import "/lib.typ"` etc. between loaded files — no server needed.
- **Per-compile purity.** `compiler.resetShadow()` clears all previously-added
  sources/shadows, so a project compile is stale-free even though the typst.ts
  compiler instance is long-lived. (It is independent of `reset()`, which only
  drops caches.) We call `resetShadow()` then re-add every file each compile, and
  pass `inputs: {}` so `sys.inputs` can't leak across compiles either.
- **Cross-file diagnostics carry a `path`.** typst.ts's `full` diagnostics are
  `{ package, path, severity, range, message }` — each names the file it occurred
  in (and `package` is non-empty only for resolved-package diagnostics). That lets
  us map every diagnostic against its own file's source.

## Decisions

### Compile contract (slice 2–3)

- `@galley/shared` gains the **types** only (it stays logic/dependency-free):
  `ProjectFile { path, text }`, `ProjectInput { kind:"project", files, main }`,
  `CompileInput = string | ProjectInput`, and an `isProjectInput` guard. The
  `Diagnostic` type gains an optional `path?: string` (absent for single-file).
- `normalizeProjectDiagnostics(raw, filesByPath)` lives in **`@galley/compiler`**,
  beside `normalizeDiagnostics`. **Deviation from the original sketch** (which put
  it in `@galley/shared`): it parses typst.ts's raw diagnostic shape and needs
  `SourceMapper` — both are typst.ts coupling the codebase deliberately confines
  to the compiler package so the agent/web never see typst.ts internals. Keeping
  it here also avoids moving `SourceMapper` and touching the green single-file
  path. Each diagnostic is mapped against its own file's source (offsets differ
  per file); package/unresolved diagnostics keep their message but get no span.
- `TypstEngine.check/render/export` are **overloaded** to accept
  `string | ProjectInput`. The string path is literally unchanged. The project
  path does `resetShadow()` → `addSource` each file → `compile({ mainFilePath:
  main, inputs:{} })` → `normalizeProjectDiagnostics`.

### Project CRDT model (slice 4) — one Y.Doc, files keyed by stable id

`CollabProject` (in `@galley/collab`, yjs-only) wraps **one** `Y.Doc`:

- `Y.Map fileMeta`: `fileId → { path, deleted }`.
- `Y.Map fileTexts`: `fileId → Y.Text`. A deleted file's `Y.Text` is **retained**
  (only `meta.deleted` flips), so edit history and per-author attribution survive
  delete and even un-delete.
- `Y.Map projectMeta`: `{ mainFileId }`.

Files are keyed by a **stable `fileId`**, not by path — path is just metadata.
Rename is a metadata write; it therefore preserves the file's `Y.Text` history and
its attribution (the whole point of ADR-0012 carrying over to projects). Duplicate
**live** paths are a conflict the core detects (two peers can concurrently create
the same path); the UI blocks compile until it's resolved rather than silently
picking a winner.

One Y.Doc (not one per file) keeps create/rename/delete/setMain atomic and lets a
single sync connection + single IndexedDB store carry the whole project, reusing
the Phase 2/3 transport, persistence, and attribution machinery unchanged.

### Later slices (5–9)

- 5: project session + `y-indexeddb` persistence + sync adapter (reuse Phase 2/2e).
- 6–7: minimal `?project=1` web shell (file list, active-file editor, per-file
  diagnostics) and file-ops UI (create/rename/delete/set-main; duplicate-path
  block).
- 8: active-file agent — whole-project compile context, Accept via the
  agent-as-distinct-peer machinery (ADR-0012).
- 9: package-resolver seam — **offline FAKE registry first**; the browser compile
  path never fetches arbitrary network. Real, sandboxed Universe fetching is
  gated on server-side compile (roadmap #3) and gets its own ADR + security review.

## Consequences

- The product is untouched until `?project=1` is set; every safety gate (green
  before commit, flag-gated, fail-safe) holds.
- typst.ts coupling stays inside `@galley/compiler`; `@galley/shared` stays pure.
- Attribution & history survive rename/delete because identity is the `fileId`,
  not the path — at the cost of a tiny indirection (path lookups go through
  `fileMeta`) and retained tombstoned `Y.Text`s (acceptable; documents are small).
- Package resolution and server-side compile remain explicitly out of scope here.
