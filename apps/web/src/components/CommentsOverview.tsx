/**
 * `CommentsOverview` (Comments Phase A, Layer 5) — the toolbar toggle + its
 * dropdown listing EVERY thread across the whole project (not just the active
 * file). The trigger is a `.pill-icon-btn` carrying a count pip (quiet at zero);
 * the dropdown is a toolbar-anchored `role="dialog"` modeled on `SharePopover`,
 * dismissed via the shared `useDismissable` contract.
 *
 * The list is document-ordered (file order, then position within a file), with an
 * open/resolved filter and a dedicated Orphaned section for threads whose anchored
 * text was edited away (`resolveThreadRange` → null — they keep their `anchorText`
 * but have nowhere to jump). Clicking a row asks the host to focus-jump to the
 * thread (same-file `jumpToOffset`, cross-file via the pending-jump stash) and open
 * its card.
 *
 * Pure-data only: the host passes already-projected rows (`OverviewThread`) so this
 * component never touches the CRDT or CodeMirror directly.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useDismissable, type DismissReason } from "./use-dismissable.js";
import "./rail-and-pills.css";
import "./comments.css";

/** A thread projected for the overview list (resolved-range + file path baked in). */
export interface OverviewThread {
  id: string;
  fileId: string;
  /** The file's display path (for the row meta + grouping). */
  filePath: string;
  /** Document-order key: [file index, offset-within-file]. */
  order: [number, number];
  anchorText: string;
  status: "open" | "resolved";
  messageCount: number;
  /** The anchored span no longer resolves (the text was deleted). */
  orphaned: boolean;
}

type Filter = "open" | "resolved";

/** PURE: document-order sort (file index, then within-file offset, then id). */
export function sortOverviewThreads(threads: OverviewThread[]): OverviewThread[] {
  return [...threads].sort(
    (a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * PURE: split document-ordered threads into the visible `live` rows (non-orphaned,
 * matching the status filter) and the always-shown `orphans`. Orphans are never
 * hidden by the filter — a detached thread still needs reading + resolving.
 */
export function partitionOverviewThreads(
  ordered: OverviewThread[],
  filter: Filter,
): { live: OverviewThread[]; orphans: OverviewThread[] } {
  return {
    live: ordered.filter((t) => !t.orphaned && t.status === filter),
    orphans: ordered.filter((t) => t.orphaned),
  };
}

export function CommentsOverview({
  threads,
  onJump,
}: {
  threads: OverviewThread[];
  /** Focus-jump to a thread + open its card (host wires same/cross-file). */
  onJump: (threadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("open");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback((reason: DismissReason | "action") => {
    setOpen(false);
    if (reason === "escape") triggerRef.current?.focus();
  }, []);
  useDismissable(open, rootRef, close);

  // The pip counts OPEN threads only (a resolved thread is "done" — not a nudge).
  const openCount = useMemo(() => threads.filter((t) => t.status === "open").length, [threads]);

  // Document order: file index, then within-file offset.
  const ordered = useMemo(() => sortOverviewThreads(threads), [threads]);

  // The filter applies to non-orphaned threads; orphans get their own section so
  // they're never silently hidden (you still want to read + reopen/resolve them).
  const { live, orphans } = useMemo(
    () => partitionOverviewThreads(ordered, filter),
    [ordered, filter],
  );

  const row = (t: OverviewThread) => (
    <button
      key={t.id}
      type="button"
      className="comment-overview-item"
      data-testid="comment-overview-item"
      data-thread-id={t.id}
      onClick={() => {
        onJump(t.id);
        close("action");
      }}
    >
      <span className="comment-overview-quote">“{t.anchorText}”</span>
      <span className="comment-overview-meta">
        <span className="comment-overview-file">{t.filePath}</span>
        <span>
          {t.messageCount} {t.messageCount === 1 ? "message" : "messages"}
        </span>
        {t.orphaned && <span>· detached</span>}
      </span>
    </button>
  );

  return (
    <div className="comments-toggle-wrap" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="pill-icon-btn"
        data-testid="comments-toggle"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={openCount > 0 ? `Comments (${openCount} open)` : "Comments"}
        title="Comments"
        onClick={() => (open ? close("action") : setOpen(true))}
      >
        💬
        {openCount > 0 && (
          <span className="comments-count" data-testid="comments-count" aria-hidden="true">
            {openCount}
          </span>
        )}
      </button>
      {open && (
        <div
          className="ui-popover comments-overview"
          role="dialog"
          aria-label="Comments"
          data-testid="comments-overview"
        >
          <div className="comments-overview-head">
            <span className="comments-overview-title">Comments</span>
            <div className="comments-filter" role="group" aria-label="Filter comments">
              <button
                type="button"
                className="comments-filter-btn"
                data-testid="comments-filter-open"
                aria-pressed={filter === "open"}
                onClick={() => setFilter("open")}
              >
                Open
              </button>
              <button
                type="button"
                className="comments-filter-btn"
                data-testid="comments-filter-resolved"
                aria-pressed={filter === "resolved"}
                onClick={() => setFilter("resolved")}
              >
                Resolved
              </button>
            </div>
          </div>
          <div className="comments-list">
            {live.length === 0 && orphans.length === 0 ? (
              <p className="comments-empty">No {filter} comments.</p>
            ) : (
              <>
                {live.length === 0 ? (
                  <p className="comments-empty">No {filter} comments.</p>
                ) : (
                  live.map(row)
                )}
                {orphans.length > 0 && (
                  <>
                    <p className="comment-overview-section-label">Detached</p>
                    {orphans.map(row)}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
