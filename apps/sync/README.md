# @galley/sync — collaboration sync server

A thin, doc-holding [y-websocket](https://github.com/yjs/y-websocket) relay for
`@galley/collab` peers (ADR-0008). Per room (the websocket URL path) it keeps a
`Y.Doc` + `Awareness`, speaks the standard `y-protocols` sync + awareness wire
format, and broadcasts each peer's updates to the others.

It is the network half of the collaboration core: the browser editor and the AI
agent connect as peers (`CollabConnection` over a `WebSocketTransport`) and merge
conflict-free through this relay.

## Run

```bash
pnpm --filter @galley/sync start      # PORT=1234 by default
PORT=4000 pnpm --filter @galley/sync start
```

Clients connect to `ws://<host>:<port>/<room>`, where `<room>` is the document id.

## Scope

- ✅ Per-room CRDT relay + awareness/presence, holding canonical room state so a
  late joiner syncs even with no peer online.
- ❌ No auth / room authorization yet (rooms are open).
- ❌ No persistence yet (room state lives in memory for the process lifetime).

Both are explicit later slices (see `docs/roadmap.md` and
`docs/server-and-collaboration.md`). This service is the transport, not the
security or durability story.

## Tests

Run from the root Vitest gate. `src/sync-server.test.ts` starts the server on an
ephemeral port and drives two real `CollabConnection`s over real `ws` sockets —
initial sync, two-way live edits, presence, late-join catch-up, and clean
departure.
