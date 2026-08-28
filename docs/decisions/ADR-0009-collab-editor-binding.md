# ADR-0009 — Collaboration Phase 2c: the flag-gated editor binding (y-codemirror.next)

- **Status:** **Accepted** (Phase 2c-1 landed; 2c-2 sync wiring is the next slice)
- **Date:** 2026-06-07
- **Builds on:** [ADR-0007](ADR-0007-collaboration-phase2-sync-core.md),
  [ADR-0008](ADR-0008-sync-websocket-server.md)
- **Design review:** Architect expert (y-codemirror.next integration pitfalls)

## Context

The sync core (2a) and server (2b) are done and verified. The remaining piece is
the **riskiest** one: wiring `@galley/web`'s CodeMirror editor to a shared
`CollabDocument` so human and agent edits flow through the CRDT in the real UI.
ADR-0006 said to do this **behind a flag**, carefully, to protect the green MVP.

## Decision

Flag-gated via `?collab=1` (default OFF — the single-user path is byte-for-byte
unchanged). Split into two slices to stay green:

**Phase 2c-1 (this slice — local CRDT, no server):**
- `CollabEditor`: CodeMirror 6 bound to the doc's `Y.Text` via
  `yCollab(ytext, awareness, { undoManager })`. Undo is routed through Yjs's
  `UndoManager` (high-precedence `yUndoManagerKeymap` over basicSetup's history),
  so undo is collaboration-aware. Same `data-testid`/theme as the plain `Editor`.
- The `Y.Text` is the **write source of truth**; the app keeps `source` as a
  strictly **one-way** read-through (`Y.Text` observer → `setSource`), so
  `useCompiler`, `AgentPanel`, and `DiffReview` are unchanged. The collab editor
  is **never remounted** on Accept (yCollab drives it).
- **Accept becomes the agent-as-peer move**: it reuses the MVP's conflict-aware
  `resolveAccept` (fast path when the live doc hasn't moved; otherwise re-apply
  the edit blocks to the CURRENT shared text), then commits the accepted source as
  a single **agent-tagged Yjs transaction** that replaces only the minimal
  differing span (shared prefix/suffix) — so a concurrent disjoint peer edit isn't
  clobbered. (Applying the raw blocks directly via `applyAgentEdits` was the first
  cut, but the demo agent's cumulative blocks don't re-apply from scratch — the
  MVP's fast path is load-bearing — so Accept goes through `resolveAccept`, exactly
  like the single-user path, and only the commit differs.)
- `Open .typ` is **hidden in collab mode** (it mutated via `setSource`+remount,
  which would split React's `source` from the Yjs editor — caught in review).
- Session created once via a lazy `useRef` (React 18 StrictMode-safe). Vite
  `resolve.dedupe` pins a single `yjs`/`y-protocols`/`lib0` (two copies break
  `instanceof`).
- Verified by 2 new Playwright e2e (`?collab=1`): user typing flows
  editor→Y.Text→compiler (a located diagnostic), and agent Accept merges into the
  live doc with the editor following (no remount).

**Phase 2c-2 (next):** connect via `WebSocketTransport` to `apps/sync` (the
`?sync=&room=` params, parsed now), merged awareness presence + remote cursors,
and a two-browser collaborative e2e.

## Consequences

- ✅ Real collaborative editing in the UI, with the agent as a peer — the thesis,
  visible. Zero risk to the green MVP (flag OFF by default; existing e2e untouched).
- ✅ Minimal, reversible seam: `source` stays a plain string for the rest of the
  app; only the editor component and Accept branch differ under the flag.
- ⚠️ In collab mode, accepted agent edits aren't on the local Yjs undo stack (the
  transaction carries the agent origin, not the editor's) — acceptable; undoing AI
  edits is a deliberate future choice, not an accident.
- ⚠️ `Open .typ` disabled under the flag (a Yjs-replace path is a later nicety).
- ⚠️ Cursor/remote-presence rendering + the websocket connection are 2c-2.

## Alternatives considered

- **Make the editor controlled (React drives CodeMirror from `source`).** Rejected:
  fights CodeMirror and yCollab, causes cursor jumps; the editor must own its state.
- **Replace `source` state with the Y.Text everywhere now.** Rejected: a larger,
  riskier rewrite; the one-way read-through keeps the blast radius tiny and the
  flag-off path identical.
- **Two-way `source ↔ Y.Text` sync.** Rejected: feedback loops; writes into Yjs
  happen only on explicit commands (Accept; later, Open).
