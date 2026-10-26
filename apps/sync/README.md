# @galley/sync — collaboration sync server

A self-hostable y-websocket relay for `@galley/collab` peers. Each room holds a
Y.Doc and awareness, serving late joiners and broadcasting live edits.

```bash
pnpm --filter @galley/sync start      # PORT=1234 by default
```

Clients connect to `ws://<host>:<port>/<room>`. No-auth, in-memory operation stays
the default. Optional configuration adds OIDC-session/project or group membership
authorization, exact Origin gating, persisted compacted CRDT logs, owner-wide
resource policy, service-authenticated lifecycle retirement, and durable hosted
binary assets with bounded retained history. Binary bytes never enter Yjs.

`galley-blob-v1` remains the keyless peer relay. Opt-in
`GALLEY_SYNC_HOSTED_BLOBS=1` adds the separate `galley-hosted-blob-v1` storage
channel and authenticated history endpoints on the same server. It requires
persistent storage, required authentication, an exact Origin allowlist and an
aggregate resource policy; it preserves peer terminal MAC semantics.

See [self-host configuration](../../docs/self-host.md),
[collaboration](../../docs/server-and-collaboration.md), and
[hosted storage, history and lifecycle contracts](../../docs/account-lifecycle-and-resource-policy.md).

The root Vitest gate includes real ephemeral WebSocket/HTTP tests for live sync,
auth, restart persistence, hosted upload/pull, shared quota, history and retirement.
