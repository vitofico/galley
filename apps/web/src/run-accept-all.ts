import type { ProposalRecord, FileProposalRecord } from "@galley/collab";

/**
 * Accept-all ordering helper (ADR-0025 §5, Task 5).
 *
 * A run card's "Accept all" applies the run's pending records in publish `seq`
 * order, each through the EXISTING per-record accept path (the conflict-aware
 * gate in `ProjectApp`). On the FIRST failure/conflict it STOPS and leaves the
 * remainder pending — a partial apply is allowed and REPORTED, never a silent
 * skip. `runId` never gates apply; this helper only sequences the same per-record
 * accepts the user could click one by one.
 *
 * Pure over an injected `accept` callback (returns success) so it is unit-tested
 * in the node gate with no DOM. The callback is the same `onAcceptProposal` /
 * `onAcceptFileProposal` ProjectApp already uses, which re-validates each record
 * against the LIVE snapshot — so ordering here can never bypass a conflict check.
 */

/** The minimum a record needs for ordering + reporting (sig/provenance read elsewhere). */
export type AcceptableRecord = ProposalRecord | FileProposalRecord;

/** What an Accept-all run did: which records applied, which remain, where it stopped. */
export interface RunAcceptResult {
  /** Ids applied successfully, in the order applied. */
  applied: string[];
  /**
   * Ids still pending after the run — the conflicting record AND every record
   * after it (the helper stops on the first failure; nothing past it is tried).
   * Empty on the all-success path.
   */
  remaining: string[];
  /** The id of the record that failed/conflicted, or null when all applied. */
  stoppedAt: string | null;
}

/**
 * Apply `records` in ascending `seq` order via `accept`, stopping on the first
 * `false` (a conflict/failure). Returns the applied/remaining split + the record
 * it stopped at. The input is sorted defensively by `seq` (id tie-break) so the
 * caller need not pre-sort, matching the mailbox's deterministic ordering.
 */
export async function applyRunAccepts(
  records: AcceptableRecord[],
  accept: (record: AcceptableRecord) => boolean | Promise<boolean>,
): Promise<RunAcceptResult> {
  const ordered = [...records].sort(
    (a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const applied: string[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const record = ordered[i]!;
    const ok = await accept(record);
    if (!ok) {
      return {
        applied,
        remaining: ordered.slice(i).map((r) => r.id),
        stoppedAt: record.id,
      };
    }
    applied.push(record.id);
  }
  return { applied, remaining: [], stoppedAt: null };
}

/**
 * Whether a record is provenance-VERIFIED for run-card display: a record signed
 * by the kernel carries a base64url HMAC `sig` (ADR-0023 §1); an unsigned record
 * (local mode, or a forged/foreign write) has none. This is a DISPLAY signal only
 * — the manual Accept gate already ignores `sig` and re-validates every record
 * against the live snapshot. It exists so the run card can mark a mixed/unsigned
 * group "unverified" and refuse the bulk Accept-all until the user expands.
 */
export function isRecordSigned(record: AcceptableRecord): boolean {
  return typeof record.sig === "string" && record.sig.length > 0;
}

/** True when EVERY record in the group is signed (an all-signed run can bulk-accept). */
export function isGroupVerified(records: AcceptableRecord[]): boolean {
  return records.length > 0 && records.every(isRecordSigned);
}
