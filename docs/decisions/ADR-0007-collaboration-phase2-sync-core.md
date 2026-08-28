# ADR-0007 — Collaboration Phase 2 (kickoff): the framework-agnostic sync + awareness core

- **Status:** **Accepted** (kicks off Phase 2; design reviewed by the Architect expert)
- **Date:** 2026-06-07
- **Builds on:** [ADR-0006](ADR-0006-collaboration-phase1.md) (Phase 1 — the agent-as-peer
  CRDT core), [ADR-0005](ADR-0005-collaboration-yjs.md) (Yjs direction)
- **Design doc:** `2026-06-07-collab-sync-core-design.md` (archived design note)
- **Context docs:** [`../server-and-collaboration.md`](../server-and-collaboration.md)

## Context

Phase 1 shipped the offline CRDT core (`CollabDocument`, `applyAgentEdits`) and
proved convergence by handing encoded updates between two in-memory peers. The
next certainty-order step is the **sync layer**: how peers actually exchange
those updates and presence — but still WITHOUT a real server or editor, so we
de-risk the networked slices before paying their cost or risking the green MVP.

ADR-0006 already rejected "editor-first" (riskiest, UI-coupled) and
"server-first with nothing proven" as first steps. This slice is the missing
middle: a transport-agnostic provider that speaks the **standard `y-protocols`**
sync + awareness wire format, so the later real y-websocket server is a near
trivial byte relay and the editor binding reuses the same `Awareness`.

## Decision

Add to `@galley/collab` (new dep `y-protocols`; `lib0` already transitive via
`yjs`; still no React/DOM/network):

- A **`Transport`** seam (`send`/`onMessage`/`connect`/`disconnect`) — the ONLY
  thing the future y-websocket implementation swaps in.
- A **`CollabConnection`** provider binding a `CollabDocument` + a Yjs
  `Awareness` to a `Transport`, speaking y-websocket-identical framing
  (`0` sync / `1` awareness / `3` query-awareness) via `y-protocols/sync` and
  `y-protocols/awareness`.
- An **`InMemoryTransport`** hub (synchronous, FIFO-drained) for deterministic
  offline multi-peer tests.
- A minimal **`Presence = { author: Author }`** (+ opaque payload); cursor and
  selection mechanics are deferred to the editor binding.

Correctness rules adopted from the Architect review:

1. **Transaction `origin` is local-only and does NOT cross the wire.** Standard
   Yjs updates carry no origin; the receiver supplies its own. We apply inbound
   updates with `origin = the connection`, use origin purely for **echo
   suppression**, and **defer durable cross-peer edit attribution** (a future
   `clientID → Author` map or awareness identity). This corrects the Phase 1
   implication that author-tagged origins carry attribution across peers — they
   do so only *locally*.
2. **Echo prevention = origin-filter + FIFO queue**, never reliance on Yjs
   idempotency. Outbound `send` only when `origin !== connection`.
3. **Awareness departure is explicit** — broadcast a removal on `disconnect`
   (no 30 s timeout), and `awareness.destroy()` to clear its interval — so tests
   are deterministic and leak-free.
4. **One awareness state per `Y.Doc` clientID**: human and agent are separate
   peers, each its own doc/connection/awareness.

## Consequences

- ✅ Proves multi-peer sync + presence **offline, in the Docker gate**, with zero
  server and zero MVP-UI risk (`@galley/collab` stays additive).
- ✅ The wire format IS y-websocket's, so the next two slices (ws server, editor
  binding) are thin and low-risk — the certainty-order bet pays off.
- ✅ Honest attribution story: origins are local; cross-peer attribution is an
  explicit future slice, not an accidental guarantee.
- ⚠️ Cursor/selection presence is intentionally absent until the editor exists
  (it needs Yjs relative positions). Presence currently carries identity only.
- ⚠️ Adds `y-protocols` to the dependency surface (small, stable, Yjs-official).

## Alternatives considered

- **Hand-rolled minimal protocol** over the Transport. Rejected: it diverges from
  the y-websocket wire format and would be thrown away when the real server
  lands; using `y-protocols` de-risks the actual network slice now.
- **Define cursor/selection presence now.** Rejected (YAGNI): cursor semantics
  need relative positions and a real editor; modelling them now risks a shape
  that conflicts with `y-codemirror.next`.
- **Make author attribution survive sync in this slice.** Rejected: Yjs updates
  don't encode origin; faking it would be a custom protocol extension with no
  consumer yet. Deferred to a slice that actually renders attribution.
