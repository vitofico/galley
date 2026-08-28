/**
 * The project sibling of `attribution-decorations.ts`: a CodeMirror 6 extension
 * that paints each span of ONE project file in its author's color (roadmap #14-C,
 * closing the ProjectEditor follow-up). Spans come from the `@galley/collab`
 * attribution core (ADR-0012), but partitioned per-`Y.Text` via
 * `textAttributedRanges(project, ytext)` — the authors map is doc-global across
 * all files in the one `Y.Doc`, so colors stay consistent across files and peers.
 * The painting policy (only show it once ≥2 authors are present, so solo writing
 * stays clean) lives in the shared `attribution-paint.ts`.
 *
 * Reentrancy care is identical to the single-file extension: a Y.Text change
 * reaches the editor THROUGH yCollab's own `view.dispatch` (Yjs observers fire
 * synchronously inside it), so text-change refreshes are taken from CM's own
 * `update()` cycle; only author-MAP changes (a registration arriving over the
 * wire) need an out-of-band, microtask-deferred refresh.
 */
import { type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type Extension } from "@codemirror/state";
import { observeAuthors, textAttributedRanges, type CollabProject } from "@galley/collab";
import type * as Y from "yjs";
import { buildAttributionDecorations } from "./attribution-paint.js";

function build(project: CollabProject, ytext: Y.Text, docLength: number): DecorationSet {
  return buildAttributionDecorations(textAttributedRanges(project, ytext), docLength);
}

export function projectAttributionDecorations(project: CollabProject, ytext: Y.Text): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private readonly off: () => void;
      private scheduled = false;
      private destroyed = false;

      constructor(private readonly view: EditorView) {
        this.decorations = build(project, ytext, view.state.doc.length);
        // Only the author map (registrations) needs an out-of-band refresh; text
        // edits are handled by update() below.
        this.off = observeAuthors(project, () => this.scheduleRefresh());
      }

      private scheduleRefresh(): void {
        if (this.scheduled || this.destroyed) return;
        this.scheduled = true;
        queueMicrotask(() => {
          this.scheduled = false;
          if (this.destroyed) return;
          this.decorations = build(project, ytext, this.view.state.doc.length);
          this.view.dispatch({}); // safe: runs after any in-progress update unwinds
        });
      }

      update(update: ViewUpdate): void {
        if (update.docChanged) this.decorations = build(project, ytext, update.state.doc.length);
      }

      destroy(): void {
        this.destroyed = true;
        this.off();
      }
    },
    { decorations: (v) => v.decorations },
  );
}
