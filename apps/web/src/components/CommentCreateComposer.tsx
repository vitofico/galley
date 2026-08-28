/**
 * `CommentCreateComposer` (Comments Phase A, Layer 3) — the tiny point-anchored
 * composer that opens after the floating "Comment" bubble is clicked. Shows the
 * quoted selection + a one-field body; submitting hands the body to the host,
 * which calls `createThread` (an author-tagged CRDT transaction). Cancel / Escape
 * / outside-click discards.
 *
 * Shares the `.comment-card` chrome + the `useDismissable` contract with
 * `CommentThreadCard`; positioned with `clampMenuPosition` like the thread card.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { clampMenuPosition, type MenuPoint } from "./file-tree-menu.js";
import { useDismissable, type DismissReason } from "./use-dismissable.js";
import "./comments.css";

export function CommentCreateComposer({
  anchorText,
  anchor,
  onSubmit,
  onClose,
}: {
  /** The selected text the new thread will be anchored to (quoted for context). */
  anchorText: string;
  /** The on-screen rect to anchor the composer under (the bubble / selection). */
  anchor: DOMRect;
  /** Open the thread with this first-message body (host calls `createThread`). */
  onSubmit: (body: string) => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const restoreRef = useRef<Element | null>(
    typeof document !== "undefined" ? document.activeElement : null,
  );
  const [draft, setDraft] = useState("");
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

  // Focus the body field once mounted so the user can type immediately.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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

  const submit = () => {
    const body = draft.trim();
    if (body === "") return;
    onSubmit(body);
  };

  return (
    <div
      ref={rootRef}
      className="comment-card"
      role="dialog"
      aria-label="New comment"
      data-testid="comment-create"
      style={{ left: position.x, top: position.y }}
    >
      <blockquote className="comment-quote" data-testid="comment-create-anchor-text">
        {anchorText}
      </blockquote>
      <div className="comment-composer">
        <textarea
          ref={inputRef}
          className="comment-input"
          data-testid="comment-create-input"
          placeholder="Add a comment…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="comment-actions">
          <button
            type="button"
            className="comment-btn comment-btn--ghost"
            data-testid="comment-create-cancel"
            onClick={() => close("action")}
          >
            Cancel
          </button>
          <span className="comment-actions-spacer" />
          <button
            type="button"
            className="comment-btn comment-btn--primary"
            data-testid="comment-create-submit"
            disabled={draft.trim() === ""}
            onClick={submit}
          >
            Comment
          </button>
        </div>
      </div>
    </div>
  );
}
