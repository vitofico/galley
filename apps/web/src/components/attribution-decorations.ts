/**
 * A CodeMirror 6 extension that paints each span of the document in its author's
 * color, driven by the `@galley/collab` attribution core (ADR-0012). Spans are
 * derived from the shared `Y.Text`'s item clientIDs, so colors are consistent
 * across peers. The painting policy (only show it once ≥2 authors are present, so
 * solo writing stays clean) lives in the shared `attribution-paint.ts`.
 *
 * Reentrancy care: a Y.Text change reaches the editor *through* yCollab's own
 * `view.dispatch`, and Yjs observers fire synchronously inside it — so we must NOT
 * dispatch from within that. Text-change refreshes are therefore taken from CM's
 * own `update()` cycle; only author-MAP changes (a registration arriving) need an
 * out-of-band refresh, which we defer to a microtask so it never lands inside an
 * in-progress update.
 */
import { type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type Extension } from "@codemirror/state";
import { attributedRanges, observeAuthors, type CollabDocument } from "@galley/collab";
import { buildAttributionDecorations } from "./attribution-paint.js";

function build(doc: CollabDocument, docLength: number): DecorationSet {
  return buildAttributionDecorations(attributedRanges(doc), docLength);
}

export function attributionDecorations(doc: CollabDocument): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private readonly off: () => void;
      private scheduled = false;
      private destroyed = false;

      constructor(private readonly view: EditorView) {
        this.decorations = build(doc, view.state.doc.length);
        // Only the author map (registrations) needs an out-of-band refresh; text
        // edits are handled by update() below.
        this.off = observeAuthors(doc, () => this.scheduleRefresh());
      }

      private scheduleRefresh(): void {
        if (this.scheduled || this.destroyed) return;
        this.scheduled = true;
        queueMicrotask(() => {
          this.scheduled = false;
          if (this.destroyed) return;
          this.decorations = build(doc, this.view.state.doc.length);
          this.view.dispatch({}); // safe: runs after any in-progress update unwinds
        });
      }

      update(update: ViewUpdate): void {
        if (update.docChanged) this.decorations = build(doc, update.state.doc.length);
      }

      destroy(): void {
        this.destroyed = true;
        this.off();
      }
    },
    { decorations: (v) => v.decorations },
  );
}
