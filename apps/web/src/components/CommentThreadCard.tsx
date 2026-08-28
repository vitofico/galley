/**
 * `CommentThreadCard` (Comments Phase A, Layer 4) — the point-anchored floating
 * card for ONE comment thread: the quoted anchored text, the message list, a
 * reply box, and a Resolve/Reopen toggle. Opened from a gutter marker (the editor)
 * or a row in the cross-file overview (Layer 5); the host hands in the on-screen
 * `anchor` rect (the marker / list item) and the live `thread`.
 *
 * Modeled on `FileTreeMenu`: a `position: fixed` card clamped into the viewport
 * with `clampMenuPosition`, dismissed via the shared `useDismissable` contract
 * (outside-pointerdown closes without stealing focus; Escape closes and refocuses
 * the opener). a11y: `role="dialog"` with an accessible name. All writes flow
 * through the host's handlers, which wrap `addMessage`/`setThreadStatus` (each an
 * author-tagged CRDT transaction) — the card never touches the doc directly.
 *
 * The card is presentational + reactive: the host re-derives `thread` from the
 * observed comments map on every change, so a remote reply / status flip is
 * reflected the moment it arrives.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Author } from "@galley/shared";
import type { ThreadView } from "@galley/collab";
import { authorLabel } from "../attribution-style.js";
import { clampMenuPosition, type MenuPoint } from "./file-tree-menu.js";
import { useDismissable, type DismissReason } from "./use-dismissable.js";
import "./comments.css";

/** Short relative-ish timestamp, e.g. "14:05" today or a date otherwise. PURE. */
function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function CommentThreadCard({
  thread,
  anchor,
  orphaned,
  viewers,
  onReply,
  onResolve,
  onReopen,
  onClose,
}: {
  thread: ThreadView;
  /** The opener's on-screen rect (gutter marker / overview row). */
  anchor: DOMRect;
  /** The anchored span no longer resolves (its text was deleted) — show a note. */
  orphaned?: boolean;
  /** How many OTHER peers currently have this thread open (L6 "N viewing" cue). */
  viewers?: number;
  /** Append a reply (host wraps `addMessage` — an author-tagged transaction). */
  onReply: (body: string) => void;
  /** Resolve the thread (host wraps `setThreadStatus(…, "resolved")`). */
  onResolve: () => void;
  /** Reopen a resolved thread (host wraps `setThreadStatus(…, "open")`). */
  onReopen: () => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const replyRef = useRef<HTMLTextAreaElement | null>(null);
  const restoreRef = useRef<Element | null>(
    typeof document !== "undefined" ? document.activeElement : null,
  );
  const [draft, setDraft] = useState("");
  // Anchor below the opener's bottom-left; clamped once the card size is known.
  const desired: MenuPoint = useMemo(
    () => ({ x: anchor.left, y: anchor.bottom + 6 }),
    [anchor.left, anchor.bottom],
  );
  const [position, setPosition] = useState<MenuPoint>(desired);

  const close = useCallback(
    (reason: DismissReason | "action") => {
      if (reason !== "outside") {
        const restore = restoreRef.current;
        if (restore instanceof HTMLElement && restore.isConnected) restore.focus();
      }
      onClose();
    },
    [onClose],
  );
  useDismissable(true, rootRef, close);

  // Clamp into the viewport once the real card size is measurable (pre-paint).
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPosition(
      clampMenuPosition(
        desired,
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [desired]);

  const submitReply = () => {
    const body = draft.trim();
    if (body === "") return;
    onReply(body);
    setDraft("");
    replyRef.current?.focus();
  };

  const resolved = thread.status === "resolved";

  return (
    <div
      ref={rootRef}
      className="comment-card"
      role="dialog"
      aria-label="Comment thread"
      data-testid="comment-thread-card"
      data-thread-id={thread.id}
      style={{ left: position.x, top: position.y }}
    >
      <blockquote
        className={`comment-quote${orphaned ? " comment-quote--orphaned" : ""}`}
        data-testid="comment-anchor-text"
      >
        {thread.anchorText}
      </blockquote>
      {orphaned && (
        <p className="comment-orphan-note" data-testid="comment-orphaned">
          The commented text was edited away — this thread is no longer anchored.
        </p>
      )}
      {viewers !== undefined && viewers > 0 && (
        <p className="comment-viewers" data-testid="comment-viewers">
          <span className="comment-viewers-dot" aria-hidden="true" />
          {viewers === 1 ? "1 other viewing" : `${viewers} others viewing`}
        </p>
      )}
      <div className="comment-messages">
        {thread.messages.map((m) => (
          <div key={m.id} className="comment-message">
            <div className="comment-message-head">
              <span className={`comment-author${m.author.kind === "agent" ? " comment-author--agent" : ""}`}>
                {authorName(m.author)}
              </span>
              {formatTimestamp(m.createdAt) && (
                <span className="comment-time">{formatTimestamp(m.createdAt)}</span>
              )}
            </div>
            <p className="comment-body">{m.body}</p>
          </div>
        ))}
      </div>
      <div className="comment-composer">
        <textarea
          ref={replyRef}
          className="comment-input"
          data-testid="comment-reply-input"
          placeholder="Reply…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter submits (a plain Enter inserts a newline in the body).
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submitReply();
            }
          }}
        />
        <div className="comment-actions">
          {resolved ? (
            <button
              type="button"
              className="comment-btn comment-btn--ghost"
              data-testid="comment-reopen"
              onClick={() => {
                onReopen();
              }}
            >
              Reopen
            </button>
          ) : (
            <button
              type="button"
              className="comment-btn comment-btn--ghost"
              data-testid="comment-resolve"
              onClick={() => {
                onResolve();
              }}
            >
              Resolve
            </button>
          )}
          <span className="comment-actions-spacer" />
          <button
            type="button"
            className="comment-btn comment-btn--primary"
            data-testid="comment-reply-submit"
            disabled={draft.trim() === ""}
            onClick={submitReply}
          >
            Reply
          </button>
        </div>
      </div>
    </div>
  );
}

/** The display name for a message author (the human's name or the generic role). */
function authorName(author: Author): string {
  return authorLabel(author);
}
