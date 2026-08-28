/**
 * The PURE auto-apply RUN core (F13.3) — one signed MCP proposal driven from the
 * shared decision core ({@link decideAutoAcceptSingle}/{@link decideAutoAcceptFile},
 * auto-accept.ts) all the way to an applied (or fail-closed-pending) outcome, with
 * EVERY effect injected. It is the EXACT sequence ProjectApp's `runAutoAccept` runs
 * (ADR-0023 §2/§3, ADR-0025 §8.1/§8.2), lifted out so BOTH the foreground editor and
 * the F13 background agent-apply host run ONE chokepoint — the decision logic is
 * never forked.
 *
 * Why a pure function and not the React closure: the headless host (no ProjectApp,
 * no `setNotice`, no `useState`) needs the identical guarantees — checkpoint-before-
 * apply, the `started` replay tombstone, the volume cap, the checkpoint-fail-closed
 * pause, the live final gate, and the single-applier Web-Lock keyed by `grantId`.
 * Reproducing them in a second loop would be a security regression waiting to drift;
 * instead this function is the SINGLE definition both surfaces call.
 *
 * SECURITY POSTURE (every gate fails closed, unchanged from `runAutoAccept`):
 *   - re-entrancy backstop (`inFlight`) — a concurrent double-fire for one id is a
 *     no-op (the caller also serializes through a chain; both are belt-and-braces);
 *   - the decision core does armed / viewer-joined / pending / SIGNATURE / replay-
 *     audit / monotonic-seq / volume / planner (+ binary-presence) — only a fully
 *     gated, frozen, normalized signed payload reaches the apply;
 *   - the `started` tombstone is written + RE-READ for durability BEFORE the
 *     checkpoint, so a crash mid-apply still blocks replay; a non-durable write
 *     PAUSES (disarm) rather than applying without a replay barrier;
 *   - a pre-apply checkpoint (the Undo target) must succeed or we PAUSE;
 *   - the FINAL gate ({@link passesFinalApplyGate}) re-reads mode/role/pending/owner
 *     LIVE at the apply instant, so a flip to Ask / kill-switch / role drop / lost
 *     election wins immediately and the record stays pending;
 *   - the ACTUAL apply runs under {@link withAutoApplierLock} keyed by `grantId` —
 *     the HARD same-origin single-applier guarantee (the awareness election is a
 *     coarse hint); the lock-unavailable / lock-held paths DO NOT apply.
 *
 * The apply itself is the caller's `apply(frozen)` seam — for the editor it is
 * onAcceptProposal/onAcceptFileProposal; for the host it is the same conflict-aware
 * primitives without the `setNotice` UI. The seam re-validates against the live
 * snapshot (the verify→apply TOCTOU backstop) and returns whether it applied.
 *
 * PURE: no React, no Y.Doc handle, no DOM — every effect (decide, audit, checkpoint,
 * final-gate inputs, lock, apply, stamp, onPause) is injected, so the unit gate
 * drives it fully offline.
 */
import type { FileProposalRecord, ProposalRecord, SignableProposal } from "@galley/collab";
import {
  decideAutoAcceptSingle,
  decideAutoAcceptFile,
  passesFinalApplyGate,
  type AutoAcceptCtx,
} from "./auto-accept.js";
import { withAutoApplierLock, type LockManagerLike } from "./auto-applier-ownership.js";
import type { AutoAcceptAudit } from "./auto-accept-audit.js";

const utf8 = new TextEncoder();

/** The two records the run core applies, tagged with their mailbox kind. */
export type ApplyRecord =
  | { kind: "single"; record: ProposalRecord }
  | { kind: "file"; record: FileProposalRecord };

/** The frozen, normalized signed payload the apply seam receives (decision output). */
export type FrozenApply =
  | { kind: "single"; record: ProposalRecord; signable: SignableProposal; digest: string }
  | { kind: "file"; record: FileProposalRecord; signable: SignableProposal; digest: string };

/**
 * Everything one apply RUN needs, all injected so the core stays pure and BOTH the
 * editor and the headless host supply the same shapes. Mirrors exactly what
 * ProjectApp's `runAutoAccept` reads from its closure.
 */
export interface AgentApplyDeps {
  /** The active grant's id — the volume/seq budgets and the Web-Lock are keyed by it. */
  grantId: string;
  /** Build the decision context (snapshot, verifier, audit, seq, volume, binaryPresent) FRESH per record. */
  buildCtx: () => AutoAcceptCtx;
  /** The durable tombstone audit for THIS grant (ADR-0023 §3). */
  audit: AutoAcceptAudit;
  /** Write the pre-apply checkpoint (the Undo target); returns its version id or null on failure. */
  checkpoint: (request: string) => Promise<string | null>;
  /**
   * Re-read the LIVE inputs to the final pre-apply gate AT the apply instant (after
   * the async checkpoint), per record. Every field re-sampled fresh — never captured
   * at decision time — so a flip to Ask / role drop / lost election wins immediately.
   * `stillPending` is the TOCTOU status re-check against the live doc.
   */
  finalGateInputs: (rec: ApplyRecord) => {
    mode: "ask" | "auto" | null;
    canMutate: boolean;
    stillPending: boolean;
    ownsAutoApplier: boolean;
  };
  /**
   * APPLY the frozen, fully-gated payload against the LIVE doc as the agent peer and
   * record the verdict — the SAME conflict-aware chokepoint Accept uses (it re-plans
   * against the live snapshot, the verify→apply TOCTOU backstop). Returns whether it
   * actually applied (false on a TOCTOU conflict / viewer / re-entry).
   */
  apply: (frozen: FrozenApply) => Promise<boolean>;
  /**
   * Charge the applied-volume window + advance the per-mailbox seq high-water mark
   * after a SUCCESSFUL apply (the caller owns those refs; this keeps the burst gates
   * honest across records). `bytes` is the SAME measure the decision gate charged.
   */
  onApplied: (rec: ApplyRecord, bytes: number) => void;
  /**
   * PAUSE auto-apply (disarm) with a human-readable reason — fired ONLY on the two
   * fail-closed durability faults (audit full/unreadable, non-durable tombstone,
   * checkpoint failure). For the editor this flips the armed UI + notice; for the
   * headless host it detaches/quiesces the host so it stops applying. Never thrown
   * past this seam.
   */
  onPause: (reason: string) => void;
  /** Fired after EVERY audit write so a UI/indicator can refresh its trail. Optional. */
  onAuditChanged?: () => void;
  /**
   * F13: stamp the grant's `lastActiveAt` after a SUCCESSFUL headless apply so the
   * 7-day idle TTL clock restarts. Optional (the foreground editor passes none — its
   * liveness is its own presence, not a TTL). Called with the apply instant.
   */
  onActive?: () => void;
  /** Injectable Web-Locks manager (tests); production omits it → ambient navigator.locks. */
  locks?: LockManagerLike | null;
  /** Re-entrancy backstop set (the caller's ref). A no-op when the id is already in flight. */
  inFlight: Set<string>;
}

/** The pause reasons — exported so both the editor wiring and tests assert the exact copy. */
export const PAUSE_AUDIT_FULL =
  "Auto-accept paused: its audit log is full or unreadable. Review what landed, then re-arm.";
export const PAUSE_TOMBSTONE_NONDURABLE =
  "Auto-accept paused: the audit log could not be written, so the replay guard is not durable.";
export const PAUSE_CHECKPOINT_FAILED =
  "Auto-accept paused: a pre-apply checkpoint could not be written.";

/** The proposed-byte cost charged to the applied-volume window (mirrors the decision gate). */
function appliedBytes(rec: ApplyRecord): number {
  if (rec.kind === "single") return utf8.encode(rec.record.proposedText).length;
  return rec.record.ops.reduce(
    (n, o) =>
      n +
      utf8.encode(o.proposedText).length +
      (o.kind === "create-binary" && o.binaryAsset !== undefined ? o.binaryAsset.size : 0),
    0,
  );
}

/**
 * Decide + (if eligible) auto-apply ONE pending proposal — the lifted, pure twin of
 * ProjectApp's `runAutoAccept`. Returns when the record is applied, left pending, or
 * paused; never throws (the apply/decision seams are wrapped by their own callers).
 *
 * The sequence is byte-for-byte the editor's: re-entrancy guard → decide → `started`
 * tombstone (+ durability re-read) → checkpoint → live final gate → apply UNDER the
 * grant lock → charge volume/seq + stamp on success. Every off-ramp is fail-closed.
 */
export async function runAgentApply(rec: ApplyRecord, deps: AgentApplyDeps): Promise<void> {
  const id = rec.record.id;
  // A cheap synchronous re-entrancy backstop (the caller also serializes). The HARD
  // double-apply guarantees are the CRDT `status!=="pending"` gate, the `started`
  // tombstone, and the Web-Lock below — this just keeps the body re-entrancy-safe.
  if (deps.inFlight.has(id)) return;
  deps.inFlight.add(id);
  try {
    const ctx = deps.buildCtx();
    const decision =
      rec.kind === "single"
        ? await decideAutoAcceptSingle(rec.record, ctx)
        : await decideAutoAcceptFile(rec.record, ctx);
    if ("manual" in decision) return; // not eligible → leave it for the human card

    const digest = decision.apply.digest;
    const request = rec.record.request;
    const fileCount = rec.kind === "single" ? 1 : rec.record.ops.length;
    const bytes = appliedBytes(rec);
    const frozen: FrozenApply = decision.apply;
    const audit = deps.audit;

    // `started` BEFORE the checkpoint/apply: a crash mid-apply still leaves a
    // tombstone that blocks any replay of this digest on the next load.
    audit.mark(id, digest, "started", { request, fileCount });
    if (audit.corrupt() || audit.overflowed()) {
      deps.onPause(PAUSE_AUDIT_FULL);
      deps.onAuditChanged?.();
      return;
    }
    // DURABILITY: `mark` swallows write failures (quota/privacy), so re-read the
    // state. If the `started` tombstone didn't stick, applying would have no replay
    // barrier on reload — PAUSE instead of applying.
    if (audit.state(id, digest) !== "started") {
      deps.onPause(PAUSE_TOMBSTONE_NONDURABLE);
      return;
    }
    const checkpointId = await deps.checkpoint(request);
    if (checkpointId === null) {
      deps.onPause(PAUSE_CHECKPOINT_FAILED);
      return;
    }
    // THE FINAL PRE-APPLY GATE — the LAST thing before apply, AFTER the async
    // checkpoint and the TOCTOU pending re-check. Every input is RE-READ LIVE here.
    if (!passesFinalApplyGate(deps.finalGateInputs(rec))) {
      audit.mark(id, digest, "failed", { request, fileCount });
      deps.onAuditChanged?.();
      return;
    }
    // THE HARD single-applier guarantee: run the ACTUAL apply under a same-origin
    // Web Lock keyed by the grant id. FAIL CLOSED: lock held (another tab/host is
    // applying) OR the Web Locks API unavailable → do NOT apply; the record stays
    // for manual review.
    const lockOutcome = await withAutoApplierLock(
      deps.grantId,
      async () => deps.apply(frozen),
      deps.locks,
    );
    if (!lockOutcome.ranWithLock) {
      audit.mark(id, digest, "failed", { request, fileCount });
      deps.onAuditChanged?.();
      return;
    }
    if (lockOutcome.result === true) {
      audit.mark(id, digest, "applied", { request, fileCount, checkpointVersionId: checkpointId });
      deps.onApplied(rec, bytes);
      deps.onActive?.();
    } else {
      // The apply seam re-validated against the live snapshot and declined (a TOCTOU
      // conflict): mark it and leave the human card to take over.
      audit.mark(id, digest, "failed", { request, fileCount });
    }
    deps.onAuditChanged?.();
  } finally {
    deps.inFlight.delete(id);
  }
}
