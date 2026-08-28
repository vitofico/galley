/**
 * `VersionCompare` — a READ-ONLY view of the difference between two saved
 * versions (#12.6 compare). It renders a `VersionComparison` (computed by the
 * pure `compareVersionTrees` helper) as a per-file line diff. Deliberately NOT
 * built on `DiffReview` (which carries Accept/Reject semantics): comparing two
 * historical versions is inspection only — there is no apply surface here. The
 * coordinator materializes both version trees and hands the comparison in; this
 * component holds no store/CRDT logic.
 */
import { useState } from "react";
import type { VersionComparison, VersionFileDiff } from "../version-compare.js";
import { diffLines } from "../version-compare.js";

export interface VersionCompareProps {
  comparison: VersionComparison;
  /** Human labels for the two compared versions (older → newer). */
  baseLabel: string;
  otherLabel: string;
}

const STATUS_LABEL: Record<VersionFileDiff["status"], string> = {
  added: "added",
  removed: "removed",
  modified: "modified",
  unchanged: "unchanged",
};

/** A single file's expandable line diff (only meaningful when modified). */
function FileDiff({ diff }: { diff: VersionFileDiff }) {
  // Modified files are the interesting ones — expand them by default; leave the
  // rest collapsed so the summary stays scannable.
  const [open, setOpen] = useState(diff.status === "modified");
  const ops =
    diff.status === "modified" ? diffLines(diff.baseText ?? "", diff.otherText ?? "") : [];

  return (
    <li className={`vcompare-file vcompare-${diff.status}`} data-testid="vcompare-file" data-path={diff.path}>
      <button
        type="button"
        className="vcompare-file-head"
        data-testid="vcompare-file-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`vcompare-badge vcompare-badge-${diff.status}`}>{STATUS_LABEL[diff.status]}</span>
        <span className="vcompare-path">{diff.path}</span>
      </button>
      {open && diff.status === "modified" && (
        <pre className="vcompare-diff" data-testid="vcompare-diff">
          {ops.map((op, i) => (
            <div key={i} className={`vcompare-line vcompare-line-${op.type}`}>
              <span className="vcompare-gutter">
                {op.type === "add" ? "+" : op.type === "del" ? "−" : " "}
              </span>
              {op.text}
            </div>
          ))}
        </pre>
      )}
    </li>
  );
}

export function VersionCompare({ comparison, baseLabel, otherLabel }: VersionCompareProps) {
  const { files, summary } = comparison;
  return (
    <section className="vcompare" data-testid="version-compare" aria-label="Compare versions">
      <header className="vcompare-header">
        <span className="vcompare-title">
          Comparing <strong>{baseLabel}</strong> → <strong>{otherLabel}</strong>
        </span>
        <span className="vcompare-summary" data-testid="vcompare-summary">
          {summary.added} added · {summary.removed} removed · {summary.modified} modified ·{" "}
          {summary.unchanged} unchanged
        </span>
      </header>
      {files.length === 0 ? (
        <div className="vcompare-empty" data-testid="vcompare-empty">
          No files to compare.
        </div>
      ) : (
        <ul className="vcompare-files">
          {files.map((diff) => (
            <FileDiff key={diff.path} diff={diff} />
          ))}
        </ul>
      )}
    </section>
  );
}
