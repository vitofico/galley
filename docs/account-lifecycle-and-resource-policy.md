# Optional account lifecycle and resource policy

Self-hosted deployments keep their existing behavior when these settings are
absent. These mechanisms contain no prices or commercial tier names.

Set `GALLEY_ACCOUNT_LIFECYCLE_KEY_FILE` in web and sync to the same private regular
file containing exactly 32 random bytes (mode 0600). Web also requires
`GALLEY_DATA_DIR`, `GALLEY_SESSION_DIR`, `GALLEY_SYNC_PERSIST_DIR`, and
`GALLEY_SYNC_INTERNAL_URL` (the relay's fixed HTTP origin). Sync requires its
existing required authentication, persistence and exact Origin allowlist.

Web mounts service-only `POST /internal/accounts/{preflight,export,close,purge,status}`.
Requests carry `Authorization: Bearer <base64url-key>` without a Cookie. Bodies
are limited to 4096 bytes and identify `subject`; close and purge also require a
stable `operationId`. Subjects are the core's stable user IDs: OIDC IDs use
`oidc:` followed by base64url SHA-256 of `issuer + NUL + sub`, never an email.

Preflight reports shared personal projects, share rooms and groups requiring
administration transfer. Close requires explicit `deleteOwnedShared: true` for
owned shared data. Sole administrators must transfer administration first.
Group-owned documents and other users' projects are preserved.

Closure commits hashed fences in both data and session roots, revokes sessions,
and blocks late project/group/capability mutations. Purge rechecks recorded
consent and current sharing. A late sharing change stays pending until fresh
consent. The final ownership check, live room retirement and deletion share the
project writer lock. Retirement disconnects sync and blob peers, waits for pending
persistence, and leaves a durable room tombstone so a late append cannot recreate
the room. Access is also revalidated on live sockets.

Receipts bind version, operation, subject hash and state (`closed` or `purged`).
Retries are idempotent. A failed relay acknowledgement leaves purge pending.
After purge, minimal hashed fences remain. Export streams NDJSON containing
accessible project metadata and owned persisted document/version files in bounded
base64 chunks, ending with `core-export-complete`. Credentials and other owners'
contents are excluded. Consumers must reject partial exports. Identity-provider
administration and payment cancellation belong to the caller.

Set `GALLEY_STORAGE_POLICY_URL` and `GALLEY_STORAGE_POLICY_KEY_FILE` on web and
sync to enable an optional generic resource policy. The latter is a private
32-byte service key. Web applies `maxOwnedProjects` to active personal projects
and share registrations; `null` means unlimited. Sync accounts for persisted and
live CRDT contents across all registered rooms of an owner, using injected
`maxBytes` rather than a separate allowance per room. Group owners use a separate
`group:<id>` policy subject.

The bounded service request is `{subject}`. The response is
`{maxBytes,maxOwnedProjects,expiresAt}` (epoch milliseconds, at most five minutes
ahead). Invalid, unavailable or expired policy denies growth. Reads, export and
delete-only edits remain available. Delete-inflated live usage is reconciled
before refusing a shared budget. Single web/relay writers are required for the
filesystem adapters; multiple relay replicas require transactional shared
accounting rather than separate in-memory indexes.

Backups include data, sync and session roots consistently, with writers stopped.
Reapply the latest deletion/retirement fences before restoring traffic. Web and
sync refuse roots containing `RESTORE-QUARANTINE.json`; operators complete the
separate restore/reconciliation procedure before removing it.

## Durable hosted assets and retained history (optional)

Set `GALLEY_SYNC_HOSTED_BLOBS=1` on both web and sync to enable the browser's
hosted-storage companion channel. Sync refuses this mode without persistence,
required authentication, exact allowed Origins and the aggregate resource policy
above. Without this setting the peer relay and local storage behavior remain
unchanged. `HostedStorage` in `@galley/shared` is the optional adapter contract;
`FsHostedStorage` is the single-writer filesystem implementation.

`galley-hosted-blob-v1` uses the same room URL, membership/capability authorization
and Origin gate as sync. This point-to-point channel reuses bounded HEADER/DATA/
ACK/COMPLETE framing and verifies size and SHA-256 before writing. Its bounded
REQUEST frame (tag 6, transferId/hash/size) requests a stored hash within that room;
the peer relay rejects this tag. Hosted completion comes only after the atomic write, file fsync and directory
barriers through the configured storage root succeed. It never substitutes for the peer channel's scoped terminal MAC,
and the server neither knows nor signs a peer grant key. Uploads and reads
revalidate authorization; hosted mode also enables live-connection revalidation.
The transport limits a blob to 64 MiB. Per-room connection/inflight limits,
process-wide byte reservations, rate limits and socket backpressure bound work;
these are safety ceilings, not capacity measurements.

The browser uploads referenced bytes only when its durable local servable marker
permits sharing. A remote CRDT pointer alone cannot cause a local upload. Missing
referenced hashes request hosted bytes without requiring an online peer. Received
bytes remain a neutral local cache, with independent integrity checks. Upload
failure leaves local bytes intact and reports that hosted saving failed. The
browser bounds concurrent uploads and retries within each connected session.

Assets live in `assets/<room>/<sha256>.bin` under `GALLEY_SYNC_PERSIST_DIR` and are
deduplicated within the room, never across authorization boundaries. Checkpoints
live in `history/<room>/<timestamp>-<sha256>.bin`. The aggregate owner budget
counts compacted live/persisted CRDT content, actual stored asset bytes, retained
checkpoint bytes and existing server git-version files. Reservation happens before
an async write, remains charged through concurrent CRDT writes, rolls back on a
failed write, and is rebuilt from disk on restart. Delete-inflated live CRDT bounds
are reconciled before refusing an asset/history reservation. Ownership changes are
rechecked; group projects charge `group:<id>`. Invalid owners, closure fences and
unavailable policies deny growth. No second allowance is created for binaries or
history. Raw CRDT append-log overhead retains its separate log/compaction bound.

Checkpoints are taken at durable compaction (including idle/shutdown), and via the
editor's explicit Save Version action. History is bounded to **20 checkpoints**
and **30 days** by default, configurable with
`GALLEY_SYNC_HISTORY_MAX_VERSIONS` (1–1000) and `GALLEY_SYNC_HISTORY_DAYS` (1–365).
Age pruning runs when listing or creating history. A replacement reserves its
full bytes while the previous retained set remains intact, commits and fsyncs the
new checkpoint, then durably prunes the excess before successful publication. An
interruption during final pruning can leave one extra charged checkpoint; the next
list or write reconciles it. Failed or quota-denied replacements preserve the
previous retained checkpoint. Checkpoints have a 64 MiB ceiling and consume the owner's existing
budget; a full budget may prevent a new automatic checkpoint. These are retained
checkpoints, not a guarantee of every edit or every minute. Local named versions
remain available independently.

Authenticated `GET /history/<room>` lists immutable checkpoint descriptors;
`GET /history/<room>/<id>` returns integrity-addressed CRDT bytes. `POST
/history/<room>` requires an exact allowed Origin and creates a canonical relay
checkpoint. Its optional bounded JSON `expectedTreeHash` must match SHA-256 of
`JSON.stringify(materializeProject(snapshot).result.files)`; a lagging/different
relay answers 409, preserving the local named version without claiming a hosted
save. Exact-Origin credentialed CORS supports the browser's configured relay.
These routes are absent when hosted storage is off. Policy failure cannot block
reads or account export. Responses are not cached.

Hosted checkpoints appear in the existing history list and text comparison. An
explicit human Restore action decodes into a separate document, validates paths,
content hashes and pointer sizes, then restores text and binary pointers as new
human-authored CRDT operations. Old Yjs items are never merged into live state to
attempt a rollback. Project instructions remain untouched. Missing restored asset
bytes are fetched through the ordinary blob-sync path.

Account export includes owned assets and retained checkpoints in the same bounded
NDJSON file chunks as CRDT contents. Shared membership alone does not export
another owner's stored bytes. Room retirement disconnects both byte channels,
drains writers and deletes CRDT, assets and history behind the common irreversible
room tombstone; this deletion also applies when hosted mode has since been turned
off. Group-owned data survives a departing creator. Hosted files and checkpoints
are already within the existing stopped-writer sync-root backup, so no separate
storage root is omitted from backup/recovery. Restores remain quarantined until
the latest deletion fences have been replayed. Orphan uploaded assets remain
charged until room/account purge; soft-deleted pointers are retained for restore,
and no background sweep guesses that peer-controlled references can be discarded.

## Asynchronous admission and delivery recovery

WebSocket input is paused with transport backpressure during authorization and
persisted-room loading, then resumed after the selected channel installs its
handlers. Early state-vector probes are preserved without an application payload
queue. Quota resolution never blocks reads; growth still fails closed while its
policy is unresolved or unavailable. The first successful policy resolution, or a
successful refresh after refusals, sends a standard SyncStep1 to existing peers.
They re-offer missing Yjs state through the same admission check. The relay keeps
no rejected update buffer. Per-room request tokens prevent a reaped room's stale
policy result from affecting a replacement room.

Headless draft-publisher flush observes storage refusals. A read reply alone cannot
confirm rejected growth. On a server-requested resync it replays the same CRDT
proposal, then requires a fresh ordered probe reply without another refusal.
This retries synchronization only; it never re-runs a model or mints a second
proposal. Persistently refused growth times out without claiming delivery. Default flush confirms live relay application. The optional durable delivery
contract below additionally requires a software filesystem barrier; neither mode
claims hardware/power-cut verification.

## Optional durable draft delivery acknowledgement

Set sync `GALLEY_SYNC_DURABLE_DELIVERY=1` to opt into `SyncServerOptions.durableDelivery`.
It requires a configured persistent `CrdtStore` with `flush(projectId)`. The
filesystem adapter atomically writes each append and compacted snapshot, fsyncs
the file before rename, and fsyncs directories through the configured storage
root. Explicit flush also fsyncs existing snapshots/logs written by older adapters.
This is a software persistence barrier, not evidence from a hardware power-cut or
storage-provider failure drill. Stateless/default configurations stay off.

A headless publisher selects `DraftPublisherOptions.requireDurableDelivery: true`
when it must not report a recoverable draft delivered from RAM alone. Its existing
replay-aware delivery barrier runs first, then an additional request on the same
authorized sync WebSocket. The separate top-level message is varuint **5**, followed
by an operation (0 request, 1 complete, 2 unavailable), a length-prefixed ASCII token
(16–64 characters), and, for a request only, a length-prefixed Yjs state vector.
The current publisher mints a fresh 192-bit token. Replies echo only that token;
unknown or expired tokens cannot settle another probe. Old clients ignore this
separate control frame and the public option defaults to false.

Vectors are bounded to 64 KiB and 4,096 unique client clocks. Before flushing, the
relay checks that its actual integrated clocks dominate the request's expected
clocks. An ordinary read reply therefore cannot stand in for rejected growth or
unresolved pending structs. It waits all append operations issued before the
request, calls the store flush, and rechecks the same live room generation and
failure latch before sending Complete. Any append or flush failure latches the
room against durable success until it is reloaded; swallowed best-effort append
errors cannot produce a false acknowledgement. Room retirement, unavailable
persistence, unsupported/off mode, missing state and failure all deny success.

At most eight probes per socket and 64 per process may be outstanding. The server
answers unavailable after ten seconds, but retains the work slot until underlying
I/O actually settles so timeouts/disconnects cannot create an unbounded queue.
The publisher uses the existing flush deadline (15 seconds by default) across
both phases, bounds pending tokens, and rejects on timeout or link loss. Repeated
probes only check the same CRDT state; they never execute a model or mint another
proposal. A failure may leave a pending proposal that needs inspection; it never
claims that the draft is safely stored.

When an account policy is configured together with static sync limits, CRDT room
content uses the smaller of `GALLEY_SYNC_MAX_CONTENT_BYTES` and the owner budget.
`GALLEY_SYNC_MAX_LOG_BYTES` and `GALLEY_SYNC_COMPACT_FLOOR_BYTES` remain effective;
aggregate owner accounting does not discard these independent per-room bounds.
