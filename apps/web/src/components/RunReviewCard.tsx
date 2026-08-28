import { useState } from "react";
import type { ProposalRecord, FileProposalRecord, RunGroup } from "@galley/collab";
import { isGroupVerified } from "../run-accept-all.js";
import { McpProposals } from "./McpProposals.js";
import { McpFileProposals } from "./McpFileProposals.js";

/**
 * RunReviewCard (ADR-0025 §5, Task 5) — ONE card per agent run.
 *
 * An external (MCP) agent run publishes several proposals; instead of one Accept
 * card per record, this collapses a run's pending records into a single card with
 * one **Accept-all** / **Reject-all** decision, and an expandable per-record
 * detail that reuses the EXISTING {@link McpProposals} / {@link McpFileProposals}
 * diff bodies (and their per-record Accept/Reject — still individually reviewable).
 *
 * A SINGLE-record run (the common case — one edit, or a legacy/un-grouped record)
 * is rendered as the FAMILIAR per-record card INLINE (the existing
 * {@link McpProposals} / {@link McpFileProposals} body, native testids and
 * per-record Accept/Reject) with no run ceremony — no expand, no Accept-all. The
 * grouped Accept-all UI below is reserved for runs that bundle MORE than one
 * change.
 *
 * Provenance is never hidden behind a bulk action (§5):
 *  - the header shows whether the run is provenance-VERIFIED (every record signed)
 *    or UNVERIFIED (a mixed/unsigned group) — a VISIBLE chip either way;
 *  - **Accept-all is disabled only while the run is still streaming**
 *    (`group.streaming` — "run in progress…"), since accepting mid-stream would
 *    race records the agent hasn't finished emitting. It is NOT gated on
 *    provenance: Accept-all merely sequences the SAME conflict-aware per-record
 *    gate (each record re-validated against the live snapshot), so an unsigned run
 *    applies through the identical path, signed or not.
 *
 * `runId` is non-authoritative — grouping only. The per-record handlers are the
 * same conflict-aware gate ProjectApp already uses; Accept-all just sequences them
 * (via the `run-accept-all` helper, in the caller) and never bypasses a check.
 */
export function RunReviewCard({
  group,
  onAcceptAll,
  onRejectAll,
  onAcceptRecord,
  onRejectRecord,
  onError,
}: {
  group: RunGroup;
  /** Accept the run's records in seq order, stopping on the first conflict (caller). */
  onAcceptAll: () => void | Promise<void>;
  /** Reject every CURRENTLY-received record of the run (received-only while streaming). */
  onRejectAll: () => void;
  /** Per-record Accept (the existing conflict-aware gate); returns success (sync or async). */
  onAcceptRecord: (
    record: ProposalRecord | FileProposalRecord,
  ) => void | boolean | Promise<boolean>;
  /** Per-record Reject (records the verdict in the mailbox). */
  onRejectRecord: (record: ProposalRecord | FileProposalRecord) => void;
  /** Surface an unexpected async-accept rejection through the parent's error notice. */
  onError?: (message: string) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  // B2: Accept-all is async (it awaits each per-record accept, including the blob
  // gate). Track its in-flight state so the button is disabled while a batch runs —
  // a second click can't double-fire it, and the promise is AWAITED inside
  // try/catch/finally so a rejection is surfaced (never swallowed) and the button
  // re-enables on BOTH success and failure.
  const [acceptingAll, setAcceptingAll] = useState(false);
  const runAcceptAll = async (): Promise<void> => {
    if (acceptingAll) return;
    setAcceptingAll(true);
    try {
      await onAcceptAll();
    } catch (err) {
      onError?.(`Could not apply the run — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAcceptingAll(false);
    }
  };

  const records = group.records;
  const count = records.length;
  // The run's human label: the first record's request stands for the run (all
  // records of one run share the request the agent issued).
  const request = records[0]?.request ?? "Agent run";
  const verified = isGroupVerified(records);

  // Split records back into the two mailbox shapes for the existing card bodies.
  // (A multi-file record carries `ops`; a single-file record carries `filePath`.)
  const singles = records.filter(
    (r): r is ProposalRecord => "filePath" in r,
  );
  const files = records.filter(
    (r): r is FileProposalRecord => "ops" in r,
  );

  // A SINGLE-record run (the common case: one edit, a legacy/un-grouped record)
  // needs no run ceremony — render the FAMILIAR per-record card inline, with its
  // native testids (`mcp-proposal`/`accept`/`reject`, `mcp-file-proposal`/…) and
  // its own Accept/Reject. No expand, no separate Accept-all: a single change is
  // reviewed exactly as before. The grouped Accept-all UI is reserved for a run
  // that genuinely bundles MORE than one change (length > 1).
  if (count === 1) {
    return (
      <article
        className="run-review-card run-review-card--single"
        data-testid="run-review-card"
        data-run-id={group.runId}
        data-streaming={group.streaming ? "true" : "false"}
        data-verified={verified ? "true" : "false"}
      >
        {singles.length > 0 && (
          <McpProposals
            proposals={singles}
            onAccept={(p) => void onAcceptRecord(p)}
            onReject={(p) => onRejectRecord(p)}
          />
        )}
        {files.length > 0 && (
          <McpFileProposals
            proposals={files}
            onAccept={(p) => onAcceptRecord(p)}
            onReject={(p) => onRejectRecord(p)}
            {...(onError ? { onError } : {})}
          />
        )}
      </article>
    );
  }

  // Accept-all is a bulk action, but it NEVER bypasses a real check: it just
  // sequences the SAME conflict-aware per-record gate (each record is re-validated
  // against the live snapshot on apply). So the only thing that blocks it is a run
  // still STREAMING — accepting mid-stream would race records the agent hasn't
  // finished emitting. Provenance stays a VISIBLE signal (the ✓ signed / ⚠
  // unverified chip below) but does not gate the bulk action: an unsigned run is
  // applied through the identical per-record gate, signed or not.
  const acceptAllDisabled = group.streaming || acceptingAll;

  return (
    <article
      className="run-review-card"
      data-testid="run-review-card"
      data-run-id={group.runId}
      data-streaming={group.streaming ? "true" : "false"}
      data-verified={verified ? "true" : "false"}
    >
      <div className="run-review-head">
        <div className="run-review-title">
          <strong data-testid="run-review-request">{request}</strong>
          <span className="run-review-count" data-testid="run-review-count">
            {count} change{count === 1 ? "" : "s"}
          </span>
          <span
            className={
              verified
                ? "run-review-prov run-review-prov--verified"
                : "run-review-prov run-review-prov--unverified"
            }
            data-testid="run-review-provenance"
            data-verified={verified ? "true" : "false"}
            title={
              verified
                ? "Every change in this run is signed by the paired agent"
                : "This run mixes signed and unsigned changes — review each before accepting"
            }
          >
            {verified ? "✓ signed" : "⚠ unverified"}
          </span>
          {group.streaming && (
            <span className="run-review-streaming" data-testid="run-review-streaming" role="status">
              run in progress…
            </span>
          )}
        </div>
        <div className="run-review-actions diff-actions">
          <button
            type="button"
            data-testid="run-accept-all"
            disabled={acceptAllDisabled}
            title={
              acceptAllDisabled
                ? "Accept all is unavailable (run in progress…)"
                : "Apply every change in this run, in order"
            }
            onClick={() => void runAcceptAll()}
          >
            {acceptingAll ? "Applying…" : "Accept all"}
          </button>
          <button
            type="button"
            data-testid="run-reject-all"
            title="Discard every change currently received for this run"
            onClick={onRejectAll}
          >
            Reject all
          </button>
          <button
            type="button"
            data-testid="run-review-expand"
            aria-expanded={expanded}
            onClick={() => setExpanded((e) => !e)}
            title="Show each change in this run"
          >
            {expanded ? "Hide changes ▾" : "Show changes ▸"}
          </button>
        </div>
      </div>
      {group.streaming ? (
        <p className="run-review-note" data-testid="run-review-note">
          The agent is still proposing changes — accept individual changes below,
          or wait for the run to finish.
        </p>
      ) : (
        !verified && (
          <p className="run-review-note" data-testid="run-review-note">
            This run isn’t fully signed — expand to review each change, or Accept
            all to apply them through the same per-change review gate.
          </p>
        )
      )}
      {expanded && (
        <div className="run-review-detail" data-testid="run-review-detail">
          {/* Reuse the EXISTING per-record diff bodies + per-record Accept/Reject;
              Accept-all above just sequences these same handlers. */}
          {singles.length > 0 && (
            <McpProposals
              proposals={singles}
              onAccept={(p) => void onAcceptRecord(p)}
              onReject={(p) => onRejectRecord(p)}
            />
          )}
          {files.length > 0 && (
            <McpFileProposals
              proposals={files}
              onAccept={(p) => onAcceptRecord(p)}
              onReject={(p) => onRejectRecord(p)}
              {...(onError ? { onError } : {})}
            />
          )}
        </div>
      )}
    </article>
  );
}
