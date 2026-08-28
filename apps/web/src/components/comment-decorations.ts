/**
 * In-editor comment decorations (Comments Phase A, Layer 2): a CodeMirror 6
 * extension that paints each OPEN comment thread's anchored span with a subtle
 * accent highlight and drops an INTERACTIVE marker in a dedicated gutter on the
 * thread's start line — click it to open the thread card (wired by the host).
 *
 * The data lives in the project's CRDT (the `@galley/collab` comments map), so —
 * exactly like `project-attribution-decorations.ts`, NOT the StateEffect-driven
 * `diagnostics-extension.ts` — this is a `ViewPlugin` observing the comments map
 * directly. Reentrancy care is identical to the attribution plugin: a Yjs observer
 * fires SYNCHRONOUSLY inside yCollab's own `view.dispatch`, so a comment change
 * arriving over the wire is refreshed out-of-band on a `queueMicrotask` (never a
 * dispatch from inside an in-progress update); local text edits are folded in from
 * CM's own `update()` cycle, since a relative-position anchor's decoded offset
 * moves as the doc changes.
 *
 * The thread anchors are decoded against `host.doc` via the pure `resolveThreadRange`
 * render seam from Layer 1; resolved + orphaned threads are dropped from the paint
 * (an orphan keeps living in the cross-file overview, Layer 5). All CSS ships via
 * `EditorView.baseTheme(…)` using the accent design tokens — never `--err`/`--warn`
 * (reserved for diagnostics), and never `styles.css`.
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  gutter,
  GutterMarker,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { type Extension, RangeSetBuilder, StateEffect } from "@codemirror/state";
import {
  observeComments,
  getThreads,
  resolveThreadRange,
  type DocHost,
  type ThreadView,
} from "@galley/collab";
import type * as Y from "yjs";

/** A resolved, paintable comment range in absolute UTF-16 offsets. */
export interface CommentRange {
  from: number;
  to: number;
  threadId: string;
}

/** Open the thread `threadId`, anchored at the clicked gutter marker's rect. */
export type OpenThreadHandler = (threadId: string, anchor: DOMRect) => void;

/**
 * A no-op transaction marker dispatched out-of-band when the comments map changed
 * with no local doc edit (a remote thread arriving / resolving over the wire). The
 * highlight repaints off the ViewPlugin's `decorations`, but the gutter's
 * `lineMarkerChange` watches `docChanged` — so without this signal a remotely-
 * arrived thread would have NO clickable marker until the user's next local edit.
 */
export const commentRefreshEffect = StateEffect.define<null>();

/**
 * PURE: should the gutter rebuild its line markers for this update? True on a local
 * doc edit (an anchor may have moved lines) OR when ANY transaction in the update
 * carries {@link commentRefreshEffect} — the signal the plugin dispatches when a
 * remote thread arrives/resolves with no local edit. Without the effect arm a
 * remotely-arrived thread would paint its highlight but NOT its clickable marker
 * until the user's next local edit. Takes the `transactions`/`docChanged` shape so
 * it is unit-testable from a plain `EditorState.update(...)` (no DOM/`EditorView`).
 */
export function gutterMarkerChanged(update: {
  docChanged: boolean;
  transactions: readonly { effects: readonly StateEffect<unknown>[] }[];
}): boolean {
  return (
    update.docChanged ||
    update.transactions.some((tr) => tr.effects.some((e) => e.is(commentRefreshEffect)))
  );
}

/**
 * PURE: decode every OPEN thread's anchors against `doc` into absolute UTF-16
 * ranges. Resolved threads and orphaned threads (whose anchored span was deleted —
 * `resolveThreadRange` returns null) are dropped, since they have nothing live to
 * paint. Output order mirrors input order; callers SORT before a RangeSetBuilder.
 */
export function commentsToRanges(threads: ThreadView[], doc: Y.Doc): CommentRange[] {
  const out: CommentRange[] = [];
  // resolveThreadRange only reads `host.doc`, so a bare `{ doc }` host suffices.
  const host: DocHost = { doc };
  for (const thread of threads) {
    if (thread.status !== "open") continue;
    const range = resolveThreadRange(host, thread);
    if (!range) continue; // orphaned -> drops from the editor paint (still in overview)
    out.push({ from: range.from, to: range.to, threadId: thread.id });
  }
  return out;
}

/** Decoded ranges for ONE file, sorted ascending (RangeSetBuilder's contract). */
function rangesForFile(host: DocHost, fileId: string): CommentRange[] {
  const ranges = commentsToRanges(
    getThreads(host).filter((t) => t.fileId === fileId),
    host.doc,
  );
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return ranges;
}

const commentMark = Decoration.mark({ class: "cm-comment-highlight" });

function buildHighlights(ranges: CommentRange[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) {
    builder.add(r.from, r.to, commentMark);
  }
  return builder.finish();
}

class CommentGutterMarker extends GutterMarker {
  constructor(readonly threadId: string) {
    super();
  }
  override eq(other: CommentGutterMarker): boolean {
    return other.threadId === this.threadId;
  }
  override toDOM(): Node {
    const span = document.createElement("span");
    span.className = "cm-comment-gutter-marker";
    span.setAttribute("data-thread-id", this.threadId);
    span.setAttribute("aria-hidden", "true");
    span.textContent = "💬";
    return span;
  }
}

const commentsTheme = EditorView.baseTheme({
  // Subtle accent wash over the anchored span — readable, never a destructive cue.
  ".cm-comment-highlight": {
    backgroundColor: "color-mix(in srgb, var(--accent, #ff6a3d) 14%, transparent)",
    borderRadius: "2px",
  },
  ".cm-comment-gutter": {
    width: "1.2em",
    textAlign: "center",
    cursor: "pointer",
  },
  ".cm-comment-gutter-marker": {
    color: "var(--accent-deep, #ff9170)",
    fontSize: "0.78em",
    lineHeight: "1",
    cursor: "pointer",
  },
});

/**
 * The comment-decorations extension for ONE file. Observes the project's comments
 * map and paints OPEN threads anchored to `fileId` — highlight over the span, an
 * interactive marker in a dedicated gutter on the start line. Clicking a marker
 * resolves line→threadId and invokes `onOpenThread(threadId, rect)` with the
 * marker's on-screen rect (the anchor for the thread card, Layer 4).
 *
 * `fileId` partitions the paint per file (single-file callers pass `SINGLE_FILE_ID`);
 * the host mounts this keyed on the active file, so a remount swaps the file cleanly.
 */
export function commentDecorations(
  host: DocHost,
  fileId: string,
  { onOpenThread }: { onOpenThread?: OpenThreadHandler } = {},
): Extension {
  const highlightPlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private readonly off: () => void;
      private scheduled = false;
      private destroyed = false;

      constructor(private readonly view: EditorView) {
        this.decorations = buildHighlights(rangesForFile(host, fileId));
        // A comment arriving/flipping/replying over the wire needs an out-of-band
        // refresh; local doc edits are handled by update() (anchors decode live).
        this.off = observeComments(host, () => this.scheduleRefresh());
      }

      private scheduleRefresh(): void {
        if (this.scheduled || this.destroyed) return;
        this.scheduled = true;
        queueMicrotask(() => {
          this.scheduled = false;
          if (this.destroyed) return;
          this.decorations = buildHighlights(rangesForFile(host, fileId));
          // Carry a marker effect so the gutter's `lineMarkerChange` repaints too
          // (a bare dispatch is docChanged=false, which the gutter ignores). Safe:
          // runs after any in-progress update unwinds.
          this.view.dispatch({ effects: commentRefreshEffect.of(null) });
        });
      }

      update(update: ViewUpdate): void {
        // A relative-position anchor's decoded offset shifts as the doc changes.
        if (update.docChanged) this.decorations = buildHighlights(rangesForFile(host, fileId));
      }

      destroy(): void {
        this.destroyed = true;
        this.off();
      }
    },
    { decorations: (v) => v.decorations },
  );

  const commentGutter = gutter({
    class: "cm-comment-gutter",
    lineMarker(view, line) {
      const ranges = rangesForFile(host, fileId);
      if (ranges.length === 0) return null;
      // First thread whose range touches this line wins the marker (one per line).
      for (const r of ranges) {
        if (r.from <= line.to && r.to >= line.from) {
          return new CommentGutterMarker(r.threadId);
        }
      }
      return null;
    },
    // Rebuild markers on a local doc edit (an anchor may have moved lines) OR on a
    // comment-map arrival — the plugin's microtask dispatch carries
    // `commentRefreshEffect`, so a remote thread paints its marker with no local edit.
    lineMarkerChange: gutterMarkerChanged,
    domEventHandlers: {
      mousedown(view, line, event) {
        const ranges = rangesForFile(host, fileId);
        let threadId: string | null = null;
        for (const r of ranges) {
          if (r.from <= line.to && r.to >= line.from) {
            threadId = r.threadId;
            break;
          }
        }
        if (threadId === null) return false;
        const target = event.target as HTMLElement | null;
        const rect = (target?.closest(".cm-comment-gutter-marker") ?? target)?.getBoundingClientRect();
        onOpenThread?.(threadId, rect ?? new DOMRect(0, 0, 0, 0));
        return true; // handled: don't let it also move the cursor
      },
    },
    // No `initialSpacer`: with no comments the gutter reserves no width, so an
    // editor with no threads renders identically to one without this extension.
  });

  return [highlightPlugin, commentGutter, commentsTheme];
}
