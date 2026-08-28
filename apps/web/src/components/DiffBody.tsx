import { diffLines } from "diff";

/**
 * The unified line-diff VIEW (base → next), extracted from {@link DiffReview} so
 * it can be reused without the Accept/Reject controls — a multi-file proposal
 * card (McpFileProposals) renders one read-only DiffBody per file op and carries
 * a SINGLE card-level Accept/Reject (the change set is atomic). The diff is a
 * view only; Accept re-applies the edit blocks conflict-aware in the caller.
 */
export function DiffBody({ base, next }: { base: string; next: string }) {
  const parts = diffLines(base, next);
  return (
    <pre className="diff-body">
      {parts.map((part, i) => {
        const cls = part.added ? "diff-add" : part.removed ? "diff-del" : "diff-ctx";
        const sign = part.added ? "+" : part.removed ? "-" : " ";
        return part.value
          .replace(/\n$/, "")
          .split("\n")
          .map((line, j) => (
            <span key={`${i}-${j}`} className={cls}>
              {sign} {line}
              {"\n"}
            </span>
          ));
      })}
    </pre>
  );
}
