/**
 * The PURE auto-accept decision core (ADR-0023 §2) — given a signed proposal
 * record and a snapshot of the world (`AutoAcceptCtx`), decide whether it may
 * apply WITHOUT a human click, and if so return a FROZEN, normalized signed
 * payload (exactly the fields the signature covered) that the wiring applies.
 *
 * This is the security chokepoint between a relay-delivered record and an
 * un-clicked mutation, so EVERY gate FAILS CLOSED: any failure — unarmed, a
 * viewer, a downgraded/missing signature, a replay, a seq rollback, a volume
 * burst, or a stale planner conflict — returns `{ manual: reason }`, which the
 * caller routes to the existing human Accept card. Only when ALL gates pass does
 * it return `{ apply: frozen }`.
 *
 * Gate order is deliberate: the cheap boolean gates and the cryptographic
 * authenticity check run BEFORE the expensive planner, so a forged or replayed
 * record is rejected without ever resolving it against the live snapshot.
 *
 * The returned `apply` carries the NORMALIZED `SignableProposal` (the exact bytes
 * the signature covered) plus its keyless `digest` and the read `record` — never
 * a live `Y.Map` handle. The wiring re-checks the cheap gates + planner against
 * the live snapshot immediately before applying ONLY this frozen payload, closing
 * the TOCTOU between verify and apply.
 *
 * PURE: no React, no Y.Doc, no DOM. Every effect (verify, audit, scope) is
 * injected through `AutoAcceptCtx` so the unit gate drives it fully offline.
 */
import type {
  FileProposalRecord,
  ProjectSnapshot,
  ProposalRecord,
} from "@galley/collab";
import type { ProposalScope, SignableProposal } from "@galley/collab";
import {
  fileToSignable,
  proposalSignedDigest,
  singleToSignable,
} from "@galley/collab";
import { resolveAccept } from "./accept.js";
import { planFileProposalAccept } from "./file-proposal-accept.js";
import type { AutoAcceptAudit } from "./auto-accept-audit.js";

const utf8 = new TextEncoder();

/**
 * Everything the decision core needs to judge ONE proposal, all injected so the
 * core stays pure. `verify`/`scopeFor`/`audit` are the effect seams; `snapshot`
 * is the LIVE project state the planner resolves against; `lastAppliedSeq` and
 * `volume` carry the per-grant replay/burst budgets the caller maintains.
 */
export interface AutoAcceptCtx {
  /** Auto-accept is opt-in and armed for THIS room/session (OFF by default). */
  armed: boolean;
  /** False for a viewer — a viewer never auto-applies. */
  canMutate: boolean;
  /** True when the local user themselves joined an agent session (never arms). */
  joinedSession: boolean;
  /** Authenticate a signature against the grant-scoped key. Returns false (never throws) when unsigned/forged. */
  verify: (scope: ProposalScope, signable: SignableProposal, sig: unknown) => Promise<boolean>;
  /** The grant-scoped signing scope for one of the two mailboxes. */
  scopeFor: (mailbox: "mcpProposals" | "mcpFileProposals") => ProposalScope;
  /** The durable tombstone audit — only `has(id, digest)` is consulted here. */
  audit: Pick<AutoAcceptAudit, "has">;
  /** The LIVE project snapshot the planner resolves the proposal against. */
  snapshot: ProjectSnapshot;
  /**
   * The highest seq already auto-applied for this grant, PER MAILBOX. The kernel
   * keeps two INDEPENDENT seq counters (one for `mcpProposals`, one for
   * `mcpFileProposals`), each starting at 0 per session — so a single shared
   * high-water mark would let one mailbox's counter false-reject the other's
   * (e.g. a fresh multi-file proposal at fileSeq=0 blocked because a single-file
   * proposal already advanced the mark). Each mailbox gates against its own.
   */
  lastAppliedSeq: Record<"mcpProposals" | "mcpFileProposals", number | null>;
  /** The per-window op/byte budget guarding against an anomalous burst. */
  volume: {
    opsThisWindow: number;
    bytesThisWindow: number;
    maxOps: number;
    maxBytes: number;
  };
  /**
   * A2/B3: verify the bytes for a multi-file proposal's create-binary ops are
   * present (+ uncorrupt) in the blob store. Consulted in `decideAutoAcceptFile`
   * AFTER the planner but BEFORE any tombstone is written, so a not-yet-arrived
   * blob yields a clean `{manual}` (no `started` tombstone) and the proposal stays
   * cleanly auto-eligible on the next wake once the bytes land — never permanently
   * replay-blocked by a transient miss. Optional: absent ⇒ a proposal with binary
   * ops is treated as NOT-yet-applicable (fail closed — never auto-apply a binary
   * pointer whose presence we cannot confirm).
   */
  binaryPresent?: (
    binaryCreates: { path: string; asset: { hash: string } }[],
  ) => Promise<{ ok: true } | { ok: false; missingPath: string }>;
}

/**
 * The inputs to the FINAL pre-apply gate (ADR-0025 §8.1) — read LIVE, per record,
 * immediately before the actual apply (AFTER the TOCTOU re-plan / pending re-check)
 * so a flip to Ask, a kill-switch, a role drop, or a lost ownership election wins
 * IMMEDIATELY and the record stays pending. Every field is re-sampled fresh at the
 * apply point; none is captured at decision time.
 */
export interface FinalApplyGateInput {
  /** The grant's acceptance mode, RE-READ from the store at the apply point. */
  mode: "ask" | "auto" | null;
  /** False if the local role dropped to viewer since the decision. */
  canMutate: boolean;
  /** Still a pending record in the live doc (the TOCTOU status re-check). */
  stillPending: boolean;
  /** This tab won the single-auto-applier election for the grant (fail-closed). */
  ownsAutoApplier: boolean;
}

/**
 * The LAST gate before an auto-apply commits (ADR-0025 §8.1 hardened rule 1/2).
 * Returns true ONLY when, at this very instant: the grant is still in Auto, the
 * local user can still mutate, the record is still pending, AND this tab owns the
 * single-auto-applier election. Any false → the caller leaves the record pending
 * for manual Accept. Pure boolean, so the unit gate pins it directly.
 */
export function passesFinalApplyGate(input: FinalApplyGateInput): boolean {
  return (
    input.mode === "auto" &&
    input.canMutate &&
    input.stillPending &&
    input.ownsAutoApplier
  );
}

/**
 * Per-record "mode at arrival" tracker for the Ask→Auto FUTURE-RECORDS-ONLY rule
 * (ADR-0025 §8.1 hardened rule 1). The chosen, pinned rule:
 *
 *   A record is eligible for auto-apply ONLY if the grant was in Auto at the
 *   moment its mailbox-arrival was FIRST observed by this tab.
 *
 * So a backlog that was pending while the user sat in Ask is NOT retroactively
 * auto-applied when they later flip to Auto — only records first SEEN under Auto
 * are eligible. This is decided once, on first sight, and remembered: a record's
 * eligibility never changes after arrival (a later flip back to Ask is still
 * caught by the live final gate, which is the kill-switch).
 *
 * Caller threads a single long-lived {@link AutoEligibility} (a ref) and calls
 * {@link observeAutoEligibility} for each pending record on every mailbox refresh;
 * the FIRST call for an id under Auto marks it eligible, later calls are stable.
 */
export interface AutoEligibility {
  /** Ids whose first sighting happened under Auto (eligible for auto-apply). */
  eligible: Set<string>;
  /** Ids already sighted at least once (so first-sight is decided exactly once). */
  seen: Set<string>;
}

/** A fresh, empty eligibility tracker. */
export function newAutoEligibility(): AutoEligibility {
  return { eligible: new Set(), seen: new Set() };
}

/**
 * Observe one pending record at mailbox-refresh time and return whether it is
 * auto-apply ELIGIBLE under the future-records-only rule. The first sighting of an
 * id fixes its eligibility to (mode === "auto") AT THAT INSTANT; subsequent
 * sightings return the same fixed verdict regardless of the current mode. (The
 * live final gate still independently enforces the CURRENT mode at apply time, so
 * this only governs the Ask→Auto direction; the Auto→Ask kill-switch is handled
 * there.)
 */
export function observeAutoEligibility(
  track: AutoEligibility,
  id: string,
  mode: "ask" | "auto" | null,
): boolean {
  if (!track.seen.has(id)) {
    track.seen.add(id);
    if (mode === "auto") track.eligible.add(id);
  }
  return track.eligible.has(id);
}

/**
 * Mark an EXPLICIT set of currently-pending ids as both seen and eligible — the
 * ONE sanctioned bypass of the future-records-only first-sight rule of
 * {@link observeAutoEligibility} (ADR-0025 §8.1, ADR-0023 §4).
 *
 * The first-sight rule deliberately suppresses the PASSIVE backlog: a grant that
 * drifts to Auto, or a programmatic/inherited mode change, must NOT retroactively
 * auto-apply records that were pending while the user sat in Ask. This helper is
 * called for the two events that are NOT passive backlog but deliberate intent:
 *
 *   1. An EXPLICIT user ARM — the user clicks Auto in the acceptance panel for a
 *      paired agent (F7). The currently-pending paired-agent records are promoted
 *      so the click acts on the backlog the user is looking at.
 *   2. A browser (re)ATTACH while the grant is already armed Auto (F10). A fresh
 *      page's eligibility tracker is empty and the grant MAC-load is async, so the
 *      mailbox observer can fire under a not-yet-loaded (null) grant and fix the
 *      backlog ineligible forever; a once-per-attach re-evaluation promotes the
 *      pending UNWATCHED records once the grant has resolved Auto.
 *
 * This is NOT an authorization widening. A promoted id is fed into the SAME
 * `runAutoAccept` chain as a record `observeAutoEligibility` returns true for, and
 * still passes through the full {@link decideAutoAcceptSingle}/{@link
 * decideAutoAcceptFile} gate chain (armed / viewer-joined / pending / signature /
 * replay-audit / monotonic-seq / volume) AND the live {@link passesFinalApplyGate}
 * + single-applier Web-Lock before ANY apply. Promotion governs only WHETHER a
 * record is fed into the chain at all — identical to `observeAutoEligibility`
 * returning true — never which proposals are trusted (the verifier and `scopeFor`
 * are unchanged and bound to the active grant, so only the paired agent's signed
 * proposals can ever pass).
 *
 * Marking both `seen` and `eligible` keeps a later PASSIVE re-sighting stable: the
 * id is already seen, so `observeAutoEligibility` returns the promoted verdict and
 * never re-evaluates it under whatever mode happens to be live at that instant.
 *
 * Scoped to EXACTLY the listed ids: a non-listed backlog id is untouched, an empty
 * iterable is a no-op, and promoting the same id twice is idempotent.
 */
export function promotePendingToEligible(track: AutoEligibility, ids: Iterable<string>): void {
  for (const id of ids) {
    track.seen.add(id);
    track.eligible.add(id);
  }
}

/** The frozen, normalized signed payload for an applicable SINGLE-file proposal. */
export interface FrozenSingle {
  kind: "single";
  record: ProposalRecord;
  signable: SignableProposal;
  digest: string;
}

/** The frozen, normalized signed payload for an applicable MULTI-file proposal. */
export interface FrozenFile {
  kind: "file";
  record: FileProposalRecord;
  signable: SignableProposal;
  digest: string;
}

/**
 * The proposed-byte cost of a signable — UTF-8 bytes of every op's proposed text
 * PLUS every create-binary op's blob `size` (A2). Without the binary term, a
 * signed create-binary op (whose `proposedText` is "") would add ZERO to the
 * burst-budget, letting an auto-armed kernel apply arbitrarily large binary
 * proposals until only the op-COUNT limiter trips. Counting `binaryAsset.size`
 * makes the byte burst-limiter govern binary volume too — the SAME measure the
 * mailbox's aggregate blob cap uses. Exported so the apply path charges the
 * applied-volume window with the identical cost.
 */
export function proposedBytes(signable: SignableProposal): number {
  let total = 0;
  for (const op of signable.ops) {
    total += utf8.encode(op.proposedText).length;
    if (op.binaryAsset != null) total += op.binaryAsset.size;
  }
  return total;
}

/**
 * The shared gate pipeline up to (and including) the signature/audit/seq/volume
 * checks — everything common to single- and multi-file proposals. Returns the
 * built `signable`/`scope`/`digest` on success so each caller runs only its own
 * planner step. The planner gate (the one piece that differs) is left to the
 * caller. Every early return is fail-closed.
 */
async function gateCommon(
  record: ProposalRecord | FileProposalRecord,
  signable: SignableProposal,
  mailbox: "mcpProposals" | "mcpFileProposals",
  opCount: number,
  ctx: AutoAcceptCtx,
): Promise<{ ok: true; scope: ProposalScope; digest: string } | { ok: false; manual: string }> {
  // 1. armed (cheapest, opt-in).
  if (!ctx.armed) return { ok: false, manual: "auto-accept not armed" };

  // 2. a viewer never auto-applies; the local user's own joined session never arms.
  if (!ctx.canMutate || ctx.joinedSession) {
    return { ok: false, manual: "viewer/joined session cannot auto-apply" };
  }

  // 3. only a still-pending record is eligible.
  if (record.status !== "pending") {
    return { ok: false, manual: "proposal is not pending" };
  }

  // 4. build the signing view, scope, and keyless digest.
  const scope = ctx.scopeFor(mailbox);
  const digest = await proposalSignedDigest(scope, signable);

  // 5. AUTHENTICITY — a missing/garbage signature MUST read as unverified, never ok.
  //    `record.sig` is undefined for an unsigned record; verify gets it verbatim.
  const verified = await ctx.verify(scope, signable, record.sig);
  if (!verified) return { ok: false, manual: "unsigned or unverified proposal" };

  // 6. REPLAY — a digest already acted on (or an unknown/corrupt audit) blocks.
  if (ctx.audit.has(record.id, digest)) {
    return { ok: false, manual: "already auto-applied (replay)" };
  }

  // 7. MONOTONIC seq — no duplicate or rollback relative to the last applied seq
  //    FOR THIS MAILBOX (the two kernel counters are independent — see the ctx doc).
  const lastSeq = ctx.lastAppliedSeq[mailbox];
  if (lastSeq !== null && record.seq <= lastSeq) {
    return { ok: false, manual: "stale/duplicate seq" };
  }

  // 8. VOLUME — this record must not push the window over the op/byte budget.
  const nextOps = ctx.volume.opsThisWindow + opCount;
  const nextBytes = ctx.volume.bytesThisWindow + proposedBytes(signable);
  if (nextOps > ctx.volume.maxOps || nextBytes > ctx.volume.maxBytes) {
    return { ok: false, manual: "volume budget exceeded" };
  }

  return { ok: true, scope, digest };
}

/**
 * Decide whether a SINGLE-file proposal may auto-apply. On success the planner
 * resolves the proposal the SAME way single-file Accept does: it finds the UNIQUE
 * live, non-deleted text file whose path equals `record.filePath` (0 or >1 live
 * matches → a target conflict, fail closed) and runs `resolveAccept` against its
 * current live text. Returns the frozen normalized signed payload only when every
 * gate passes.
 */
export async function decideAutoAcceptSingle(
  record: ProposalRecord,
  ctx: AutoAcceptCtx,
): Promise<{ apply: FrozenSingle } | { manual: string }> {
  const signable = singleToSignable(record, record.seq);
  const common = await gateCommon(record, signable, "mcpProposals", 1, ctx);
  if (!common.ok) return { manual: common.manual };

  // 9. PLANNER — resolve the target the same way single-file Accept does: the
  //    unique live, non-deleted text file at `record.filePath`. A text/binary
  //    path collision is the same ambiguity Accept refuses to guess through.
  const liveText = ctx.snapshot.files.filter((f) => !f.deleted && f.path === record.filePath);
  const liveBinary = (ctx.snapshot.binaryFiles ?? []).some(
    (f) => !f.deleted && f.path === record.filePath,
  );
  if (liveText.length !== 1 || liveBinary) {
    return { manual: "target conflict" };
  }
  const outcome = resolveAccept(
    liveText[0]!.text,
    record.baseText,
    record.proposedText,
    record.blocks,
  );
  if (!outcome.applied) {
    return { manual: "proposal conflicts with live text" };
  }

  return { apply: { kind: "single", record, signable, digest: common.digest } };
}

/**
 * Decide whether a MULTI-file proposal may auto-apply. On success the planner is
 * `planFileProposalAccept` against the live snapshot — the same all-or-nothing
 * gate the multi-file Accept card uses (validate every op, plan nothing partial).
 * Returns the frozen normalized signed payload only when every gate passes.
 */
export async function decideAutoAcceptFile(
  record: FileProposalRecord,
  ctx: AutoAcceptCtx,
): Promise<{ apply: FrozenFile } | { manual: string }> {
  const signable = fileToSignable(record, record.seq);
  const common = await gateCommon(record, signable, "mcpFileProposals", record.ops.length, ctx);
  if (!common.ok) return { manual: common.manual };

  // 9. PLANNER — the conflict-aware multi-file planner against the live snapshot.
  const planned = planFileProposalAccept(ctx.snapshot, record.ops);
  if (!planned.ok) return { manual: planned.reason };

  // 10. BLOB PRESENCE (A2/B3) — for a create-binary proposal, the bytes must be in
  //     the store BEFORE we commit to applying. Doing this here, in the DECISION
  //     phase (before ProjectApp writes the `started` tombstone), means a blob that
  //     has not arrived yet yields `{manual}` with NO tombstone — so the proposal
  //     is cleanly re-decided (and can still auto-apply) on the next wake once the
  //     bytes land, instead of being permanently replay-blocked by a `started`/
  //     `failed` tombstone from a transient miss. Fail closed when no probe exists.
  if (planned.plan.binaryCreates.length > 0) {
    if (ctx.binaryPresent === undefined) {
      return { manual: "binary bytes cannot be verified (no blob store)" };
    }
    const present = await ctx.binaryPresent(planned.plan.binaryCreates);
    if (!present.ok) {
      return { manual: `binary bytes not yet present (${present.missingPath})` };
    }
  }

  return { apply: { kind: "file", record, signable, digest: common.digest } };
}
