# ADR-0010 — Collaboration Phase 2c-2: connect the editor to the sync server + presence

- **Status:** **Accepted**
- **Date:** 2026-06-07
- **Builds on:** [ADR-0008](ADR-0008-sync-websocket-server.md) (the sync server),
  [ADR-0009](ADR-0009-collab-editor-binding.md) (the flag-gated editor binding)

## Context

Phase 2c-1 bound the editor to a local `CollabDocument`. 2c-2 closes the loop:
join a real `apps/sync` room over a websocket so two browsers actually edit
together, with live presence + remote cursors. Still flag-gated; the single-user
path is untouched.

## Decision

- **Connected mode** activates when `?sync=ws://…&room=…` accompanies `?collab=1`.
  The session builds a `CollabConnection` over a `WebSocketTransport`
  (`() => new WebSocket(<syncUrl>/<room>)`) and connects. Local mode (no `?sync=`)
  is unchanged.
- **Seed-once** holds: a connected client joins **empty** (the room/server is the
  authority); only a purely-local session seeds `SAMPLE`.
- **Presence:** the session sets its `{ author, user }` state ONCE at construction
  (before yCollab binds), where `user = { name, color }` drives y-codemirror.next's
  remote-cursor rendering. yCollab then merges its `cursor` field via
  `setLocalStateField` — we never call `setLocalState` again (it would clobber the
  cursor). The app shows a live editor count from awareness.
- **HTTP health endpoint** added to `apps/sync` (a plain `http.Server` carries the
  ws upgrade) so orchestrators and Playwright's `webServer` can poll readiness.
- **Verification:** a **two-browser** Playwright e2e starts `apps/sync` (a second
  `webServer`), opens two contexts in one room, and asserts each sees 2 editors
  (presence through the server) and that text typed in one appears in the other.

## Consequences

- ✅ Real multi-user collaborative editing in the browser, through the same
  `y-protocols` wire the offline tests used — the agent-as-peer thesis, live.
- ✅ The `Transport` seam paid off: the browser plugs the DOM `WebSocket` into the
  exact `WebSocketTransport`/`CollabConnection` the unit + node tests exercised.
- ✅ Still zero risk to the MVP (flag OFF by default; the sync `webServer` only
  runs during e2e and is harmless to the single-user specs).
- ⚠️ Presence is identity + cursor only; durable cross-peer **author attribution**
  of edits (who wrote which text) is still deferred (ADR-0007) — origins don't
  cross the wire. Auth/room-authorization and persistence remain later slices.

## Alternatives considered

- **Ship a `user`/color picker UI now.** Deferred to the UX pass (2d); 2c-2 derives
  a stable color from the author id so cursors are distinguishable without UI.
- **Drive presence count off the connection rather than awareness.** Rejected:
  awareness IS the presence source of truth; reading it keeps one mechanism.
