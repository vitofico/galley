export interface PageAnchor {
  page: number;
  fraction: number;
}
export function pageAnchor(y: number, heights: number[]): PageAnchor | null {
  if (!heights.length || heights.some((h) => !Number.isFinite(h) || h <= 0))
    return null;
  let top = 0;
  for (let page = 0; page < heights.length; page++) {
    const height = heights[page]!;
    if (y < top + height || page === heights.length - 1)
      return { page, fraction: Math.max(0, Math.min(1, (y - top) / height)) };
    top += height;
  }
  return null;
}
export function anchorY(anchor: PageAnchor, heights: number[]): number | null {
  if (!heights.length || heights.some((h) => !Number.isFinite(h) || h <= 0))
    return null;
  const page = Math.min(anchor.page, heights.length - 1);
  return (
    heights.slice(0, page).reduce((sum, h) => sum + h, 0) +
    anchor.fraction * heights[page]!
  );
}
