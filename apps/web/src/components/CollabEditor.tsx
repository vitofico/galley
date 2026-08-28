/**
 * The collaborative editor (Phase 2c): CodeMirror 6 bound to a shared Yjs
 * `Y.Text` via y-codemirror.next. The `Y.Text` is the write source of truth;
 * the app reads through it (App subscribes to the doc for `source`). Mirrors the
 * uncontrolled `Editor`'s testid/theme so the rest of the UI + e2e are unchanged.
 *
 * Undo is routed through Yjs's `UndoManager` (high-precedence `yUndoManagerKeymap`
 * over basicSetup's history) so undo is collaboration-aware. The editor is NEVER
 * remounted on Accept — mutating the `Y.Text` updates the view through yCollab.
 */
import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import {
  autocompletion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { UndoManager } from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { CollabDocument } from "@galley/collab";
import type { Diagnostic, SourceLineCol } from "@galley/shared";
import { typstLanguage, typstHighlightStyle } from "../typst-highlight.js";
import { cursorPosFromState } from "./Editor.js";
import { attributionDecorations } from "./attribution-decorations.js";
import { commentDecorations, type OpenThreadHandler } from "./comment-decorations.js";
import { SINGLE_FILE_ID } from "@galley/collab";
import {
  diagnosticsExtension,
  setDiagnostics,
} from "./diagnostics-extension.js";
import { searchPanelExtension } from "./search-extension.js";
import { editorPrefsExtensions, loadPrefs } from "../editor-prefs.js";

export function CollabEditor({
  doc,
  awareness,
  diagnostics,
  onView,
  onOpenThread,
  onCursorChange,
  completionSources,
}: {
  doc: CollabDocument;
  awareness: Awareness;
  diagnostics?: Diagnostic[];
  /** Optional: receive the live EditorView (and null on teardown) for jump-to. */
  onView?: (view: EditorView | null) => void;
  /**
   * Optional handler invoked when a comment gutter marker is clicked (Comments
   * Phase A, Layer 2): `(threadId, anchorRect)`. Wired to open the thread card.
   */
  onOpenThread?: OpenThreadHandler;
  /**
   * OPTIONAL cursor-position callback (#11.3 forward sync). Fires on selection
   * moves with the head's 1-based-line / 0-based-column position. Default
   * undefined → no behavior change. (Lane F wires this to Preview.)
   */
  onCursorChange?: (pos: SourceLineCol) => void;
  /** Optional `@`-completion sources (labels/cites, #13/#6). Default-off. */
  completionSources?: CompletionSource[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  const onCursorChangeRef = useRef(onCursorChange);
  onCursorChangeRef.current = onCursorChange;
  // Keep the latest open-thread handler reachable from the (mount-time) extension.
  const onOpenThreadRef = useRef(onOpenThread);
  onOpenThreadRef.current = onOpenThread;

  useEffect(() => {
    if (!host.current) return;
    const ytext = doc.source;
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
          attributionDecorations(doc),
          commentDecorations(doc, SINGLE_FILE_ID, {
            onOpenThread: (threadId, rect) => onOpenThreadRef.current?.(threadId, rect),
          }),
          diagnosticsExtension(),
          searchPanelExtension(),
          editorPrefsExtensions(loadPrefs()),
          ...(completionSources && completionSources.length > 0
            ? [autocompletion({ override: completionSources })]
            : []),
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
  }, [doc, awareness]);

  // Push diagnostics into the existing view (no remount). Undefined → cleared.
  useEffect(() => {
    if (viewRef.current) setDiagnostics(viewRef.current, diagnostics);
  }, [diagnostics]);

  return <div ref={host} className="editor" data-testid="editor" />;
}
