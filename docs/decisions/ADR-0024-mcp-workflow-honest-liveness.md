# ADR-0024 — MCP agent-workflow simplification: honest liveness, static tool surface, idempotent attach, global review surface

- **Status:** Accepted (Architect-GPT consulted, 2026-06-18). **Extends**
  [ADR-0023](./ADR-0023-mcp-auto-accept-provenance.md) (provenance + opt-in
  auto-accept + reload re-bind) and ADR-0021/ADR-0020 (control room + proposal
  mailbox + mandatory Accept gate). Does **not** supersede them.
- **Scope:** roadmap #16 (MCP). Fixes the operator-facing failure modes surfaced
  in the 2026-06-17 road-test (see the project memory `galley-mcp-roadtest-findings`).

## Context

A live road-test of the agent surface burned an entire session on failures that
were all *masking* or *visibility* problems, not logic bugs:

1. **`galley_ping` lies.** It is process-local, so it answers `pong` while the
   relay/browser path is dead — it never crosses the room.
2. **Reads mask a dead browser.** `read_document` / `list_files` / `read_file` /
   `project_context` read the kernel's OWN replicated snapshot, so the agent reads
   stale-but-plausible content while the human sees nothing and no proposal can
   surface. The agent has no signal that nobody is listening.
3. **A `propose_*` into an unwatched room looks identical to a watched one** — the
   kernel returns `pending_review` whether or not a browser is attached to review.
4. **Per-project tools register/deregister across reconnects**, so a tool
   (`search_project`) silently vanished mid-session and the agent could not call it.
5. **`open_project` is effectively one-shot / non-idempotent**: re-opening the same
   already-consented project is refused or re-mints, which (with a kernel registered
   via `claude mcp`) produced a stale-room desync that was invisible because `ping`
   kept answering.
6. **Proposal review is hidden** in the collapsible agent sidebar (marked `inert`
   when collapsed), with no global "you have pending changes" signal.

ADR-0023 already fixed the *reload-strands-the-tab* gap (browser-side re-bind from a
MAC'd persisted grant) and shipped the provenance/grant identity primitive. This ADR
adds the **honesty + visibility + idempotence** layer on top, and is deliberately
the *minimal* high-leverage subset — see Non-goals for what is intentionally deferred.

## Decision

### 1. Honest liveness on every kernel result (heartbeat-based, not replica-based)

The kernel already joins the project room as a peer and advertises `Presence`
(`Author` identity) via `CollabConnection.awareness` (y-protocols Awareness). A
browser editor advertises a `kind:"human"` presence; on disconnect/reload its
awareness state is removed (deterministic awareness lifecycle, no 30 s ghost). So
**room presence is the ground-truth heartbeat** of "is a human surface attached",
independent of the kernel's local replica.

- `KernelSession` gains `liveness(): Liveness` reading `connection` + `awareness`:
  ```
  interface Liveness {
    relayConnected: boolean;   // the kernel's own socket to the relay is open
    browserAttached: boolean;  // ≥1 non-agent (human) peer present in the room
    humanPeers: number;        // count of kind!=="agent" awareness states
    lastBrowserSeenMs: number | null; // monotonic ms of the most recent human presence
  }
  ```
- `server.ts` MERGES `liveness` into the JSON payload of **every per-project tool
  result** (`read_document`, `list_files`, `read_file`, `project_context`,
  `propose_edit`, `propose_files`, `compile`) — additive field, existing fields
  byte-for-byte unchanged.
- `propose_edit` / `propose_files` results add a top-level honesty signal: when
  `browserAttached` is false the status is reported as
  `pending_review_unwatched` (still published — a browser may attach later) with a
  human-readable note "published, but no browser is attached to review — ask the
  user to open the project in Galley." When attached, status is unchanged
  (`pending_review`).
- `galley_ping` reports `{ pong, version, relayConnected, browserAttached,
  humanPeers }` when bound to a session (still just `pong <version>` when no
  project is attached). It stops meaning process-only health.

Liveness is **observed, never asserted from the replica**: a successful read never
implies a browser is attached.

#### 1.1 Headless agent-apply workers are NOT watchers (F13, amended 2026-06-20)

The F13 background agent-apply host (§3.1) attaches to a project room in a browser
tab to keep applying a paired agent's proposals while that project is **not the
active editor document** — i.e. with **no human watching the review surface**. It
is a real browser editing the doc, so it carries a `kind:"human"` author; but it
advertises the honest presence marker `agentWorker: true`
(`AGENT_WORKER_PRESENCE_FIELD`, exported from `@galley/collab`). The kernel's
`humanPeerCount` (session.ts) **excludes** any peer with `agentWorker === true`, so
an attached worker keeps `browserAttached` a true signal and **never silently
suppresses `pending_review_unwatched`**. A worker applies; it does not watch. This
preserves the §1 invariant that liveness reflects a *human* surface, not merely a
connected browser.

### 2. Static tool surface with structured idle responses

Per-project tools are registered ONCE at server start and never deregistered. When
no project is attached, each returns a structured, non-throwing result
`{ status: "no_project_attached", message: "call open_project first" }` (and
`compile` keeps its existing `not_configured`). This removes the
register/deregister churn that dropped `search_project`, and makes the tool list
stable across reconnects. The tool *schemas* never change; only their runtime
guard does.

#### 2.1 `create_project { name }` — control-mode project mint (road-test F1)

A `create_project { name }` control-mode tool sits alongside `list_projects`:
available BEFORE any `open_project` bind, gated ONLY by the Agent Access pairing —
NOT by per-project content consent, because there is no pre-existing project to
grant. The browser (the project-library authority that answers `list_projects`)
mints a brand-new, REGISTRY-ONLY project via `IdbProjectStore` (owner = the local
profile user) and returns `{ projectId, name }`. It does NOT navigate the browser
tab and does NOT seed CRDT content; the project opens with blank starter content
the first time a human opens it in the editor (the existing `seedIfPristine` /
`BLANK_STARTER_FILES` path). This keeps the responder headless (the editor-flow
`createProject` — navigate + pending-seed — stays editor-only).

Consent posture (deliberate): a paired kernel can create empty, local-user-owned
library projects. The blast radius is low — the project is empty and carries no
content, and the kernel still cannot read or open it without the separate
per-project file-access grant. Headless-seeding caveat: because a registry-only
project has no CRDT db until a human opens it once, `open_project` and the
read-only content tools will not see its content until then — `create_project`
followed by an immediate read/open is expected to find no materialized content.

### 3. Idempotent `open_project` attach/reuse

`open_project` for a project that already has a **valid, MAC-verified persisted
grant** (ADR-0023's grant record) for the SAME `{controlRoom, syncUrl, projectId,
shareRoom, mainFile}` **reuses** that grant and re-attaches — no fresh consent
modal, no re-mint of the share room. A DIFFERENT project, a `joinedSession`, or a
MAC/identity mismatch still requires full consent (ADR-0021 ordering preserved). A
second `open_project` for the SAME already-attached project is a no-op success
(returns the live binding) rather than a refusal. This kills the casual-retoggle
and re-open desync.

#### 3.1 Headless reuse for a NON-foreground project (F13, amended 2026-06-20)

The §3 reuse fast-path re-binds the **currently-open** project (it runs *after* the
scope gate). F13 adds a sibling, narrower relaxation: `open_project` for a project
that is **not** the active editor document may re-attach **without a modal** ONLY
when the human granted **standing headless access** to *exactly* that project once —
a MAC-verified persisted grant carrying `persistentAccess: true` (ADR-0026), whose
canonical scope `{controlRoom, syncUrl, projectId, shareRoom, mainFile}` matches the
request **exactly**, and that has **not gone idle past the 7-day TTL**
(`grantAuthorizesHeadlessAttach`, `HEADLESS_ACCESS_IDLE_TTL_MS`). This is the **only**
relaxation of the currently-open-project scope gate. In `agent-open-handler.ts` the
new `tryHeadlessAttach` branch sits **after** the SEC-16.3b joined-session refusal
(which still wins) and **before** the scope check, and is **liveness-gated**
identically to the reuse fast-path (a withdrawn request fails closed to
`REFUSAL_WITHDRAWN` and never reconnects). A new / changed / unscoped request still
falls through to the scope gate → `REFUSAL_WRONG_PROJECT` or the full foreground
modal (fail closed). The attaching host advertises `kind:'agent-worker'` presence
(§1.1) so it does not falsely watch the room.

### 4. Global, always-visible review surface

Pending-proposal review moves out of the collapsible/`inert` agent sidebar into a
**global indicator** rendered at the shell root (next to the durability bar, where
notices already live): a persistent badge with the pending count, visible
regardless of panel state, that opens a review pane. `canMutate` gates the **Accept
action** only — a viewer still SEES "N pending — ask an editor" rather than nothing.
The existing `McpProposals` / `McpFileProposals` Accept/Reject logic is reused
verbatim; only its mount point and a count-badge are added.

## Consequences / invariants

- **Additive + default-safe.** Every change adds a field or a mount point; the
  existing apply chokepoint (manual Accept → conflict-aware planner) and ADR-0023's
  auto-accept gates are untouched. Existing tests stay green.
- **Liveness cannot give a false-positive.** It is derived from room awareness
  (a browser that left the room disappears), never from the kernel replica. Pinned
  by test.
- **The tool list is stable across reconnects;** idle tools fail soft, never vanish.
- **Idempotent re-open never bypasses consent** for a new/changed/`joinedSession`
  scope — it only re-uses an identity-matched, MAC-verified grant.
- **Review visibility no longer depends on the sidebar being expanded;** Accept
  authority is still `canMutate`-gated and fail-closed for viewers.

## Non-goals (deferred — see memory `mcp-workflow-rework-plan`)

- **Single-room migration** (collapsing the control room + per-project share room
  into one): biggest churn, likely subsumed by idempotent attach + honest liveness;
  revisit only if pain remains. NOT done here.
- **Full kernel-side `--pair` durable pairing** (replacing baked
  `--control-room`/`--response-key` launch args): security-sensitive (kernel secret
  storage, revocation); build on ADR-0023's grant model later. NOT done here.
- No server-side Accept; no defense against write-capable room peers; no XSS claim
  (all per ADR-0020/0023).
