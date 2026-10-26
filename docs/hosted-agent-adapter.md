# Optional hosted agent adapter

The local agent stays unchanged unless the web-server is configured with
`GALLEY_HOSTED_RUNS_API_PATH` (for example `/cloud/api/agent-runs`). The optional
`GALLEY_HOSTED_ACCOUNT_PATH` links to the host's account UI. Both are same-origin
paths; external, encoded, traversal, query and fragment paths are refused.
The runtime config exposes `hostedRuns: { apiPath, accountPath? }`. Credentials
stay same-origin and redirects are refused. Commercial plans, provider selection,
entitlements and quotas belong to the host.

The editor sends no run or project data before a human reviews the consent
dialog and clicks **Send snapshot and start run**. This connects the full project
to the configured sync service (including its mailbox capability) and sends the
prompt plus an immutable active-file snapshot to the hosted executor/provider.
The exact request and file are reviewable. The combined JSON prompt is capped at
12 KiB UTF-8; oversize input is refused without truncation or a provider request.
The browser remembers the consented mailbox, scoped to the project and hosted
mount, and only reconnects to the currently configured relay. Stop sharing drops
the remembered target. Reload/reconnect never resubmits a model request.

Hosted drafts are unsigned mailbox proposals. They always use the existing
explicit editor Accept/Reject and conflict-aware multi-file apply path, including
when local in-app Auto mode is selected. Hosted preparation does not grant a
paired MCP agent file-content or auto-apply authority. A hosted executor validates
proposal structure; it does not promise a compile-clean draft. The editor compiles
after acceptance. Live user typing remains independent of the captured snapshot.

The generic JSON contract is:

- `GET apiPath?keyName=default` returns `{ runs, access, keyConfigured,
documentRuns }`. `access` is `enabled`, `upgrade_required`, or `restricted`.
  Key status is metadata only. Up to 100 owner-scoped runs are returned.
- `POST apiPath` takes `{ kind: "document", prompt, keyName, clientRef,
draftTarget: { syncUrl, room } }` and returns `{ runId }`. `clientRef` is a
  bounded browser project association and never an authorization input.
- Runs contain `{ id, kind, state, createdAt, updatedAt, clientRef?, draftRef?,
error? }`. State is `queued`, `running`, `awaiting_accept`, `accepted`,
  `rejected`, `failed`, or `canceled`. Document server state stays
  `awaiting_accept` after editor review; the editor reads the actual mailbox
  verdict. Draft refs are `doc:<association>:<proposalId>` and contain no room.
- `POST apiPath/:id/cancel` requests cancellation. Already-delivered drafts may
  still need review. No hosted endpoint accepts document proposals for a human.
- `POST apiPath/:id/reviewed` takes `{ draftRef, decision: "accepted" | "rejected" }`
  after the browser observes a corresponding mailbox verdict. It records an
  owner-reported `reviewedAt`/`reviewDecision` hint for pending quota/retention.
  Server state stays `awaiting_accept`; this route never applies/promotes a
  document or proves that an editor accepted it. A failed metadata update has a
  separate retry affordance and never repeats model work or editor application.
- Sibling `PUT /api/model-keys/:name` saves `{ secret }`; `DELETE` removes a
  named slot, including after downgrade. The key never returns in a response or
  enters browser persistent storage. Names use 1–64 letters, digits, `_` or `-`.

The browser polls status every three seconds while mounted. It never automatically
retries a create. An interrupted create, provider error or server restart directs
the human to refresh and inspect pending drafts before an explicit new request.
Authentication, exact-Origin mutation checks, owner filtering, execution quotas,
durability and provider cancellation are the host's responsibility. Ordinary local
operation has no hosted probes or requests when the adapter is absent.

`GALLEY_SYNC_HOSTED_BLOBS=1` independently exposes `hostedStorage: true` in the
web runtime config for optional durable asset/checkpoint adapters. The existing
History panel can list/compare hosted checkpoints; Restore remains an explicit
human action applying fresh CRDT edits, including binary pointers.
