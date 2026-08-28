/**
 * The HEADLESS apply SEAM (F13.3) — the non-UI twin of ProjectApp's
 * `onAcceptProposal` / `onAcceptFileProposal`. It re-validates a frozen, fully-
 * gated signed proposal against the LIVE snapshot and lands it as the agent peer,
 * recording the verdict in the shared mailbox — the SAME conflict-aware chokepoint
 * the foreground Accept uses, WITHOUT `setNotice` / React state.
 *
 * Reuse, not fork: every primitive here is the exact one the editor calls —
 * `findProposalTarget` + `resolveAccept` + `applyAcceptedFileAsAgent` +
 * `resolveProposal` (single), and `planFileProposalAccept` +
 * `verifyBinaryBlobsPresent` + `applyAcceptedFileSetAsAgent` + `resolveFileProposal`
 * (multi). The conflict planner is never re-implemented; this only drops the UI
 * notices and returns a boolean the apply core records.
 *
 * It is the `apply(frozen)` seam {@link runAgentApply} invokes UNDER the single-
 * applier Web-Lock and AFTER the live final gate, so the verify→apply TOCTOU window
 * is re-checked here exactly as the editor re-checks it:
 *   - single: re-resolve the UNIQUE live, non-deleted text file at `filePath` (0 or
 *     >1 matches → conflict, do not apply), re-run `resolveAccept` against its live
 *     text (a changed file → conflict, do not apply);
 *   - multi: re-plan against a FRESH snapshot after the async blob-presence gate,
 *     re-check the record is still pending, apply ONLY the fresh plan atomically.
 * A conflict / viewer / vanished target returns false (the core marks it failed and
 * leaves the human card to take over). No throw escapes — a multi-file apply throw
 * is contained and returns false.
 *
 * The verdict is written under the SAME `human` author the editor uses: a headless
 * apply is the human's STANDING consent (persistentAccess) being exercised, so the
 * mailbox verdict shape is byte-identical to a foreground Accept (no new author
 * kind leaks into attribution). Mutation attribution stays the agent peer ("mcp").
 */
import type {
  CollabProject,
  FileProposalRecord,
  ProposalRecord,
  BlobStore,
} from "@galley/collab";
import { resolveProposal, resolveFileProposal, getFileProposal } from "@galley/collab";
import type { Author } from "@galley/shared";
import { resolveAccept } from "./accept.js";
import { findProposalTarget } from "./components/McpProposals.js";
import { applyAcceptedFileAsAgent, applyAcceptedFileSetAsAgent } from "./project-session.js";
import { planFileProposalAccept, verifyBinaryBlobsPresent } from "./file-proposal-accept.js";
import type { FrozenApply } from "./agent-apply-core.js";

/** The agent run id mutations attribute to (matches ProjectApp's MCP accept path). */
const MCP_RUN_ID = "mcp";
/** The verdict author — the human's standing consent (same shape the editor records). */
const HUMAN: Author = { kind: "human", userId: "me" };

/**
 * Build the headless `apply(frozen)` seam for one project. `canMutate` MUST be true
 * for the host (it is always an editor of the doc it loaded); it is threaded so the
 * seam fails closed identically to the editor if a future caller ever passes false.
 * `blobStore` is the project's content-addressed store (null when unavailable — a
 * binary proposal then cannot apply, fail closed).
 */
export function makeHeadlessApplySeam(
  project: CollabProject,
  blobStore: BlobStore | null,
  canMutate = true,
): (frozen: FrozenApply) => Promise<boolean> {
  return async (frozen) => {
    // SEC: applying lands the agent's edit AND records a verdict in the shared
    // mailbox — both shared-doc writes a viewer must never make.
    if (!canMutate) return false;
    if (frozen.kind === "single") return applySingle(project, frozen.record);
    return applyFile(project, blobStore, frozen.record);
  };
}

/**
 * Single-file apply — the non-UI twin of `onAcceptProposal`. STRICT target
 * resolution + a clean re-apply against the LIVE text (the TOCTOU re-check); a
 * missing/duplicate target or a changed file returns false (leave it pending).
 */
function applySingle(project: CollabProject, p: ProposalRecord): boolean {
  const target = findProposalTarget(project.snapshot().files, p.filePath);
  if (!target.ok) return false; // missing or duplicate path → conflict, do not guess
  const file = target.file;
  const outcome = resolveAccept(file.text, p.baseText, p.proposedText, p.blocks);
  if (!outcome.applied) return false; // the file changed since the proposal → conflict
  applyAcceptedFileAsAgent(project, file.fileId, outcome.source!, MCP_RUN_ID);
  resolveProposal(project, p.id, "accepted", HUMAN);
  return true;
}

/**
 * Multi-file apply — the non-UI twin of `onAcceptFileProposal`. The SAME all-or-
 * nothing gate: probe-plan to find binary creates, run the async blob-presence gate
 * (a not-yet-arrived blob → false, nothing applied — the core writes no permanent
 * tombstone for a transient miss because the decision core already gated it), then
 * RE-CHECK the record is still pending and RE-PLAN against a FRESH snapshot, applying
 * ONLY the fresh plan atomically. A throw is contained → false.
 *
 * NOTE on re-entrancy: the apply core's `inFlight` set + the single-applier Web-Lock
 * already serialize per-record, so this seam needs no local in-flight guard of its
 * own (unlike ProjectApp's `fileAcceptInFlight`, which also guards the human
 * double-click). The pending re-check below is the durable TOCTOU guard regardless.
 */
async function applyFile(
  project: CollabProject,
  blobStore: BlobStore | null,
  p: FileProposalRecord,
): Promise<boolean> {
  const probe = planFileProposalAccept(project.snapshot(), p.ops);
  if (!probe.ok) return false;
  if (probe.plan.binaryCreates.length > 0) {
    if (!blobStore) return false; // no store → the bytes can't be verified, fail closed
    const present = await verifyBinaryBlobsPresent(probe.plan.binaryCreates, blobStore);
    if (!present.ok) return false; // bytes not arrived yet → nothing applied
  }
  // TOCTOU guard after the await: still pending + RE-PLAN against the live snapshot.
  if (getFileProposal(project, p.id)?.status !== "pending") return false;
  const planned = planFileProposalAccept(project.snapshot(), p.ops);
  if (!planned.ok) return false;
  try {
    applyAcceptedFileSetAsAgent(project, planned.plan, MCP_RUN_ID);
    resolveFileProposal(project, p.id, "accepted", HUMAN);
    // Servable-provenance: a valid operator-armed AUTO-accept has LANDED the
    // create-binary pointer(s) through the SAME Accept seam the foreground uses —
    // a headless auto-accept is the human's standing consent being exercised.
    // Grant each accepted binary hash ONLY now, strictly AFTER the pointer applied
    // (NEVER at the pre-Accept `verifyBinaryBlobsPresent` gate above). `blobStore`
    // is non-null whenever there are binaryCreates (a binary create with no store
    // fails closed at the gate); best-effort so a mark failure never half-resolves.
    if (blobStore) {
      for (const b of planned.plan.binaryCreates) {
        await blobStore.markServable(b.asset.hash).catch(() => undefined);
      }
    }
    return true;
  } catch {
    // An unexpected failure: leave the proposal PENDING (never half-resolved).
    return false;
  }
}
