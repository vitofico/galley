# Server & Collaboration

> The optional server pieces and the real-time collaboration architecture: the
> sync relay, rooms and presence, per-author attribution, the agent as a CRDT
> peer, and the auth seam. The web app is standalone by default — everything
> here is opt-in. The authoritative records are the ADRs
> ([`decisions/`](decisions/), especially 0005–0012 and
> [ADR-0018](decisions/ADR-0018-auth-persistence-data-model.md)) and the code.

## Topology

The "server" is several small, independently deployable services (packaged
together for self-host — see [`self-host.md`](self-host.md)):

```
 browser (SPA) ──┬─ static assets + /config.js ─► web-server  (apps/web-server; hosts the OIDC auth routes)
                 ├─ model calls ───────────────► proxy       (apps/proxy — ADR-0004)
                 ├─ CRDT sync (websocket) ─────► sync relay  (apps/sync — ADR-0008)
                 ├─ heavy compile (HTTP) ──────► compile     (apps/compile — ADR-0015)
                 └─ agent interop (consented) ─► MCP         (apps/mcp — ADR-0020/0021)
```

None are required: the browser compiles, edits, and persists locally on its
own.

## Collaboration: Yjs CRDT, with the agent as a peer

The collaboration core is `packages/collab` (framework-agnostic; Yjs only):

- **One `Y.Doc` per project.** A single-file document holds its source in a
  `Y.Text` (`CollabDocument`); a multi-file project keeps every file in one doc
  (`CollabProject`, ADR-0013) so create/rename/delete/set-main stay atomic and
  a single sync connection + IndexedDB store carry the whole project. Edits
  from multiple peers — humans and the agent — merge conflict-free.
- **Sharing is explicit.** Collaboration is never on by default. The Share
  action mints a fresh, unguessable room id (deliberately *not* the stable
  local project id) and produces a `/join/<room>` link.
- **Presence.** `CollabConnection` speaks the standard `y-protocols` sync +
  awareness messages; awareness carries each peer's `Presence` state (at
  minimum its `Author`) for cursors and who's-here UI (ADR-0010).
- **Attribution.** "Who wrote which span" is derived from a replicated `Y.Map`
  of Yjs `clientID → Author` plus a walk of the visible text items (ADR-0012).
  The `Author` type (`@galley/shared`) is
  `{ kind: "human", userId } | { kind: "agent", runId }`, so the UI can
  attribute changes across peers and delimit agent runs.
- **The agent is just another peer.** Accepting an agent run applies its
  search/replace blocks to the shared doc as a single author-tagged Yjs
  transaction (`applyAgentEdits`, ADR-0006) — with the same fail-safe semantics
  as the single-user path: each block must match exactly once in the *current*
  document, application is all-or-nothing, and a stale block is a surfaced
  conflict, never a clobber. The human Accept gate applies to every surface;
  see [`editing-and-diff.md`](editing-and-diff.md).

## The sync relay (`apps/sync`)

A thin, doc-holding y-websocket relay (ADR-0008). Per room (the websocket URL
path) it keeps a `Y.Doc` + `Awareness`, speaks the standard y-protocols sync +
awareness messages, and broadcasts each peer's updates to the others. It has
**no durable persistence**: room state lives in memory and is rebuilt from
peers' local replicas after a restart — clients persist locally via
`y-indexeddb`.

Built-in abuse bounds: a ws frame-size cap, a cap on concurrent rooms (empty
rooms are reaped), per-frame and per-connection awareness client-id caps, and a
per-connection message-rate cap — a misbehaving peer is disconnected, never
buffered. `GALLEY_SYNC_ALLOWED_ORIGINS` optionally restricts browser origins.
See [`security-model.md`](security-model.md) for the full posture.

### Storage caps (optional, default OFF)

For a **persisted** relay (`GALLEY_SYNC_PERSIST_DIR` set), an optional
`StorageQuota` bounds how much CRDT state a room may accumulate. **Absent (the
default) the relay does no accounting and is byte-for-byte unchanged.** When
configured it gates only **growth** writes (a peer pushing new content); reads,
joins, and initial sync are **never** blocked — availability over enforcement for
data the user already has.

- **Content cap** — a per-room byte ceiling on the CRDT document. A write that
  would cross it is refused **before** it is applied: nothing lands in the doc or
  the append log, the socket **stays open**, and the server sends a typed
  `messageStorageFull` control frame (its own ws frame; older clients ignore the
  unknown type). The cap is a soft bound — one admitted update may overshoot it
  (an encoded update's size ≠ the document growth it causes). y-sync has no
  per-update acknowledgement, so a refused growth update silently remains
  client-local — this frame is the **only** signal a client gets that its edits
  have stopped reaching the room. Clients that do not decode it will show what
  looks like working sync while diverging; the next under-cap sync re-offers the
  full missing diff and heals.
- **Delete-only updates always admit** — a user is never locked out of shrinking
  their own document, even at the cap (Yjs tombstones mean a delete can still
  grow the encode slightly; that overshoot is accepted to keep the escape hatch
  open).
- **Raw-log hard ceiling** — a flat cap on the append log. A merely bloated
  history is first relieved by compaction; only when the **compacted** footprint
  still exceeds the ceiling is a growth write refused.
- **Compaction high-water** — the log is folded to one snapshot once it exceeds
  `max(floor, 2× the content size)`, so steady editing never triggers a recompute
  on the hot path.
- **Provider failure ≠ out of space** — if the quota provider is temporarily
  unavailable, growth writes fail **closed** with a *distinct* signal
  (quota-unavailable), never "you are out of storage"; a transient flap resolves
  on its own and writes resume.

Scope: "content" is CRDT bytes only. Binary assets/blobs are **not** counted —
they never persist server-side (a separate ws subprotocol forwards them
peer-to-peer). Self-hosters set flat per-deployment caps via
`GALLEY_SYNC_MAX_CONTENT_BYTES`, `GALLEY_SYNC_MAX_LOG_BYTES`, and
`GALLEY_SYNC_COMPACT_FLOOR_BYTES`; an invalid value fails loud at startup.

**Binary blobs (local store: quota + GC).** Blob bytes never persist
server-side — a separate `galley-blob-v1` websocket subprotocol forwards them
peer-to-peer. Each project's client-side blob store enforces a byte cap (default
512 MiB; a `put` past it fails closed with a typed quota error, checked
atomically so concurrent puts can't race past the cap) and, for LOCAL/offline
(solo) projects only, runs a one-shot orphan sweep once the store has hydrated —
reclaiming bytes no live-or-tombstoned pointer references, re-validating against
a fresh snapshot immediately before each delete so a concurrently-added pointer
is never swept, and never evicting a referenced blob. A shared/connected session
never runs the destructive sweep (its doc is peer-writable and hydrates
asynchronously, so no client reference set is authoritative); quota still
applies. There is no server-side blob GC or quota — both are per-client.

**Binary-blob sync (D1: online-only, servable-provenance).** In a shared room a
connected peer discovers the bytes it is missing over the CRDT **awareness**
channel and pulls them over the `galley-blob-v1` byte channel — no server change
(the relay stays a blind byte forwarder; it never sees bytes, roles, or blob
markers). A peer that references a binary pointer but lacks its bytes publishes an
additive awareness **want-list** (the hashes it needs); a peer authorized to
disclose those bytes answers on the byte channel. Two roles, kept structurally
separate so requester state can never become serve authority:

- **Requester (demand).** The peer-writable project snapshot is used *only* to
  decide what bytes *this* peer needs — its referenced-and-missing binary
  pointers (including tombstoned ones, whose bytes are retained for restore). The
  session `expect()`s each missing blob on the byte channel *before* advertising
  it, and reconciles exactly: a pointer that disappears, becomes locally
  available, or changes size is `unexpect`ed and dropped from the want-list.
- **Holder (serve).** A peer serves a wanted hash **only if it is
  servable** — i.e. it holds a durable, device-local `servable:` provenance
  marker for that hash **and** the verified bytes are present. "I reference this
  hash in my snapshot" is *not* authorization: the snapshot is peer-writable, so a
  hostile room member could otherwise name a victim's pending (not-yet-Accepted)
  hash and pull pre-Accept bytes. A marker is earned only after a **trusted local
  action lands** (local upload/paste/drag-drop, a committed import/restore, or a
  successful Accept — including a valid operator-armed auto-accept — of an
  agent/MCP binary create), never from a peer-written pointer, byte receipt, or
  merely finding the hash in the live snapshot.

**Non-transitive by design.** Bytes pulled from a peer are stored as a **neutral
cache** — renderable and exportable locally, but *not* re-servable (generic
`put()` never grants a marker). This trades gossip availability for
confidentiality: D1 requires at least one **locally-authorized** holder to stay
online, an honest limitation of an online-only design. (If that peer later
performs a qualifying local action for the same hash, its already-cached bytes
become servable with no rewrite.) **Legacy blobs fail closed:** markers are never
back-filled from a snapshot — a pre-existing blob becomes servable only after a
new qualifying local action. Serve work is bounded per `(peer, hash)` to two
attempts (initial + one retry); the want-list's `requestId` is freshness metadata
only and carries no authorization or work-budget meaning.

## Auth (optional, fail-closed)

Auth is **off by default** — open rooms, no login: the zero-config local mode.
For networked deployments, `packages/auth` implements an OIDC Authorization
Code + PKCE core with a pluggable IdP (Keycloak, Authentik, Auth.js, a cloud
IdP — no hard coupling to one vendor). The web-server hosts the auth routes and
mints sessions; the sync relay (`GALLEY_SYNC_AUTH=required`) gates each
websocket upgrade on a valid session **and** project membership. Sessions and
project/membership records live in shared durable dirs (`GALLEY_SESSION_DIR` /
`GALLEY_DATA_DIR`) read by both services; a misconfigured service **refuses to
start** rather than appearing authenticated while authorizing no one.
Configuration: [`self-host.md`](self-host.md). Data model:
[ADR-0018](decisions/ADR-0018-auth-persistence-data-model.md).

The browser packages stay identity- and authorization-agnostic; enforcement
lives at the service edges.

### Internal service membership read (optional, off by default)

For service-to-service deployments — a hosted control plane fronting a
self-hosted Galley — the web-server can expose ONE authenticated read for
"can this user reach this project?":

```
GET /internal/projects/:projectId/membership/:userId
Authorization: Bearer <EdDSA JWT>
→ 200 { "membership": { "source": "project", "role": "editor" } }
       { "membership": { "source": "group",   "role": "member" } }
       { "membership": null }     // not a member (or unknown project)
→ 401 (bad/absent token) · 503 (store fault → the caller fails closed)
```

It re-expresses the group-aware authorization decision (a direct project role
wins; otherwise a role inherited from the owning group; otherwise none) as the
**why**, so a control plane can resolve access against the self-host's own
project/group stores. Posture:

- **Token:** a short-lived compact JWT, verified against a configured **SPKI
  public key** with a strict **`EdDSA`** algorithm allowlist. `iss`, `aud` and
  `exp` are all **required** (a token without an expiry is rejected). The `aud`
  claim must be the **exact configured scalar** — an array-valued `aud` is
  rejected — so **give each deployment its own unique audience** and have the
  control plane mint that scalar; a token minted for one self-host then cannot be
  replayed against another that shares the key and issuer. The public key must be
  a single-block **Ed25519** SPKI PEM (a wrong-curve or multi-block key fails loud
  at startup). Verification happens **before** any identifier is parsed or any
  store is touched; a failure is a constant `401`. Every response is
  `Cache-Control: no-store`.
- **No oracle:** an unknown project is indistinguishable from a genuine
  non-member — both answer `200 { "membership": null }`.
- **Fail closed:** a store fault answers `503` (the caller treats it as
  "unknown → deny"), never a false negative membership.

Enable it with three env vars (all three, plus the shared `GALLEY_DATA_DIR` the
route reads membership from): `GALLEY_INTERNAL_SERVICE_PUBLIC_KEY` (SPKI PEM, or
a whole-PEM base64 wrapping), `GALLEY_INTERNAL_SERVICE_ISSUER`,
`GALLEY_INTERNAL_SERVICE_AUDIENCE`. A partial set fails loud at startup. Unset →
the endpoint is **absent** and the served app is byte-for-byte unchanged: a
self-hosted setup that never talks to a control plane loses nothing.

## Persistence & versioning

- **The CRDT is the single source of truth.** Live project state persists
  locally in the browser via `y-indexeddb` (ADR-0011); the sync relay is
  transport, not storage.
- **Named versions** are materialized file-tree snapshots stored locally; git
  is a **one-way projection** (`packages/persistence`,
  [ADR-0019](decisions/ADR-0019-browser-git-transport.md)) for export and
  remotes — never a competing source of truth.
- Stored-row schema changes are handled by the forward-only migration seam —
  see [`storage-migrations.md`](storage-migrations.md).

### Project config (`.galley/*`) in exports & versions

The reserved `.galley/` namespace holds project config, not documents: the
synthesized `.galley/project.json` manifest and the optional
`.galley/instructions` agent-steering file. It is hidden from the file tree,
compile inputs, agent context, and `.bib` scanning; `materializeProject`
(`@galley/collab`) filters it out of the projected tree by default. The two
projection consumers diverge deliberately:

- **Exports round-trip instructions.** The `.tar` source bundle, the
  bare-git-repo export, and git remote push project the tree with
  `materializeProject(snapshot, { includeInstructions: true })`, so
  `.galley/instructions` travels at its real path (it is never listed in the
  manifest's `files` map). On import, `restoreProjectFromTree` fences the whole
  reserved namespace out of its create/diff/tombstone loop, drops any path that
  fails `isSafeProjectPath` (non-normalized forms, traversal, control
  characters), and applies a tree-carried instructions file through the single
  coalescing write seam (`writeProjectInstructions` in `apps/web`). Re-importing
  an identical tree is a no-op; a tree without instructions leaves existing
  instructions untouched.
- **Version snapshots stay config-free.** Saving a named version uses the
  default projection, and restoring one never touches `.galley/instructions`:
  rolling a document back to last week must not clobber the agent steering
  written since.
