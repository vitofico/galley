import type { ProposalRecord, ProjectFileSnapshot } from "@galley/collab";
import { DiffReview } from "./DiffReview.js";

/**
 * Agent proposals from the MCP mailbox (#16.1, ADR-0020). Rendered ONLY when the
 * project is shared (an active connection) AND pending proposals exist — the
 * default shell is byte-for-byte unchanged. Each card shows the request and the
 * base→proposed diff through the SAME `DiffReview` the in-app agent uses; the
 * caller routes Accept through the conflict-aware gate (`resolveAccept` →
 * `applyAcceptedFileAsAgent`) and records the verdict in the mailbox. Accept
 * here is the mandatory human gate — the kernel cannot land an edit any other
 * way.
 *
 * DoS posture (Security-Analyst finding 1): record SIZES are enforced upstream
 * (the mailbox skips forged over-limit records before they reach this
 * component), and the COUNT rendered here is capped — a flood of pending
 * proposals shows only the newest few with a count notice, so `diffLines`
 * never runs over an unbounded card list.
 */

/** Max proposal cards rendered at once (newest first when over the cap). */
export const MAX_RENDERED_PROPOSALS = 5;

/**
 * The slice of pending proposals to render: all of them up to the cap, else the
 * NEWEST cap-many (the list arrives oldest-first) plus how many were hidden.
 */
export function visibleProposals(proposals: ProposalRecord[]): {
  shown: ProposalRecord[];
  hidden: number;
} {
  const shown = proposals.slice(-MAX_RENDERED_PROPOSALS);
  return { shown, hidden: proposals.length - shown.length };
}

/**
 * Resolve a proposal's target file STRICTLY (Security-Analyst finding 3): the
 * proposal carries a path, and paths can legitimately duplicate during a CRDT
 * conflict (`CollabProject.duplicatePaths`). Accept must know exactly which
 * file it would mutate — zero or multiple live matches block the apply with a
 * calm notice instead of guessing.
 */
export function findProposalTarget(
  files: ProjectFileSnapshot[],
  filePath: string,
):
  | { ok: true; file: ProjectFileSnapshot }
  | { ok: false; reason: "missing" | "duplicate"; count: number } {
  const matches = files.filter((f) => !f.deleted && f.path === filePath);
  if (matches.length === 1) return { ok: true, file: matches[0]! };
  return matches.length === 0
    ? { ok: false, reason: "missing", count: 0 }
    : { ok: false, reason: "duplicate", count: matches.length };
}

export function McpProposals({
  proposals,
  onAccept,
  onReject,
}: {
  proposals: ProposalRecord[];
  onAccept: (proposal: ProposalRecord) => void;
  onReject: (proposal: ProposalRecord) => void;
}) {
  if (proposals.length === 0) return null;
  const { shown, hidden } = visibleProposals(proposals);
  return (
    <section className="mcp-proposals" data-testid="mcp-proposals" aria-label="Agent proposals">
      <p className="mcp-proposals-head">
        Agent proposal{proposals.length > 1 ? "s" : ""} — review before anything changes
        {hidden > 0 && (
          <span className="mcp-proposals-overflow" data-testid="mcp-proposals-overflow">
            {" "}
            (showing the newest {shown.length} of {proposals.length})
          </span>
        )}
      </p>
      {shown.map((p) => (
        <article
          key={p.id}
          className="mcp-proposal"
          data-testid="mcp-proposal"
          data-proposal-id={p.id}
        >
          <p className="mcp-proposal-meta">
            <strong data-testid="mcp-proposal-request">{p.request}</strong>
            <span className="mcp-proposal-file">{p.filePath}</span>
          </p>
          <DiffReview
            base={p.baseText}
            next={p.proposedText}
            outcome="from a connected agent"
            onAccept={() => onAccept(p)}
            onReject={() => onReject(p)}
          />
        </article>
      ))}
    </section>
  );
}
