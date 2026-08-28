/**
 * L4: when a previously-good document is edited into a compile ERROR, the
 * compiler keeps the last good page on screen (`useCompiler` only calls `setSvg`
 * on `res.ok`, so a failed compile leaves the prior preview untouched). The
 * preview then looks clean and current while the only error signal lives in the
 * status chip / the diagnostics list below the fold — the reader can mistake a
 * STALE render for the live one.
 *
 * This derives the text of a subtle edge banner shown ON the preview itself
 * ("Showing last good render · N errors") so the staleness is visible exactly
 * where the reader is looking. Pure (no DOM, no React) so it stays unit-tested
 * and both the predicate and its wording are pinned offline.
 *
 * Errors ONLY: a doc that compiles WITH warnings still produces a fresh page
 * (`res.ok` true → `setSvg` ran), so it is NOT stale — keying on error count
 * (the diagnostics that actually fail the compile) avoids a false "stale" banner
 * on a clean-but-warned render. Returns `null` when there is no rendered page to
 * be stale (`hasRender` false) or no errors, so the default preview is unchanged.
 */
export interface StaleRenderNoticeState {
  /** Whether a rendered page is currently shown (`svg !== null`). */
  hasRender: boolean;
  /** ERROR-severity diagnostics from the latest compile. */
  errorCount: number;
}

export function staleRenderNotice({
  hasRender,
  errorCount,
}: StaleRenderNoticeState): string | null {
  if (!hasRender || errorCount <= 0) return null;
  return `Showing last good render · ${errorCount} ${errorCount === 1 ? "error" : "errors"}`;
}
