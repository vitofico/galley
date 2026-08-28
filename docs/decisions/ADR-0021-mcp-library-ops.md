# ADR-0021 — MCP library/version operations: the browser-mediated Agent Access control room

- **Status:** Proposed (Architect-GPT designed, 2026-06-10).
  Implements roadmap **#16.3**; ships only in slices, after explicit review.
- **Progress:** #16.3a kernel core LANDED (control mailbox in @galley/collab,
  kernel `--control-room` mode + list/open tools, fake-responder reference
  contract in apps/mcp); the browser Agent Access UI/responder slice is pending.
- **Scope:** how an EXTERNAL agent (via the apps/mcp kernel) lists/opens/creates
  projects and reads/creates named versions, when all of that authority lives in
  **browser IndexedDB** (IdbProjectStore / y-indexeddb / IdbVersionStore).
  Networked/authenticated MCP stays **#16.4** (gated on E5).

## Context

The ADR-0020 kernel joins ONE project's Yjs room as a peer and exposes
read+propose tools; the browser is the authority for the project registry, CRDT
persistence, and named versions — none of which a room peer can reach. #16.3
("full project control") therefore has an authority mismatch: the kernel speaks
to a sync relay; the stores live in the user's browser.

Shapes considered: **(a)** a browser-mediated control room (the proposal-mailbox
pattern generalized to request/response RPC); **(b)** activating the
@galley/persistence server stores behind a local HTTP service — REJECTED: forks
authority against CRDT-is-truth (ADR-0018) and the local-first deployment;
**(c)** deferring 16.3 to hosted mode — REJECTED: the local-first product is the
default and the pattern in (a) needs no new substrate.

## Decision — shape (a): the Agent Access control room

- When the user explicitly enables **Agent Access** (off by default,
  session-scoped, revocable), the browser mints a **CSPRNG control-room
  capability** (like Share) and joins it over `apps/sync`. The kernel joins the
  same room and exchanges **bounded request/response records** through a Yjs
  mailbox; the browser answers from its own stores. The browser remains the
  sole authority; the kernel never sees IndexedDB or store handles.
- **`open_project` is a browser action**: the browser opens the project
  visibly, mints a FRESH `share-*` project room, and returns
  `{ syncUrl, room, projectId, mainFile }`; the kernel then joins that project
  room and the existing 16.1/16.2 tools apply unchanged. The stable project id
  is never itself a share capability.
- **Tool surface (full epic):** `list_projects`, `create_project`,
  `open_project`, `list_versions`, `list_version_files`, `read_version_file`,
  `create_version` — plus the unchanged per-project six.
- **Consent model:** the session-scoped Agent Access grant covers library
  METADATA and non-destructive persistent ops; `open_project` requires
  per-project disclosure by default (it exposes document content);
  `create_project`/`create_version` do NOT need the document Accept gate (they
  never mutate a live CRDT) but are notified in the UI, logged, and bounded.
- **First slice (16.3a):** control-room pairing + `list_projects` +
  `open_project` + `list_versions` metadata ONLY. No headless sessions, no
  version file reads, no create ops.
- **Non-goals:** version RESTORE via MCP (later, only as
  `request_restore_version` → compare UI → explicit human Accept; never a
  direct mutation), delete/archive, a server persistence daemon, IDB↔server
  sync, networked MCP.

## Security posture

Every control-room peer is treated as hostile (the 16.1/16.2 posture):
schema-validated records, size/count caps, request timeouts, malformed records
ignored, fail-closed when no browser handler is present. A hostile peer holding
the control-room token is equivalent to the local agent for that session — it
can ASK; the browser DECIDES. It cannot bypass the document Accept gate, cannot
read unshared project content before an allowed `open_project`, and never
obtains store handles. The control room is separate from project share rooms
and revocable independently.

## Risks

1. **Accidental broad exposure** — `open_project` converts a private local
   project into a shared room: keep it visible, per-project, revocable.
2. **Authority drift** — never stand up headless server stores in local mode.

Effort: **Medium** (root-level Agent Access UI, bounded control mailbox, kernel
session-mode changes, open/share orchestration, security pins). A
Security-Analyst round gates every implementing slice.

## `create-binary-path` (local-path binary import)

Road-test finding **F8 (critical)**: `propose_files` could only create a binary
file by inlining its bytes as base64 (`create-binary`), which balloons the
tool-call channel for any non-trivial asset and was the one blocking gap for
"add this figure" workflows where the source already lives on the kernel's
machine. We add a sibling op `create-binary-path { path, srcPath, mime? }`:

- **What it does** — the LOCAL stdio kernel reads the file at the **absolute**
  `srcPath` from disk via `node:fs/promises`, enforces the unchanged
  `FILE_PROPOSAL_LIMITS.maxBlobBytes` cap, infers/validates the mime exactly as
  `create-binary` does (`inferMime` over the bytes/extension), then funnels into
  the **same** preflight → aggregate-gate → hash → upload → publish pipeline,
  preserving the input-order `built[]` index discipline.
- **Unchanged wire/CRDT contract** — the PUBLISHED proposal op is an ordinary
  `create-binary` `BinaryAsset` pointer (NOT a new op kind), so there is **no**
  `packages/collab` type change and the human/auto Accept gate, review card, and
  apply path are all unchanged. The pending-binary entry was unified to carry
  EITHER a base64 string (decoded in the upload phase) OR bytes already read from
  disk, keeping one upload loop and one set of fail-closed/release semantics.
- **Guards** — absolute-`srcPath`-only (`invalid_src_path`; a host FS path, NOT
  an in-tree project path, so it does NOT go through `isSafeProjectPath` — only
  the in-tree `path` does, inheriting dup-detection for free); `stat` before
  read to reject a directory/non-regular file (`src_unreadable`); the cap is
  enforced on `stat.size` BEFORE reading the bytes and **re-checked** on the
  actual byte length after reading (TOCTOU: a file can grow between stat and
  read); an empty file is refused; on upload failure the already-uploaded blobs
  are released best-effort and NOTHING is published — identical to
  `create-binary`.
- **Security decision (recorded, not accidental)** — the kernel runs as a Node
  process with the user's FS privileges, so this op lets an MCP agent read ANY
  absolute file the kernel can read and publish its bytes into the project. This
  is **acceptable**: the local kernel IS the user's trust boundary (the agent
  already has `read_file`/`read_document` over project content), `srcPath` is
  deliberately NOT sandboxed to a directory, and the published bytes still pass
  the unchanged human/auto Accept gate — nothing lands silently. `fsStat`
  (not `lstat`) follows symlinks, so a symlinked `srcPath` reads its target and
  the same cap applies. The bytes are never logged.
- **Runtime parity** — the op exists ONLY in the local stdio kernel, where
  `node:fs` is available; `server.ts` is loaded solely by the Node kernel
  (`main.ts`) and never bundled into the browser app, which has no FS and no
  equivalent. A new ADR is not warranted: this is an additive op under this
  ADR's library-ops + binary-asset umbrella.
