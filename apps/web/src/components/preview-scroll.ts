/**
 * H2 — the forward-sync scroll-visibility predicate.
 *
 * Forward sync (#11.3) scrolls the preview to the region under the editor cursor.
 * The VERTICAL axis used to recenter on EVERY cursor move — even a plain click on
 * a line already on screen — smooth-scrolling the page out from under the reader.
 * The HORIZONTAL axis already guarded on viewport bounds (only nudging when the
 * region sat outside the view); this mirrors that guard onto the vertical axis.
 *
 * Pure + Node-unit-tested; the React effect in Preview.tsx feeds it live geometry
 * and only calls `scrollTo` when this returns a target.
 */
export interface PreviewScrollAxis {
  /** The region's start offset in the scroll container's content coordinates. */
  regionStart: number;
  /** The region's length (height for vertical, width for horizontal). */
  regionLength: number;
  /** The container's current scroll offset on this axis (scrollTop/scrollLeft). */
  viewStart: number;
  /** The viewport length on this axis (clientHeight/clientWidth). */
  viewLength: number;
}

/**
 * PURE: the scroll target that brings `region` into view, or `null` when the
 * region's start already sits within the viewport (so the reader is NOT yanked).
 *
 * Mirrors Preview.tsx's horizontal guard: scroll only when the region START is
 * outside the visible band; when it IS off-screen, center the region (the prior
 * centering formula, now gated) and clamp to ≥0.
 */
export function previewScrollTarget(axis: PreviewScrollAxis): number | null {
  const { regionStart, regionLength, viewStart, viewLength } = axis;
  if (regionStart >= viewStart && regionStart <= viewStart + viewLength) return null;
  return Math.max(0, regionStart - viewLength / 2 + regionLength / 2);
}
