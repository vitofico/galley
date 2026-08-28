# ADR-0006 — Start collaboration: accept Yjs direction; build the agent-as-peer core first

- **Status:** **Accepted** (kicks off post-MVP collaboration work)
- **Date:** 2026-06-07
- **Supersedes the "Proposed" status of:** [ADR-0005](ADR-0005-collaboration-yjs.md)
  (the direction it set is now accepted; this ADR scopes how we start)
- **Context docs:** [`../server-and-collaboration.md`](../server-and-collaboration.md),
  [`../editing-and-diff.md`](../editing-and-diff.md)

## Context

The MVP (M0–M3) is complete and green. The roadmap's #1 post-MVP feature is
real-time collaboration, with the elegant payoff that **the AI agent is just
another editing peer** (ADR-0005, Proposed). We are now starting that work.

The risk in starting a large, networked, multi-user feature is breaking the
clean, green MVP. So we apply the same strategy that worked for the MVP itself:
**build the framework-agnostic, offline-testable core FIRST**, before any server
or UI rewrite. The core is the part that proves the thesis; the network and UI
are transport around it.

## Decision

Accept the ADR-0005 direction (Yjs CRDT, agent-as-peer, OIDC/pluggable auth,
project/membership model). Implement it in phases, core-first:

- **Phase 1 (this ADR — offline, no server, no MVP-UI change):**
  - A new framework-agnostic package **`@galley/collab`** depending only on
    `yjs` + `@galley/shared`. No React, no DOM, no network.
  - `CollabDocument`: a `Y.Doc` + `Y.Text` holding the Typst source, with
    author-tagged transactions (`Author = human | agent`).
  - `applyAgentEdits(doc, blocks, author)`: apply the agent's existing
    search/replace `EditBlock`s as a **Yjs transaction** (per-block delete+insert
    at the matched offset). This is "the agent as a peer" — the SAME edit blocks
    the MVP loop already produces, now applied to the shared CRDT doc.
  - Keep the MVP's **fail-safe** rule: a block whose `search` no longer matches
    uniquely in the *current* doc is a surfaced **conflict**, not a clobber
    (all-or-nothing per call, exactly like `applyEdits`).
  - Add the one anticipatory type, **`Author`**, to `@galley/shared` (it now has
    a real consumer — the doc said to add it "when collaboration work begins").
  - Prove the payoff with **offline convergence tests**: two in-memory peers,
    a human edit on one and an agent edit on the other applied concurrently, then
    update-exchange (no websocket) → both converge with **no clobber**.

- **Phase 2+ (later, their own ADRs/slices — NOT this one):** the y-websocket
  sync server + awareness (cursors/presence); wiring `@galley/web`'s editor to a
  `CollabDocument` via `y-codemirror.next`; the `Author` attribution UI; local
  draft persistence (IndexedDB); then projects/auth/persistence (roadmap 2–5).

## Consequences

- ✅ Proves the agent-as-peer thesis **offline, in the Docker gate**, with zero
  risk to the green MVP (`@galley/collab` is additive; nothing imports it yet).
- ✅ Reuses the MVP's `EditBlock` contract verbatim — the agent loop's output
  feeds the CRDT apply unchanged, validating that the editing design "degrades
  gracefully into the collaboration world" as claimed.
- ✅ `Author` graduates into `@galley/shared` with a real consumer (no premature
  abstraction — the rest of the collab/auth types stay out until Phase 2+).
- ⚠️ Phase 1 does not yet surface same-region conflicts beyond non-unique-match
  (true concurrent same-span edits merge per CRDT semantics); awareness-based
  conflict UX is Phase 2.

## Alternatives considered

- **Rewire the web editor to Yjs first.** Rejected as the first step: it's the
  riskiest, UI-coupled, hardest-to-test-offline part, and would put the green MVP
  at risk before the core is proven. Core-first matches what worked for the MVP.
- **Stand up the sync server first.** Rejected: a server with nothing proven to
  sync is premature; the CRDT apply semantics are the load-bearing unknown.
