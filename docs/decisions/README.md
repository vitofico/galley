# Architecture Decision Records (ADRs)

Short, dated records of decisions that are expensive to reverse. Each captures
the **context**, the **decision**, and the **consequences** so future
contributors understand *why*, not just *what*.

Format: lightweight [MADR](https://adr.github.io/madr/)-style. Status is one of
`Proposed` · `Accepted` · `Superseded by ADR-XXXX` · `Deprecated`.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](ADR-0001-browser-typst.md) | Compile Typst in the browser via typst.ts WASM, in a Web Worker | Accepted |
| [0002](ADR-0002-ai-sdk-adapter.md) | Vercel AI SDK behind an internal `LanguageModelClient` adapter | Accepted |
| [0003](ADR-0003-search-replace-edits.md) | Search/replace blocks as the agent's edit primitive | Accepted |
| [0004](ADR-0004-model-proxy.md) | A thin, optional, self-hostable model-API proxy in the MVP | Accepted |
| [0005](ADR-0005-collaboration-yjs.md) | Collaboration via Yjs CRDT (agent as a peer); pluggable OIDC auth | Proposed |
| [0006](ADR-0006-collaboration-phase1.md) | Start collaboration: accept Yjs; build the agent-as-peer core first (Phase 1) | Accepted |
| [0007](ADR-0007-collaboration-phase2-sync-core.md) | Collaboration Phase 2 kickoff: framework-agnostic sync + awareness core | Accepted |
| [0008](ADR-0008-sync-websocket-server.md) | Collaboration Phase 2b: the y-websocket sync server (`apps/sync`) | Accepted |
| [0009](ADR-0009-collab-editor-binding.md) | Collaboration Phase 2c: the flag-gated editor binding (y-codemirror.next) | Accepted |
| [0010](ADR-0010-collab-presence-connection.md) | Collaboration Phase 2c-2: connect the editor to the sync server + presence | Accepted |
| [0011](ADR-0011-local-draft-persistence.md) | Collaboration Phase 2e: local draft persistence (IndexedDB) | Accepted |
| [0012](ADR-0012-cross-peer-author-attribution.md) | Collaboration Phase 3: cross-peer author attribution (clientID → Author) | Accepted |
| [0013](ADR-0013-multi-file-projects.md) | Multi-file projects: `CollabProject` CRDT + virtual FS (roadmap #2) | Accepted |
| [0014](ADR-0014-package-resolver-seam.md) | Package-resolver seam (fail-closed, offline) | Accepted |
| [0015](ADR-0015-server-side-compile.md) | Server-side compile + sandboxing architecture (roadmap #3) | Accepted |
| [0016](ADR-0016-registry-fetch-security.md) | Registry fetch + package-archive security | Accepted |
| [0017](ADR-0017-self-host-packaging.md) | Self-host packaging: runtime image + compose topology (roadmap #5) | Accepted |
| [0018](ADR-0018-auth-persistence-data-model.md) | Auth, persistence & git-backed versioning: CRDT-is-truth data model (roadmap #4) | Accepted |
| [0019](ADR-0019-browser-git-transport.md) | Browser git transport: in-memory fs, token stays client-side (roadmap #17.2) | Accepted |
| [0020](ADR-0020-mcp-local-kernel.md) | Inbound MCP local kernel: sync-room peer + pending-proposal mailbox (roadmap #16.1) | Accepted (auto-accept deferral superseded by ADR-0023) |
| [0021](ADR-0021-mcp-library-ops.md) | MCP library/version operations: the browser-mediated Agent Access control room (roadmap #16.3) | Proposed (core #16.3a landed) |
| [0022](ADR-0022-licensing-agpl.md) | Licensing: AGPL-3.0-only + CLA + trademark policy (roadmap #21.3) | Accepted |
| [0023](ADR-0023-mcp-auto-accept-provenance.md) | Authenticated proposal provenance + opt-in MCP auto-accept | Accepted |
| [0024](ADR-0024-mcp-workflow-honest-liveness.md) | MCP workflow: honest liveness on every result (roadmap #16) | Accepted |
| [0025](ADR-0025-agent-acceptance-unification.md) | Unified per-project agent acceptance mode (in-app + MCP) | Accepted |
| [0026](ADR-0026-mcp-durable-pairing.md) | MCP durable, revocable kernel pairing | Accepted |
| [0027](ADR-0027-typst-only-canonical.md) | Typst is the canonical document language; LaTeX is one-way import only | Accepted |

## Adding an ADR

1. Copy the structure of an existing one. Number sequentially.
2. Keep it short — context, decision, consequences, alternatives considered.
3. Add a row to the index above.
4. Don't edit an accepted ADR to change the decision; write a new one that
   supersedes it.
