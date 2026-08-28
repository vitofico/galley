# ADR-0008 — Collaboration Phase 2b: the y-websocket sync server (`apps/sync`)

- **Status:** **Accepted**
- **Date:** 2026-06-07
- **Builds on:** [ADR-0007](ADR-0007-collaboration-phase2-sync-core.md) (the transport-agnostic
  sync core), [ADR-0004](ADR-0004-model-proxy.md) (the precedent: a thin, self-hostable Node service)

## Context

ADR-0007 built the sync core against an abstract `Transport`, proven offline.
The next certainty-order step is to validate that seam against a **real network**
and ship the server half. The core already speaks the standard `y-protocols`
wire format, so the server is a thin relay rather than new protocol code.

## Decision

- **`WebSocketTransport`** (in `@galley/collab`): a `Transport` implementation
  over an **injected** `WebSocket`-like object (a factory). It references only the
  structural WebSocket interface — no `ws`/network library import — so the package
  stays library-free (the same dependency-injection discipline as the injected
  WASM compiler). The browser supplies `window.WebSocket`; Node tests inject `ws`.
  It buffers sends until the socket opens (the handshake is queued synchronously
  on `connect()`).
- **`apps/sync`** (new Node app, mirrors `apps/proxy`): a **doc-holding relay**.
  Per room (the ws URL path), it keeps a `Y.Doc` + `Awareness`; on connect it
  sends sync step1 + current awareness; it applies inbound sync/awareness with the
  connection as origin and **broadcasts to the other peers in the room**; on close
  it removes that connection's awareness clients. This is the standard y-websocket
  server shape, ~100 lines, speaking the exact bytes the core already speaks.
- **Validation:** an integration test starts the server on an ephemeral port and
  drives **two real `CollabConnection`s over real `ws` sockets** — initial sync,
  two-way live edits, presence, and a late joiner catching up **from the server**.

## Consequences

- ✅ De-risks the whole stack end-to-end over a real socket, with the editor
  binding (Phase 2c) still ahead — exactly the certainty-order bet.
- ✅ The server holds canonical room state, so a late joiner syncs even if no peer
  is online (and the door is open to persistence later — y-leveldb/git).
- ✅ Zero risk to the green MVP: `apps/sync` is additive and isolated; nothing in
  the shipping web app imports it yet.
- ⚠️ Still no auth / room authorization (rooms are open) and no persistence — both
  are explicit later slices (roadmap 4). The relay is the transport, not the
  security or durability story.
- ⚠️ Cross-peer author attribution still does not ride the wire (ADR-0007); the
  server relays opaque Yjs updates.

## Alternatives considered

- **Dumb byte-broadcast relay (no server `Y.Doc`).** Works with the core's
  symmetric handshake (peers sync each other), but a late joiner then needs a peer
  online and there's no path to persistence. Rejected: holding the doc is barely
  more code and is the standard, more robust shape.
- **Reuse `y-websocket`'s bundled server utilities.** Rejected: it couples to that
  package's server internals and its own CLI/persistence assumptions; a ~100-line
  relay over `y-protocols` (which we already depend on) is clearer and ours.
- **Put `WebSocketTransport` in `apps/sync` or the web app.** Rejected: injected
  into `@galley/collab` it is reusable by both the server tests and the future
  browser editor without a server→browser import, and it adds no library dep.
