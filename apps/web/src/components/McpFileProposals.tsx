import { useState } from "react";
import type { FileProposalRecord } from "@galley/collab";
import { DiffBody } from "./DiffBody.js";

/**
 * Multi-file agent proposals from the `mcpFileProposals` mailbox (`propose_files`).
 * The sibling of {@link McpProposals} for ATOMIC change sets: one card shows the
 * request and a read-only diff per file op (create / edit), with a SINGLE
 * card-level Accept/Reject — the whole set lands or none of it does. Accept here
 * is the mandatory human gate; the caller validates every op against the live
 * snapshot first (`planFileProposalAccept`) and applies nothing on any conflict.
 *
 * DoS posture (mirrors McpProposals): record sizes are enforced upstream (the
 * mailbox skips forged over-limit records), and the COUNT rendered here is capped
 * so `diffLines` never runs over an unbounded card/op list.
 */

/** Max proposal cards rendered at once (newest first when over the cap). */
export const MAX_RENDERED_FILE_PROPOSALS = 5;

/** Human label per op kind, shown on each op's head row. */
const OP_LABEL: Record<FileProposalRecord["ops"][number]["kind"], string> = {
  create: "Create",
  edit: "Edit",
  rename: "Rename",
  delete: "Delete",
  "create-binary": "Add image",
};

/** A human byte size for a binary pointer summary (B-ish, KB, MB). */
function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function visibleFileProposals(proposals: FileProposalRecord[]): {
  shown: FileProposalRecord[];
  hidden: number;
} {
  const shown = proposals.slice(-MAX_RENDERED_FILE_PROPOSALS);
  return { shown, hidden: proposals.length - shown.length };
}

export function McpFileProposals({
  proposals,
  onAccept,
  onReject,
  onError,
}: {
  proposals: FileProposalRecord[];
  // B2: Accept is now ASYNC (the blob-presence gate awaits). The click handler
  // AWAITS the returned promise inside try/catch/finally — the button is DISABLED
  // while pending (no double-fire) and re-enabled on BOTH success and failure, and
  // an unexpected REJECTION is surfaced via `onError` (never a swallowed `void`).
  onAccept: (proposal: FileProposalRecord) => void | boolean | Promise<boolean | void>;
  onReject: (proposal: FileProposalRecord) => void;
  /** Surface an unexpected Accept rejection through the parent's error-notice path. */
  onError?: (message: string) => void;
}) {
  // Ids whose Accept is in flight — the button is disabled while pending (B2).
  const [accepting, setAccepting] = useState<ReadonlySet<string>>(() => new Set());
  const acceptOnce = async (p: FileProposalRecord): Promise<void> => {
    if (accepting.has(p.id)) return; // already in flight — ignore the re-click
    setAccepting((prev) => new Set(prev).add(p.id));
    try {
      await onAccept(p);
    } catch (err) {
      // The accept handler catches its own errors and returns false, so this is a
      // last-resort guard against an UNEXPECTED rejection — surface it rather than
      // let it become an unhandled promise rejection.
      onError?.(`Could not apply the proposal — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Re-enable on BOTH success and failure.
      setAccepting((prev) => {
        const next = new Set(prev);
        next.delete(p.id);
        return next;
      });
    }
  };
  if (proposals.length === 0) return null;
  const { shown, hidden } = visibleFileProposals(proposals);
  return (
    <section
      className="mcp-proposals mcp-file-proposals"
      data-testid="mcp-file-proposals"
      aria-label="Agent multi-file proposals"
    >
      <p className="mcp-proposals-head">
        Agent file proposal{proposals.length > 1 ? "s" : ""} — review before anything changes
        {hidden > 0 && (
          <span className="mcp-proposals-overflow" data-testid="mcp-file-proposals-overflow">
            {" "}
            (showing the newest {shown.length} of {proposals.length})
          </span>
        )}
      </p>
      {shown.map((p) => (
        <article
          key={p.id}
          className="mcp-proposal mcp-file-proposal"
          data-testid="mcp-file-proposal"
          data-proposal-id={p.id}
        >
          <p className="mcp-proposal-meta">
            <strong data-testid="mcp-file-proposal-request">{p.request}</strong>
            <span className="mcp-proposal-file">
              {p.ops.length} file{p.ops.length > 1 ? "s" : ""}
            </span>
          </p>
          {p.ops.map((op, i) => (
            <div
              key={`${op.path}-${i}`}
              className={
                op.kind === "delete"
                  ? "mcp-file-proposal-op mcp-file-proposal-op--delete"
                  : "mcp-file-proposal-op"
              }
              data-testid="file-proposal-op"
              data-op-kind={op.kind}
            >
              <p className="mcp-file-proposal-op-head">
                <span className="mcp-file-proposal-op-kind">{OP_LABEL[op.kind]}</span>{" "}
                {op.kind === "rename" ? (
                  <span className="mcp-proposal-file">
                    {op.path} <span aria-hidden="true">→</span>{" "}
                    <strong data-testid="file-proposal-op-newpath">{op.newPath}</strong>
                  </span>
                ) : (
                  <span className="mcp-proposal-file">{op.path}</span>
                )}
              </p>
              {/* Only create/edit carry a text diff; rename is metadata-only and
                  delete removes the whole file — the path line says it all. */}
              {(op.kind === "create" || op.kind === "edit") && (
                <DiffBody base={op.baseText} next={op.proposedText} />
              )}
              {op.kind === "create-binary" && op.binaryAsset !== undefined && (
                <p className="mcp-file-proposal-binary" data-testid="file-proposal-op-binary">
                  {op.binaryAsset.mime} · {humanBytes(op.binaryAsset.size)}
                </p>
              )}
            </div>
          ))}
          <div className="diff-actions mcp-file-proposal-actions">
            <button
              type="button"
              data-testid="file-proposal-accept"
              title="Apply this whole change set to the project"
              disabled={accepting.has(p.id)}
              aria-busy={accepting.has(p.id)}
              onClick={() => {
                // acceptOnce handles its OWN rejections (try/catch/finally), so the
                // returned promise carries no unhandled rejection — `void` is safe.
                void acceptOnce(p);
              }}
            >
              {accepting.has(p.id) ? "Applying…" : "Accept all"}
            </button>
            <button
              type="button"
              data-testid="file-proposal-reject"
              title="Discard this proposal"
              onClick={() => onReject(p)}
            >
              Reject
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
