import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import {
  autocompletion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import type { Diagnostic, SourceLineCol } from "@galley/shared";
import type { EditorState as CMEditorState } from "@codemirror/state";
import { typstLanguage, typstHighlightStyle } from "../typst-highlight.js";
import {
  diagnosticsExtension,
  setDiagnostics,
} from "./diagnostics-extension.js";
import { searchPanelExtension } from "./search-extension.js";
import { editorPrefsExtensions, loadPrefs } from "../editor-prefs.js";

/**
 * CodeMirror 6 editor. Uncontrolled (initialised once); user keystrokes are
 * pushed up via `onChange`. The app owns the live source — this is the input.
 *
 * `diagnostics` is OPTIONAL and default-off: when omitted (every current
 * caller), the diagnostics extension stays empty and the editor renders exactly
 * as before. When supplied, squiggles + gutter markers are dispatched into the
 * live view without remounting.
 */
/**
 * Map a CodeMirror state to a 1-based-line / 0-based-column cursor position (the
 * coordinate space the preview source map speaks). Reads the main selection head.
 */
export function cursorPosFromState(state: CMEditorState): SourceLineCol {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return { line: line.number, column: head - line.from };
}

export function Editor({
  initialDoc,
  onChange,
  diagnostics,
  onView,
  onCursorChange,
  completionSources,
}: {
  initialDoc: string;
  onChange: (doc: string) => void;
  diagnostics?: Diagnostic[];
  /** Optional: receive the live EditorView (and null on teardown) for jump-to. */
  onView?: (view: EditorView | null) => void;
  /**
   * OPTIONAL cursor-position callback (#11.3 forward sync). Fires on every
   * selection move with the head's 1-based-line / 0-based-column position.
   * Default undefined → the listener is a no-op and behavior is unchanged.
   * (Lane F wires this to `Preview.activeSourcePos`.)
   */
  onCursorChange?: (pos: SourceLineCol) => void;
  /** Optional `@`-completion sources (labels/cites, #13/#6). Default-off. */
  completionSources?: CompletionSource[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  const onCursorChangeRef = useRef(onCursorChange);
  onCursorChangeRef.current = onCursorChange;

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          basicSetup,
          typstLanguage,
          typstHighlightStyle,
          diagnosticsExtension(),
          searchPanelExtension(),
          editorPrefsExtensions(loadPrefs()),
          ...(completionSources && completionSources.length > 0
            ? [autocompletion({ override: completionSources })]
            : []),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
            // Emit cursor moves only when a consumer opted in (#11.3). Fires on
            // selection OR doc changes (a doc change also moves the head).
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
    };
    // Initialise once per mount; external doc replacements (Accept) remount this
    // component via a `key`, re-reading `initialDoc`. Normal typing flows through
    // CodeMirror itself and back out via `onChange`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push diagnostics into the existing view (no remount). Undefined → cleared.
  useEffect(() => {
    if (viewRef.current) setDiagnostics(viewRef.current, diagnostics);
  }, [diagnostics]);

  return <div ref={host} className="editor" data-testid="editor" />;
}
