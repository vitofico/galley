# ADR-0023 — Authenticated proposal provenance + opt-in MCP auto-accept

- **Status:** Accepted (Architect-GPT + Security-Analyst-GPT consulted,
  2026-06-17). Supersedes the auto-accept **deferral** recorded in
  [ADR-0020](./ADR-0020-mcp-local-kernel.md) (2026-06-17 addendum): "An
  auto-accept opt-in … is deferred: it relaxes human review of UNSIGNED,
  peer-writable mailbox records, so it needs an authenticated-proposal-provenance
  design first." This ADR supplies that provenance design and builds auto-accept
  on top of it.
- **Scope:** roadmap #16 (MCP). Builds on ADR-0020 (the proposal mailbox +
  mandatory browser Accept gate) and ADR-0021 (the Agent Access control room +
  the per-session `responseKey` shared secret minted at pairing). Also fixes the
  reload-strands-the-tab robustness gap surfaced in the 2026-06-17 road-test.

## Context

After `open_project` (ADR-0021) the kernel joins the project's `share-<random>`
Yjs room as a peer and publishes pending-proposal **records** into a shared
`Y.Map` mailbox (`mcpProposals` for single-file `propose_edit`,
`mcpFileProposals` for multi-file `propose_files` change sets). The browser
observes the mailbox and routes every record through a **mandatory human Accept
gate** (`DiffReview` → conflict-aware `resolveAccept` / `planFileProposalAccept`
→ `applyAcceptedFileAsAgent`). That human click is the ONLY thing that lands
text, and it is also — implicitly — the only thing that authenticates a
proposal. The mailbox lives in an open room whose id is a write-capability for
any peer; the read-side validates only **shape + size/path caps** (DoS
hardening), never authorship. A peer who holds the room id can forge a
well-formed record, and today only the human reviewer notices it isn't from the
agent they trust.

Two forces meet here:

1. **Autonomy.** Modern models run long stretches unsupervised; the operator may
   not be present to click Accept on every proposal.
2. **Safety.** Removing the human click removes the only provenance check there
   is. Auto-accept cannot ship until a record can prove, on its own, that it came
   from the agent the user actually granted — AND until there is an asynchronous
   safety net so an operator who was away can review and undo what landed.

A road-test also surfaced a robustness gap on the same surface: the
**project-room connection does not survive a page reload**, and because
`open_project` is one-shot per kernel session, a reloaded tab is silently
**stranded** — kernel reads keep succeeding (they read IndexedDB directly,
masking the break) but ProjectApp's `connection` is `undefined`, so no proposal
card can ever render again.

## Threat model (what provenance does and does NOT protect)

- **Protected asset:** the operator's document is mutated *automatically* only by
  proposals genuinely originating from the agent identity bound to a specific,
  consented `open_project` grant.
- **Provenance protects the AUTO-ACCEPT PATH ONLY.** The room id is already a
  write-capability: a peer who holds it can write the live Y.Doc directly,
  bypassing proposals entirely. Defending document integrity against
  write-capable room peers is a SEPARATE concern (room authorization) and out of
  scope here. Auto-accept must not *widen* that exposure — that is the bar.
- **Same-origin XSS is treated as full local compromise** (it can read
  `responseKey`, derive keys, flip grants). We harden against accidental leakage
  (non-extractable imported `CryptoKey`s, no secret in any Y.Doc / version tree /
  log) but do not claim provenance survives XSS.
- **Arming auto-accept delegates write authority to the paired kernel** for the
  duration of the grant. A *hostile but legitimately paired* kernel can sign
  proposals that auto-apply; the defense is the revertable checkpoint, the audit
  trail, the volume guard, and the instant kill-switch — recovery and bounding,
  not prevention. The UI states this plainly when arming.

## Decision

### 1. Authenticated proposal provenance (the hard prerequisite)

Pairing already mints a per-session 256-bit `responseKey` (HMAC-SHA-256 key,
CSPRNG, carried ONLY in the pairing command, never in any Y.Doc). We reuse it —
no new key material, no new dependency (WebCrypto HKDF + HMAC suffice).

- **A per-grant `grantId`.** `open_project` mints a fresh CSPRNG `grantId` and
  returns it to the kernel inside the (already-signed) control response. It binds
  every signature to *this* consent event, so a kernel that still holds
  `responseKey` but not the current `grantId` cannot sign for a future grant
  (closes the stale-signer attack). `grantId` is persisted with the grant.
- **Per-grant key derivation.** Both sides derive
  `K = HKDF-SHA-256(responseKey, salt="galley-proposal-provenance-v1",
  info=canonicalScope, length=32)` where `canonicalScope` binds the full
  authorization context: `grantId`, `controlRoom`, canonical `syncUrl`,
  `projectId`, `shareRoom`, and the mailbox name. Distinct context ⇒ distinct key
  ⇒ no cross-room / cross-relay / cross-grant replay.
- **Canonical signing serialization.** A new framework-agnostic module
  (`packages/collab/src/proposal-provenance.ts`, yjs-free, shared by Node kernel
  and browser) serializes a proposal's **immutable** fields as a *fixed positional
  JSON array of only strings / arrays / null* (numbers → canonical decimal
  strings), versioned `galley.mcp.proposal.v1`, encoded with `TextEncoder`. Using
  positional arrays (never ad-hoc concatenation) makes the encoding injective —
  no delimiter-injection collision between two distinct records. Shape:
  ```
  ["galley.mcp.proposal.v1",
   ["scope", grantId, controlRoom, canonicalSyncUrl, projectId, shareRoom, mailboxName],
   ["record", id, "mcp", createdAtDecimal, seqDecimal],
   ["request", request],
   ["ops", [[kind, path, newPathOrNull, baseText, proposedText,
             [[search, replace], …]], …]]]          // multi-file
  ```
  The single-file mailbox uses the same shape with a one-op `ops` array
  (`kind:"edit"`, the proposal's `filePath`/`baseText`/`proposedText`/`blocks`),
  so one serializer + one verifier serve both. It NEVER covers the mutable
  `status`/verdict or `sig`, so recording an Accept/Reject does not invalidate the
  signature. Document text is signed VERBATIM (never Unicode-normalized) — the
  exact bytes the planner will consume.
- **`signProposal(K, record)` / `verifyProposal(K, record, sig)`** — HMAC-SHA-256;
  verify is constant-time (`subtle.verify`). `verifyProposal` returns `false`
  (never throws, never "ok") for ANY of: missing key, missing/short `sig`,
  unknown version prefix, parse failure, unsupported algorithm, or a schema it
  does not recognize. There is no "verifier unavailable ⇒ accept" path.
- **Kernel signs.** At publish the kernel holds `responseKey`, `grantId`, and the
  joined `shareRoom`; it derives `K` once per grant and signs every record.
  `publishProposal` / `publishFileProposal` take an OPTIONAL signer; with none
  they behave exactly as today (un-paired/local flows, tests).
- **Browser verifies, but stays permissive for MANUAL review.** The read-side
  surfaces `sig` but does NOT drop unsigned/bad-signed records — they still render
  for a human to review and Accept by hand, so today's behavior is byte-for-byte
  preserved. Authenticity is consumed only by auto-accept.
- **Map-key binds to id.** The read-side requires a record's mailbox map-key to
  equal its signed `id`, closing record-swap replay under a new key.

This slice is **behaviorally inert**: signatures are written and surfaced;
nothing yet acts on them differently.

### 2. Opt-in auto-accept (rides on provenance)

A pure decision core (`apps/web/src/auto-accept.ts`) — `decideAutoAcceptSingle` /
`decideAutoAcceptFile`, each `(record, ctx) → { apply: NormalizedSigned } | { manual: reason }`
(split by mailbox shape) — returns `apply` ONLY when ALL hold:

- auto-accept is **armed for this room** (opt-in; OFF by default; per shared
  room/session, never global);
- `canMutate` is true (a VIEWER never auto-applies; a `joinedSession` never arms);
- `verifyProposal` passes against the grant-scoped `K`;
- the record is still `pending`;
- the signed digest is NOT in the durable **tombstone audit** (see §3) for any
  prior `started`/`applied`/`accepted`/`rejected` state;
- the per-grant **monotonic `seq` guard** is satisfied (no duplicate or rollback
  relative to `lastAppliedSeq`);
- the per-grant **volume guard** is satisfied (no anomalous burst beyond the
  configured per-window op/byte budget);
- the conflict-aware planner (`resolveAccept` / `planFileProposalAccept`) succeeds
  against the LIVE snapshot.

On `apply`, the core returns a **frozen, normalized signed payload** (exactly the
fields the signature covered). The wiring then re-checks `canMutate`, status,
signed digest, audit, and the planner **immediately before applying, against the
current live snapshot**, and applies ONLY that frozen payload — it never re-reads
the mutable `Y.Map` record between verify and apply (closes the TOCTOU). The
apply itself drives the EXISTING `onAcceptProposal` / `onAcceptFileProposal`
handlers (single chokepoint; their `canMutate` guard + conflict gate are the last
line of defense). Anything not `apply` → the existing human Accept card (**fail
closed**). **Destructive ops (`delete`/`rename`) are eligible** (soft/recoverable,
checkpointed first) — the safety net is the checkpoint, not a click.

### 3. Durable audit + checkpoint + revert (apply-then-review-revert)

- **Tombstone audit.** A persisted, **non-pruned-while-armed** audit records each
  proposal's lifecycle keyed by `grantId + shareRoom + id + signedDigest`:
  `started` → `applied`/`failed`, plus `accepted`/`rejected` for manual verdicts.
  `started` is persisted BEFORE the checkpoint/apply, so a crash mid-apply leaves
  a `started` tombstone that BLOCKS any future auto-accept of that id until the
  operator resolves it (no silent re-apply on reload). The audit only ever grows
  while auto-accept is enabled; if it must be pruned, auto-accept disables first.
- **Checkpoint, fail-closed.** Before each auto-apply the browser writes a
  labeled restorable version through the existing version system:
  `createVersion(projectId, {name:"Auto-accept: <request>",
  message:"Before a signed MCP proposal (auto-accepted)", author:<agent>},
  materializeProject(snapshot).result.files)`. ANY failure —
  `materializeProject` not ok, a throw, a version-store/quota error — **pauses
  auto-accept and leaves the proposal pending** before returning. We never apply
  without a restore point; storage exhaustion degrades to manual review.
- **Revert** reuses the existing version-restore path (`onRestoreVersion`); no new
  rollback primitive. **Manual Accept is deliberately NOT checkpointed** (it has a
  present human reviewer), keeping the default flow byte-for-byte unchanged.

### 4. Reload re-bind (fixes the stranded tab)

On a successful `open_project`, persist a **grant record**
`{ controlRoom, projectId, shareRoom, syncUrl, mainFile, grantId, autoAccept,
grantedAt, mac }`, MAC'd with `responseKey` so a tampered/forged
localStorage grant is rejected (the control-mount manager already persists
`responseKey`, so `K` and the MAC are re-derivable after reload). On ProjectApp
boot, if Agent Access resumed AND a persisted grant's **exact** canonical
`{controlRoom, syncUrl, projectId, shareRoom, mainFile, grantId}` matches and its
MAC verifies, re-establish the project-room connection (the connect path
`ensureSharedForAgent` uses), set `activeShareRoom`, re-observe the mailboxes, and
**resume auto-accept if it was armed**. NO fresh consent re-binds the SAME
already-consented room; a DIFFERENT room (or a `joinedSession`, or a MAC/identity
mismatch) requires full `open_project` consent. The grant + auto-accept switch +
audit are cleared on Agent Access Revoke / Stop-sharing. A re-bind failure shows a
**visible warning** rather than leaving the tab silently stranded.

**Reattach backlog re-evaluation (F10).** A fresh page's per-record eligibility
tracker is empty and the grant MAC-load is **async**, so the mailbox observer can
fire under a not-yet-loaded (`null`) grant and fix a resumed-Auto backlog ineligible
**forever** (the future-records-only rule, ADR-0025 §3, treats the first sighting as
authoritative). To close this race, on a browser **(re)attach while the grant is
armed Auto**, the manager subscription — which re-emits when the grant *resolves*
Auto — drives a **once-per-attach** re-evaluation: it promotes the pending
**unwatched** paired-agent records to eligible (`promotePendingToEligible`) and
re-drives them through the unchanged auto-apply path (full gate chain + final-apply
gate + single-applier lock). A `reattachReevaluated` once-guard, **reset on
disconnect / Stop-sharing and on a project switch**, ensures it fires at most once
per attach (idempotent via the chain + `started` tombstone + status gate, but we
avoid spurious audit churn), and a genuine later reattach re-evaluates again. The
eligible set is still **only** the active grant's signed proposals; promotion widens
no trust.

### 5. UI: visible state, audit trail, instant kill-switch

- An always-visible **"Auto-accept ON"** indicator in the agent panel header
  whenever auto-mode is armed, with a one-click **kill-switch** effective before
  the next record is evaluated.
- The arming toggle is gated on `canMutate` (a viewer never sees or flips it); the
  arming affordance states that it delegates write authority to the paired agent.
- An **audit trail** lists what auto-applied while the operator was away (request,
  file count, timestamp, linked checkpoint) for review/revert.

## Consequences / invariants

- **The manual Accept gate is unchanged and remains the only apply chokepoint.**
  Auto-accept only *drives* it; it cannot bypass the `canMutate` guard or the
  conflict-aware planner. Pinned by test.
- **Auto-accept is OPT-IN, OFF by default, scoped per shared room/session.** The
  shipped bundle is behaviorally inert until armed.
- **A VIEWER (`canMutate=false`) or a `joinedSession` can NEVER auto-apply or
  arm**, even with a valid signature. Pinned by test.
- **Unsigned or bad-signed records are NEVER auto-applied** — they degrade to
  manual review. No verifier / bad version / parse failure ⇒ manual-only, never
  permissive. Pinned by test (explicit downgrade tests).
- **Same-room replay is closed** by the durable tombstone audit (keyed by signed
  digest, non-pruned while armed) + map-key==id + the conflict gate; **cross-room
  / cross-relay / cross-grant replay** is closed by binding
  `grantId+controlRoom+syncUrl+projectId+shareRoom+mailbox` into both `K` and the
  signed scope. Pinned by test.
- **No verify→apply TOCTOU:** auto-accept applies a frozen normalized signed
  payload and re-checks against the live snapshot immediately before applying.
- **A stale/conflicting proposal still fails closed** through the conflict gate —
  never a clobber, never a half-applied multi-file set.
- **Every auto-applied set is preceded by a revertable checkpoint;** a failed
  checkpoint pauses auto-accept rather than applying unprotected.
- **`responseKey`, `K`, and the grant MAC never enter any Y.Doc, version tree, or
  log.** `responseKey` already lives in localStorage (session resume); treat the
  store as sensitive (XSS = local-agent-equivalent). Revoke zeroes the key and
  clears the grant/audit; a revoked capability never returns.
- **Reload no longer strands the tab**: the share re-binds from the MAC-verified
  grant or surfaces a visible warning. Kernel reads succeeding from IndexedDB are
  never treated as proof that proposals can render.
- ADR-0021's `open_project` security ordering is preserved; re-bind adds no
  consent-bypassing path beyond re-binding an already-consented, identity-matched
  room.

## Non-goals

- No server-side Accept, ever (ADR-0020). The browser remains the sole authority.
- No defense of document integrity against write-capable room peers, and no claim
  of provenance under same-origin XSS — both are out of scope (see threat model).
- No multi-kernel / multi-agent fan-out per grant — one paired kernel per grant.
- No asymmetric signing: the shared `responseKey` already authenticates the pair;
  an Ed25519 keypair adds a signing dependency and a key-distribution path for no
  threat-model gain here.
