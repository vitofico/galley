# ADR-0020 — Inbound MCP local kernel: sync-room peer + pending-proposal mailbox

- **Status:** Accepted (Architect-GPT consulted, 2026-06-09). **Implemented** —
  the kernel landed wave-11 (`b5a73c4`) behind a Security-Analyst round whose
  REQUEST-CHANGES verdict was honored before merge (+26 pin tests: proposal
  limits at publish/read/zod/render, loopback-only compile URL, strict
  single-match Accept).
- **Scope:** roadmap **#16.1** (local, no-auth MCP). Networked/authenticated MCP
  is **#16.4**, explicitly out of scope here (gated on E5).

## Context

External agent clients (Claude Code, IDEs, other MCP hosts) should be able to
drive Galley's three sacred tools — `read_document`, `propose_edit`, `compile` —
against an open Galley project. The hard constraint: Galley's document is a
browser-resident Y.Doc (IndexedDB-persisted, optionally shared through the
`apps/sync` relay), and the **human Accept gate lives in the browser UI and is
mandatory for every agent edit**. A local stdio MCP server process cannot reach
into a browser tab.

Candidate shapes considered: (a) the MCP server joins the project's Yjs room as
a peer and communicates proposals through shared CRDT state; (b) the MCP server
opens its own headless copy from the persistence layer (broken for the
local-first default — IndexedDB is browser-only); (c) an HTTP/SSE proposal
bridge embedded in `apps/web-server` that the tab polls/subscribes to (a second,
parallel bridge protocol to maintain).

## Decision (shape a)

`apps/mcp` is a **local stdio MCP server that joins the shared project's Yjs
room via the existing `apps/sync` relay as a peer**:

- `read_document` reads the scoped file from the replicated `CollabProject`.
- `propose_edit` **never mutates file text**. It applies the agent loop against
  a per-MCP-session scratch copy and publishes a **pending-proposal record**
  into a shared Yjs map (the "mailbox"). The browser observes the mailbox and
  routes each proposal through the existing `DiffReview` → `resolveAccept` →
  `applyAcceptedFileAsAgent` path. Accept/Reject stays in the browser,
  mandatory and conflict-aware.
- `compile` calls the loopback `apps/compile` service via an explicit URL (an
  injected fake in tests); diagnostics return to the MCP client.
- Scope: **one room + one target file** per kernel session, supplied by
  CLI/config copied from the browser's Share surface. Requires the project to
  be in shared/connected mode (the 14-C Share button already mints local
  rooms) — the kernel is unreachable for a purely tab-local project by design.
- No auth: stdio reaches only the local user (matches the no-auth local-first
  default); the room id remains an unguessable capability; loopback-only.

## Consequences / invariants

- **The Accept gate cannot be bypassed**: tool handlers get a wrapped surface
  that can only read file text and write proposal records; a test must prove
  `propose_edit` leaves file text unchanged.
- If no browser is open, proposals report "pending — open Galley to review";
  the kernel never applies anywhere else.
- Deferred from 16.1: IndexedDB-only project access, project-wide file
  listing, library/version operations, durable proposal queues beyond the live
  room, networked/authenticated MCP (#16.4), any server-side Accept (never).
- New external dependency: `@modelcontextprotocol/sdk` (the official TS SDK) —
  the one dep this arc admits, landed via the serial scaffold slice.

## Scaffold (this slice)

`apps/mcp` workspace package + Dockerfile manifest wiring + lockfile; a
`createGalleyMcpServer()` factory exposing only a `galley_ping` liveness tool,
smoke-tested over the SDK's in-memory transport pair. The three real tools land
as their own slice behind the review gate above.

## Addendum (2026-06-17): multi-file proposals (`propose_files`)

The write surface widens from one bound file to **multi-file change sets** while
keeping every invariant above. The one-**room** scope is unchanged; only the
one-**file** *write* scope widens.

- **`propose_files`** publishes a single pending record (sibling
  `Y.Map("mcpFileProposals")`) carrying an all-or-nothing set of `create`/`edit`
  ops. Publishing still writes ONLY the mailbox — never file text (the pin holds,
  test-proven). The browser validates EVERY op against the live snapshot first
  (`planFileProposalAccept`) and applies nothing on any conflict, then commits the
  whole set as the agent peer through ONE merged update (atomic — no partial
  landing, no empty-file intermediate). Paths pass `isSafeProjectPath` (no
  traversal / not `/.galley`) and are length-capped, and the set is bounded by
  aggregate caps (max ops / total bytes / total blocks), enforced twice (publish
  throws + read skips, with array-length guards before any per-element work) like
  the single-file limits.
- An auto-accept opt-in (apply incoming proposals without the per-proposal click)
  is deferred: it relaxes human review of UNSIGNED, peer-writable mailbox records,
  so it needs an authenticated-proposal-provenance design first.
  *[Superseded 2026-06-17 by [ADR-0023](./ADR-0023-mcp-auto-accept-provenance.md),
  which supplies that provenance design and ships opt-in auto-accept on top of it.]*
