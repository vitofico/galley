/**
 * The floating "Comment" affordance over a live text selection (Comments Phase A,
 * Layer 3). A CodeMirror `showTooltip` extension: whenever the editor holds a
 * non-empty selection it floats a one-button bubble at the selection head, and
 * clicking it hands the snapshotted range up to the host (`onComment`) to open
 * the create composer.
 *
 * Why a CM tooltip and NOT a React overlay positioned from `view.coordsAtPos`:
 * the `.editor` host is `overflow: hidden` (`styles.css`), so an absolutely
 * positioned React bubble would be clipped at the pane edge and wouldn't track
 * the editor's own scroll. The `showTooltip` facet anchors INSIDE CodeMirror's
 * tooltip layer, which already handles scroll-follow + viewport flipping — the
 * same machinery the autocomplete + diagnostics tooltips ride on.
 *
 * The tooltip is recomputed from a `StateField` watching `state.selection`, so it
 * appears/moves/clears as the selection changes with zero React involvement. The
 * button click reads the LIVE selection off the view (never a stale closure) and
 * fires `onComment`; the host snapshots it (like `openReviseSelection`) before
 * opening the composer.
 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import { encodeAnchor } from "@galley/collab";
import type * as Y from "yjs";
import { selectionFromEditor } from "../revise-selection.js";

/**
 * A snapshotted selection the host turns into a new thread. The relative-position
 * anchors are encoded HERE, at selection time (off the live `ytext`), not at submit
 * time — so a concurrent remote edit during the compose window can't mis-anchor the
 * thread. `from`/`to`/`text` are carried for the composer's quoted-text display.
 */
export interface CommentSelection {
  from: number;
  to: number;
  text: string;
  /** Encoded Yjs relative position of the range start, pinned at selection time. */
  anchorStart: Uint8Array;
  /** Encoded Yjs relative position of the range end, pinned at selection time. */
  anchorEnd: Uint8Array;
}

/** Open the create composer for a snapshotted selection (host-provided). */
export type CommentSelectionHandler = (selection: CommentSelection) => void;

/** Editor focus gained/lost — drives the tooltip field to recompute on blur. */
const focusEffect = StateEffect.define<boolean>();

/**
 * Build the selection-anchored "Comment" tooltip extension. `onComment` is read
 * through a stable wrapper at mount so the host can pass a fresh closure without
 * remounting the editor (the button calls the latest handler). The bubble only
 * shows while the editor holds focus (cleared on blur) and the anchors are encoded
 * at selection time off the live `ytext`.
 */
export function commentCreateTooltip({
  ytext,
  onComment,
}: {
  /** The shared `Y.Text` the selection lives in — anchors are encoded off it. */
  ytext: Y.Text;
  onComment: CommentSelectionHandler;
}): Extension {
  // The bubble is gated on editor focus: without it, the field only recomputed on
  // selection/doc change, so the bubble would linger after focus left the editor.
  // We track focus in the field (seeded false; flipped by `focusEffect`) and clear
  // the bubble whenever the editor isn't focused.
  const tooltipField = StateField.define<{ focused: boolean; tooltip: Tooltip | null }>({
    create: () => ({ focused: false, tooltip: null }),
    update(value, tr) {
      let focused = value.focused;
      for (const e of tr.effects) if (e.is(focusEffect)) focused = e.value;
      // Recompute only when something that affects the bubble changed.
      if (focused === value.focused && !tr.selection && !tr.docChanged) return value;
      return {
        focused,
        tooltip: focused ? buildTooltip(tr.state.selection.main, ytext, onComment) : null,
      };
    },
    provide: (f) => showTooltip.from(f, (v) => v.tooltip),
  });
  const focusWatcher = EditorView.updateListener.of((u) => {
    if (u.focusChanged) u.view.dispatch({ effects: focusEffect.of(u.view.hasFocus) });
  });
  return [tooltipField, focusWatcher, bubbleTheme];
}

/**
 * Bubble chrome via `baseTheme` (never `styles.css`) — a small accent pill that
 * rides CodeMirror's tooltip layer. Accent tokens from `theme.css`, never the
 * destructive `--err`.
 */
const bubbleTheme = EditorView.baseTheme({
  // Neutralize the default tooltip chrome around OUR bubble (it provides its own).
  ".cm-tooltip:has(.cm-comment-bubble)": {
    border: "none",
    background: "transparent",
    boxShadow: "none",
  },
  ".cm-comment-bubble": {
    display: "inline-flex",
  },
  ".cm-comment-bubble-btn": {
    font: "inherit",
    fontSize: "0.78rem",
    fontWeight: "600",
    lineHeight: "1",
    padding: "0.32rem 0.62rem",
    border: "1px solid color-mix(in srgb, var(--accent, #f0510e) 40%, transparent)",
    borderRadius: "999px",
    background: "var(--accent, #f0510e)",
    color: "var(--on-accent, #fff)",
    cursor: "pointer",
    boxShadow: "var(--shadow-2, 0 6px 18px rgba(0, 0, 0, 0.18))",
  },
});

/**
 * PURE: the tooltip anchor offset for a selection range, or null when the range
 * is empty/collapsed (no bubble). Anchors at the END of the selection — its head,
 * where the cursor rests. Exposed for unit testing the appear/clear decision
 * without a CodeMirror view.
 */
export function selectionTooltipPos(range: { from: number; to: number }): number | null {
  return range.to <= range.from ? null : range.to;
}

/** A non-empty selection floats the bubble at its head; an empty one clears it. */
function buildTooltip(
  range: { from: number; to: number },
  ytext: Y.Text,
  onComment: CommentSelectionHandler,
): Tooltip | null {
  const pos = selectionTooltipPos(range);
  if (pos === null) return null;
  // Float ABOVE the head so the bubble never covers the text being commented on.
  return {
    pos,
    above: true,
    strictSide: false,
    arrow: false,
    create: (view) => renderBubble(view, ytext, onComment),
  };
}

/** The bubble DOM: a single "Comment" button that snapshots the live selection. */
function renderBubble(view: EditorView, ytext: Y.Text, onComment: CommentSelectionHandler) {
  const dom = document.createElement("div");
  dom.className = "cm-comment-bubble";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-comment-bubble-btn";
  button.setAttribute("data-testid", "comment-add");
  button.textContent = "Comment";
  // `mousedown` (not `click`) so the press doesn't first blur+collapse the
  // selection the bubble is anchored to; preventDefault keeps focus in-editor.
  button.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const sel = selectionFromEditor(view.state);
    if (!sel) return;
    // Encode the anchors NOW, off the live `ytext`, so a remote edit during the
    // compose window can't shift the offsets the thread ends up anchored to.
    onComment({
      from: sel.from,
      to: sel.to,
      text: sel.text,
      anchorStart: encodeAnchor(ytext, sel.from),
      anchorEnd: encodeAnchor(ytext, sel.to),
    });
  });
  dom.appendChild(button);
  return { dom };
}
