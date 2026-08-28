/**
 * The text shown in the preview pane when there is no rendered page yet (`svg`
 * is null). Historically this was a flat `ready ? "Compiling…" : "Loading
 * compiler…"`, which LIED whenever the very first compile finished with errors:
 * the compile had run and FAILED, but the pane sat on "Compiling…" forever, so it
 * read as a hang ("server connected but not compiling"). This makes the placeholder
 * tell the truth — once the compiler is ready and the latest compile produced error
 * diagnostics with no page, it points the writer at the diagnostics list instead of
 * pretending to still be working.
 *
 * Pure so both shells (App.tsx single-file, ProjectApp project) share one wording
 * and it stays unit-tested. Note this only governs the EMPTY pane: once a compile
 * has ever succeeded, `svg` holds the last good page and the placeholder is unused.
 *
 * M10: the flat "Compiling…" fallback was misleading — it sat on "Compiling…"
 * FOREVER for a document that compiled cleanly to ZERO pages (an empty doc, svg
 * null, no errors), pretending to still be working. It now pairs with H1's `busy`
 * flag + `pageCount`: it says "Compiling…" only while a compile is genuinely in
 * flight (or the very first one hasn't resolved — so a fast first compile never
 * flickers), and once a compile RESOLVES with no page it tells the honest truth.
 */
export interface PreviewPlaceholderState {
  /** Whether the compiler has finished initializing. */
  ready: boolean;
  /** Number of ERROR-severity diagnostics from the latest compile. */
  errorCount: number;
  /** H1: a recompile is in flight (past the busy threshold). */
  busy: boolean;
  /** Pages from the latest RESOLVED compile; `null` until the first resolves. */
  pageCount: number | null;
}

export function previewPlaceholder({
  ready,
  errorCount,
  busy,
  pageCount,
}: PreviewPlaceholderState): string {
  if (!ready) return "Loading compiler…";
  if (errorCount > 0) {
    return `Couldn't compile — ${errorCount} ${errorCount === 1 ? "error" : "errors"}. See the diagnostics below.`;
  }
  // A compile is in flight, or the FIRST one hasn't resolved yet (pageCount still
  // null) → honestly still working. Keeping the null case here means a fast first
  // compile shows "Compiling…" throughout rather than flashing the empty-state.
  if (busy || pageCount === null) return "Compiling…";
  // Ready, the latest compile resolved cleanly, but it produced NO page (an empty
  // document) — don't pretend to still be working; guide the writer instead.
  return "Nothing to preview yet — your typeset pages appear here as you write.";
}
