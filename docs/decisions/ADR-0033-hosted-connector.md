# ADR-0033 — Hosted connector: a server-side agent peer that may apply

- **Status:** Accepted. **Supersedes three clauses**, and only those:
  [ADR-0020](./ADR-0020-mcp-local-kernel.md) "any server-side Accept (never)"
  and "the kernel never applies anywhere else";
  [ADR-0026](./ADR-0026-mcp-durable-pairing.md) §6 "no kernel/server-side apply
  — authority stays in the browser origin". It **narrows**
  [ADR-0021](./ADR-0021-mcp-library-ops.md) "never stand up headless server
  stores in local mode" to what it literally says: local mode stays as it is.
  Everything else in ADR-0020, 0021, 0023, 0024, 0026 and 0032 keeps governing
  the local bridge unchanged.
- **Scope:** roadmap #16.4 (networked MCP). Builds on
  [ADR-0018](./ADR-0018-auth-persistence-data-model.md) (accounts, sessions,
  capability rooms) and [ADR-0023](./ADR-0023-mcp-auto-accept-provenance.md)
  (checkpointed, revertable, audited auto-accept).

## Context

Galley's only agent connection is the **local bridge**: a stdio program the
agent spawns on the person's machine, paired with a Galley tab that must stay
open, because the browser holds the document and is the only place a change can
be applied. That design is deliberate (ADR-0020, 0026), and it has two limits
that no amount of polish removes:

- Chat clients such as Claude and ChatGPT accept only MCP servers reachable at
  an `https://` address. They cannot spawn a local program, so they cannot reach
  Galley at all.
- Nothing can happen while no tab is open. With every tab closed the document is
  not on the server: projects live in the browser, and the relay passes edits
  between open tabs and keeps a room only while someone is in it.

The second point is the real cost of this decision. A connection that works with
no tab open needs a durable server copy of the document and a server-side
writer. Both were ruled out in writing. This ADR rules them in, for projects a
person explicitly connects, and says what protects them.

## Decision

Add a second, opt-in connection, the **hosted connector**: an MCP endpoint at
`/mcp` on a signed-in Galley deployment. It works with no tab open and, when the
person has allowed it, applies changes on the server.

### 1. A connected project has a server replica

Connecting is a per-project act in the browser. It registers a durable
`connector`-kind capability room for that project (ADR-0018 registry, no
expiry, revocable) and keeps the project synced into it. The relay persists
that room (`GALLEY_SYNC_PERSIST_DIR`).

The browser copy and the server copy are two replicas of one Yjs document and
merge like any two collaborators. There is still no server-authoritative
document: CRDT-is-truth holds, with one more replica that happens to live on the
server. A project that was never connected has no server copy, exactly as
before. Disconnecting revokes the room and retires its stored state.

### 2. The connector is a peer, never a file writer

The connector is a separate, stateless service. For each request it joins the
project's room over the relay as a websocket peer, the way the local bridge and
the draft publisher already do, performs the call, flushes and leaves. It never
opens the relay's files: the store is single-writer and has no cross-process
locks. Persistence and fan-out to open tabs stay the relay's job.

### 3. Authority: a grant per project, a token per client

- A **grant** belongs to one connected project and carries the review mode,
  **Ask** or **Auto**. The person sets it in the browser and can change or
  revoke it at any time. It is stored server-side next to project membership.
- A **token** belongs to one client. It reaches the account's connected
  projects and nothing else, has an expiry, is stored only as a hash, is shown
  once, and is revocable. A token for a closed account or a revoked grant is
  refused.

A request is admitted only if the token is live, the project is connected, and
the token's account currently has write membership of it.

### 4. The server may apply, under the ADR-0023 safeguards

In **Ask** mode the connector publishes a pending proposal and stops. It lands
only through the browser's existing Accept gate, the next time the person opens
Galley.

In **Auto** mode the connector applies, in this order, and stops at the first
step that fails:

1. Re-read the grant and the token. Switching to Ask or revoking takes effect on
   the next call; this is the kill switch.
2. Take a checkpoint of the whole project in the relay's server-side history.
   No checkpoint, no apply.
3. Apply with the same conflict-aware code the browser uses
   (`@galley/agent-apply`): re-match against the current text, all-or-nothing
   for a multi-file set. A conflict applies nothing and is reported.
4. Append an audit entry (time, token id, project, files, checkpoint id).
5. Leave a resolved proposal record in the document, so the change appears in
   Galley's own history with its origin.

The volume cap and size limits of ADR-0023 apply unchanged. What replaces the
proposal signature is the server's own check of the token: a signature exists so
a browser can trust a record written into a room any peer can write to, and here
no browser is deciding.

### 5. One tool list, the project as a parameter

`list_projects` (connected projects only), `list_files`, `read_file`,
`project_context`, `propose_edit`, `propose_files`, `compile`. The endpoint
keeps no session, so every call names its project. The local bridge adopts the
same names and shapes.

## What does not change

- **Default off, twice.** The connector does nothing until an operator enables
  it and a person connects a project. Auto is a further explicit choice.
- **Local mode is untouched.** No account, no connected project: no server
  copy, no server writer, and the local bridge works as before.
- **The in-app agent never auto-applies.** Invariant 1 still binds it.
- **Scratch isolation and conflict-aware Accept** (invariants 2 and 3) bind the
  server applier exactly as they bind the browser.
- **No client-supplied URLs, no logged bodies.** The connector reaches only the
  relay and the compile service.

## Consequences

- **A token is write access with nobody watching.** A leaked token can change
  every connected project in Auto mode until it is revoked or expires. Each
  change is preceded by a checkpoint and recorded, so it is revertable and
  attributable, not preventable. This is the honest price of "hands-off" and the
  UI must say so where Auto is chosen (invariant 7).
- **The server now stores documents** for connected projects, in plaintext, with
  their versions. The security model's "servers do not own state" becomes
  "servers hold a replica only of what a person connected".
- **Text only at first.** The server compile cannot see binary files, so a
  project with images compiles without them through the connector until hosted
  blobs are wired in.
- **Projects are still born in the browser.** The server has no project
  registry; `create_project` is not offered.
- **Relay role enforcement becomes load-bearing.** The relay admits any member
  regardless of role today. The connector's write check must not rely on it, and
  the relay gap is fixed separately.

## Alternatives considered

- **Proposals only, apply later.** Keeps the Accept rule intact and limits a
  leaked token to reading and suggesting. Rejected as the end state: the
  document would not change until the person opened Galley, which is not what
  the connection is for. It survives as Ask mode.
- **Apply inside the relay process.** No extra service and direct access to the
  room. Rejected: it puts agent logic and a public MCP surface inside the
  component every collaborator depends on.
- **Write the stored room files from a second process.** Rejected outright: the
  store assumes one writer and a second one can lose updates silently.
- **Replace the local bridge.** One path to maintain. Rejected for now: agent
  access would then require an account and a server copy, which contradicts
  local-first for self-hosters and for the demo.
- **An OAuth authorization server from day one.** The right long-term
  credential for chat clients. Deferred: the token layer is designed so OAuth
  can issue the same tokens later.
