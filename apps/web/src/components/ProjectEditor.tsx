/**
 * The project active-file editor (roadmap #2, slice 6): CodeMirror 6 bound to ONE
 * file's shared `Y.Text` via y-codemirror.next. It's the multi-file sibling of
 * `CollabEditor` — same theme/testid, but parameterized by a `Y.Text` (a file)
 * rather than a whole `CollabDocument`. Remount on file switch is driven by a
 * `key={fileId}` from the parent, so each file gets its own view + UndoManager.
 *
 * Per-file attribution decorations (via `textAttributedRanges`) paint each span
 * in its author's color when a `project` host is supplied (#14-C) — the same
 * affordance the single-file `CollabEditor` already has.
 */
import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Prec } from "@codemirror/state";
import { keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import {
  autocompletion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { UndoManager } from "yjs";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { CollabProject } from "@galley/collab";
import type { Diagnostic, SourceLineCol } from "@galley/shared";
import { typstLanguage, typstHighlightStyle } from "../typst-highlight.js";
import { cursorPosFromState } from "./Editor.js";
import { projectAttributionDecorations } from "./project-attribution-decorations.js";
import { commentDecorations, type OpenThreadHandler } from "./comment-decorations.js";
import {
  commentCreateTooltip,
  type CommentSelectionHandler,
} from "./comment-create-tooltip.js";
import {
  diagnosticsExtension,
  setDiagnostics,
} from "./diagnostics-extension.js";
import { searchPanelExtension } from "./search-extension.js";
import { editorPrefsExtensions, loadPrefs } from "../editor-prefs.js";

export function ProjectEditor({
  ytext,
  fileId,
  awareness,
  project,
  diagnostics,
  onView,
  onOpenThread,
  onComment,
  onCursorChange,
  onPasteImage,
  onDropImage,
  onDropNonImage,
  completionSources,
  placeholder,
  readOnly = false,
}: {
  ytext: Y.Text;
  /**
   * The active file's id — the key comment threads are anchored to (Comments
   * Phase A, Layer 2). Highlights/gutter markers are partitioned per file by this
   * id. Optional so callers that don't surface comments are unchanged.
   */
  fileId?: string;
  awareness: Awareness;
  /** Optional attribution host: paint author spans for this file when provided. */
  project?: CollabProject;
  diagnostics?: Diagnostic[];
  /** Optional: receive the live EditorView (and null on teardown) for jump-to. */
  onView?: (view: EditorView | null) => void;
  /**
   * Optional handler invoked when a comment gutter marker is clicked (Comments
   * Phase A, Layer 2): `(threadId, anchorRect)`. Wired to open the thread card.
   */
  onOpenThread?: OpenThreadHandler;
  /**
   * Optional handler invoked when the floating "Comment" bubble over a live text
   * selection is clicked (Comments Phase A, Layer 3): the snapshotted range the
   * host opens the create composer for. Absent → no comment-create affordance.
   */
  onComment?: CommentSelectionHandler;
  /**
   * OPTIONAL cursor-position callback (#11.3 forward sync). Fires on selection
   * moves with the head's 1-based-line / 0-based-column position. Default
   * undefined → no behavior change. (Lane F wires this to Preview.)
   */
  onCursorChange?: (pos: SourceLineCol) => void;
  /**
   * OPTIONAL image-paste handler (#7 7D). Fires when the clipboard carries image
   * FILES on paste (a screenshot, a copied image): the host uploads the bytes to
   * the project BlobStore and inserts an `#image(...)` at the cursor. Absent /
   * read-only → the editor's default text paste is untouched. Read live via a ref
   * so a fresh closure never remounts the (mount-time) extension.
   */
  onPasteImage?: (files: File[]) => void;
  /**
   * OPTIONAL image-DROP handler (#7 7D). Fires when image FILES are dropped onto
   * the editor: the host uploads them and inserts `#image(...)` at `pos` (the
   * drop offset, or null → cursor). CodeMirror's default drop would otherwise
   * swallow the image (or insert an SVG's raw XML as text), so the extension
   * always `preventDefault()`s a Files drop. Read via a ref (mount-time extension).
   */
  onDropImage?: (files: File[], pos: number | null) => void;
  /** OPTIONAL: a NON-image file was dropped on the editor (swallowed) — notify. */
  onDropNonImage?: () => void;
  /** Optional `@`-completion sources (labels/cites, #13/#6). Default-off. */
  completionSources?: CompletionSource[];
  /**
   * Optional ghost text shown while the file is EMPTY (#19.4 onboarding —
   * a teaching empty state). Default undefined → no behavior change.
   */
  placeholder?: string;
  /**
   * Read-only binding (B19-sharing-roles): a VIEWER joins a share read-only, so
   * the editor must refuse local typing while still receiving remote updates and
   * presence. Applies `EditorState.readOnly` (rejects user transactions but lets
   * the y-codemirror.next sync apply remote changes) AND `EditorView.editable`
   * `false` (drops the textarea-input affordance + the focus ring). Default
   * `false` → the editor binds exactly as before for owners/editors.
   */
  readOnly?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  const onCursorChangeRef = useRef(onCursorChange);
  onCursorChangeRef.current = onCursorChange;
  // Keep the latest open-thread handler reachable from the (mount-time) extension
  // without remounting the editor when the parent passes a fresh closure.
  const onOpenThreadRef = useRef(onOpenThread);
  onOpenThreadRef.current = onOpenThread;
  // Same fresh-closure-without-remount discipline for the create handler.
  const onCommentRef = useRef(onComment);
  onCommentRef.current = onComment;
  // …and for the image paste/drop handlers (the extension is mount-time too).
  const onPasteImageRef = useRef(onPasteImage);
  onPasteImageRef.current = onPasteImage;
  const onDropImageRef = useRef(onDropImage);
  onDropImageRef.current = onDropImage;
  const onDropNonImageRef = useRef(onDropNonImage);
  onDropNonImageRef.current = onDropNonImage;

  useEffect(() => {
    if (!host.current) return;
    const undoManager = new UndoManager(ytext);
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          basicSetup,
          typstLanguage,
          typstHighlightStyle,
          Prec.highest(keymap.of(yUndoManagerKeymap)),
          yCollab(ytext, awareness, { undoManager }),
          ...(project ? [projectAttributionDecorations(project, ytext)] : []),
          ...(project && fileId
            ? [
                commentDecorations(project, fileId, {
                  onOpenThread: (threadId, rect) => onOpenThreadRef.current?.(threadId, rect),
                }),
              ]
            : []),
          // The selection "Comment" bubble (Layer 3). Read-only viewers can't open
          // threads, so it's omitted for them; the handler is read live via the ref.
          ...(project && fileId && !readOnly
            ? [commentCreateTooltip({ ytext, onComment: (sel) => onCommentRef.current?.(sel) })]
            : []),
          diagnosticsExtension(),
          searchPanelExtension(),
          editorPrefsExtensions(loadPrefs()),
          ...(completionSources && completionSources.length > 0
            ? [autocompletion({ override: completionSources })]
            : []),
          ...(placeholder ? [cmPlaceholder(placeholder)] : []),
          // B19-sharing-roles: a viewer's editor refuses local edits but still
          // receives remote updates + presence. `readOnly` rejects user
          // transactions; `editable=false` drops the input affordance/caret.
          ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
          // #7 7D image paste + drop: intercept image FILES and route them to the
          // host (upload + insert). Omitted for a read-only viewer. Both fall
          // through to CodeMirror's default behavior when no image files are
          // present — EXCEPT a Files DROP is always swallowed (CM would otherwise
          // insert an SVG's raw XML as text, and a missed drop can navigate away).
          ...(readOnly
            ? []
            : [
                EditorView.domEventHandlers({
                  paste(event) {
                    const clip = event.clipboardData;
                    if (!clip) return false;
                    // Mixed clipboards (Excel/Word/PowerPoint) carry text/plain +
                    // an image rendition — respect the TEXT. Screenshots and browser
                    // "Copy image" carry no text/plain, so those still upload.
                    if (Array.from(clip.types).includes("text/plain")) return false;
                    const files: File[] = [];
                    for (let i = 0; i < clip.items.length; i++) {
                      const item = clip.items[i]!;
                      if (item.kind === "file" && item.type.startsWith("image/")) {
                        const file = item.getAsFile();
                        if (file) files.push(file);
                      }
                    }
                    if (files.length === 0) return false;
                    event.preventDefault();
                    onPasteImageRef.current?.(files);
                    return true;
                  },
                  drop(event, view) {
                    const dt = event.dataTransfer;
                    if (!dt || !Array.from(dt.types).includes("Files")) return false;
                    // A Files drop: never let CM insert text or the tab navigate.
                    event.preventDefault();
                    const images = Array.from(dt.files).filter((f) => f.type.startsWith("image/"));
                    if (images.length === 0) {
                      onDropNonImageRef.current?.();
                      return true;
                    }
                    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
                    onDropImageRef.current?.(images, pos ?? null);
                    return true;
                  },
                }),
              ]),
          EditorView.updateListener.of((u) => {
            // Emit cursor moves only when a consumer opted in (#11.3).
            if ((u.selectionSet || u.docChanged) && onCursorChangeRef.current) {
              onCursorChangeRef.current(cursorPosFromState(u.state));
            }
          }),
          EditorView.theme({
            "&": { height: "100%" },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily: "ui-monospace, monospace",
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    onViewRef.current?.(view);
    return () => {
      viewRef.current = null;
      onViewRef.current?.(null);
      view.destroy();
      undoManager.destroy();
    };
  }, [ytext, fileId, awareness, project, readOnly]);

  // Push diagnostics into the existing view (no remount). Undefined → cleared.
  useEffect(() => {
    if (viewRef.current) setDiagnostics(viewRef.current, diagnostics);
  }, [diagnostics]);

  return <div ref={host} className="editor" data-testid="editor" />;
}
