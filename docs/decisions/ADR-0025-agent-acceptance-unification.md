# ADR-0025 — Agent acceptance unification: one per-project mode, per-record apply, hardened in-app Auto

- **Status:** Accepted (Architect-GPT consulted, 2026-06-18). **Extends**
  [ADR-0023](./ADR-0023-mcp-auto-accept-provenance.md) (provenance + opt-in
  auto-accept + reload re-bind) and [ADR-0024](./ADR-0024-mcp-workflow-honest-liveness.md)
  (honest liveness + global review surface). Does **not** supersede them — it
  reworks the *UX/control layer* on top while keeping every security guarantee.
- **Scope:** roadmap #16 (MCP) + the in-app agent acceptance UX.

## Context

Accepting agent-proposed document changes is heavier and noisier than it should
be: an MCP run emits several `propose_*` records → several Accept clicks; the
auto-accept control (`AutoAcceptBar`) is a buried two-step arm/confirm; pending
state is counted per-proposal not per-request. Worse, there are **two unrelated
acceptance surfaces** — the in-app agent (accumulates a run into one inline
`DiffReview`, applies directly, no auto mode) and the MCP agent (one mailbox card
per record, the `AutoAcceptBar` auto path). The goal is to make acceptance
**flow** — decide once per project, ≤1 decision per run, zero in Auto — with one
unified UX, **without** widening the trust boundary ADR-0023 established.

## Decision

### 1. One per-project acceptance mode (UI), two authoritative stores

A single **Agent access** panel presents a per-project choice — **Ask** (default)
or **Auto** — governing both agents. But authority does **not** collapse into one
per-project flag:

- **MCP authority** lives **only** inside the **MAC'd `ProposalGrant`** as
  `mode: "ask" | "auto"`, bound to the full grant identity
  (`grantId + controlRoom + syncUrl + projectId + shareRoom + mailbox`). MCP
  auto-apply reads **only** this value. A plain project setting must **never**
  authorize MCP auto-apply. New grants default to **Ask**.
- **In-app authority** is a local per-project `agentAcceptanceMode` setting
  (named to avoid colliding with the editor layout `agentMode`). The in-app agent
  reads only this.

The panel is a *presentation* over these two stores; it may edit both when both
surfaces exist, but never mirrors the plain setting into grant authority.

### 2. `runId` is a grouping hint, never an authenticator

Proposal records gain an optional `runId`; the kernel tags one run's proposals
with one `runId` and emits `run_start`/`run_end` (idle-close fallback). The
browser groups a run's pending records into **one run card** (Accept-all / expand
/ Reject-all). `runId` **never gates apply** — every record still verifies,
checkpoints, tombstones, TOCTOU-rechecks and applies **independently, per record**
(the ADR-0023 path is unchanged). A forged/reused `runId` can at worst mis-group a
card. Records without `runId` form singleton legacy runs.

### 3. MCP Auto stays per-record with a final pre-apply mode re-check

Auto only flips the disposition hold→auto-apply. A valid grant-scoped signature
remains the real authenticator (Auto never admits an unsigned/foreign proposal).
The mode is **re-read at the final pre-apply check** (after TOCTOU): a flip to Ask
/ kill-switch wins immediately. Ask→Auto affects **future records only**.
**Single-auto-applier ownership** is required per grant (lease over awareness);
ambiguous ownership **fails closed to Ask**.

**Explicit-arm carve-out (F7).** The future-records-only rule suppresses the
**passive** backlog: a grant that *drifts* to Auto, or a programmatic/inherited
mode change (e.g. `inheritedGrantMode` on a re-share), must never retroactively
auto-apply records that were pending while the user sat in Ask. An **explicit user
click selecting Auto** in the panel is different — it is deliberate intent acting
on the very backlog the user is looking at. On that Ask→Auto edge *with an active
grant*, the currently-pending paired-agent records are promoted to eligible via the
pure `promotePendingToEligible` (auto-accept.ts) and re-driven through the
**unchanged** full gate chain (armed / viewer-joined / pending / signature /
replay-audit / monotonic-seq / volume) + the live final-apply gate + the
single-auto-applier lock. Promotion lifts **only** the first-sight suppression and
**widens no trust**: only the active grant's signed proposals can pass (the verifier
and `scopeFor` are unchanged), and every authorization gate still runs per record. A
passive/programmatic mode change never calls `promotePendingToEligible`.

### 4. In-app Auto is a manual-Accept-equivalent path, not a bare apply

On `run_finished` with mode Auto: `canMutate` gate → checkpoint (Undo target) →
conflict re-check (`resolveAccept`) → local audit entry → apply → transcript
summary + Undo. On any failure (viewer, checkpoint fails, conflict), **fall back
to the Ask `DiffReview` gate**. No signature is needed (own browser, no foreign
writer), but the checkpoint+audit+Undo+canMutate path satisfies the amended
invariant.

### 5. Notifications per run; `AutoAcceptBar` retired

`PendingReviewBadge` counts **runs**, not proposals. Auto-applied runs always
leave a summary + Undo (inline for in-app; audit entry + transient toast for MCP).
`AutoAcceptBar` and its two-step arm/confirm are deleted; its kill-switch + audit
list move into the Agent access panel.

### 6. Amended invariant

> No surface auto-applies a document edit without an explicit, audited, undoable
> per-project authorization (Auto mode), enforced per authoritative store. Ask
> mode (the default) keeps a mandatory human Accept gate.

This replaces the absolute "no surface ever auto-applies" wording, reconciling the
invariant with ADR-0023's already-shipped opt-in auto-accept.

## Consequences

- **Positive:** one decision per project; ≤1 per run; zero in Auto. Unified mental
  model. The trust boundary is unchanged — MCP auto authority stays inside the
  MAC'd grant + signature gate; in-app Auto stays inside the user's own browser
  with checkpoint/audit/Undo.
- **Negative / cost:** a new `runId` field + grouping, kernel run boundaries, a
  grant-field migration (`autoAccept`→`mode`, fail-closed), a single-auto-applier
  ownership lease, and a new panel. Large effort.
- **Risk mitigations:** migration MAC-verifies the old blob shape before rewrite
  (tampered → no grant); `runId` is non-authoritative; run-end spoofing only
  changes a card's "in progress" label, never auto-accepts.

## Non-goals (unchanged from ADR-0024)

Single shared room and the `--pair` launcher remain deferred. No change to the
signing scheme, relay/liveness model, or the in-app agent's tool loop.
