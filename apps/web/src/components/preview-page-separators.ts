/**
 * Draw visible page seams in the multi-page preview (fix/preview-pagebreak).
 *
 * typst.ts renders every page of a document into ONE `<svg>`, with each page a
 * `<g class="typst-page" transform="translate(0, Y)" data-page-height="H">` group
 * stacked FLUSH (page i+1 starts exactly where page i ends). The preview paints a
 * single paper background + one drop shadow around that whole stack, so a
 * `#pagebreak` is invisible — the sheets read as one unbroken strip ("cannot see
 * the pagebreak in the pdf preview").
 *
 * Rather than split the combined SVG into per-page DOM elements (which would move
 * the source-map's document-space coordinates out from under the inverse/forward
 * preview-sync that depends on the single combined viewBox), we keep the one SVG
 * and INJECT a seam at each internal page boundary, drawn in the SVG's own point
 * coordinates so it scales exactly with zoom/fit. Each seam is a recessed gutter
 * band sitting in the page-margin whitespace that straddles the boundary, with a
 * soft shadow under the upper sheet's edge and hairlines on both sheet edges — so
 * the stack reads as separate sheets with a gap between them.
 *
 * PURE string transform, fail-soft: an unparseable or single-page SVG is returned
 * byte-for-byte unchanged (single-page previews are therefore untouched).
 */

/** Half-height of the recessed gutter band, in Typst points. */
const GUTTER_HALF_PT = 11;

/** Read the first `<svg …>` open tag's `viewBox` width/height (point units). */
function readViewBox(svg: string): { w: number; h: number } | null {
  const open = svg.indexOf("<svg");
  if (open < 0) return null;
  const end = svg.indexOf(">", open);
  if (end < 0) return null;
  const m = /viewBox="([\d.\s-]+)"/.exec(svg.slice(open, end));
  if (!m) return null;
  const parts = m[1]!.trim().split(/[\s,]+/).map(Number);
  if (parts.length < 4 || !parts.every(Number.isFinite)) return null;
  const w = parts[2]!;
  const h = parts[3]!;
  return w > 0 && h > 0 ? { w, h } : null;
}

/**
 * Collect the document-space y of every INTERNAL page boundary (the top edge of
 * pages 2..n) by reading each `typst-page` group's `translate(0, Y)`. Flush
 * stacking means a page's top Y is also the previous page's bottom edge — the
 * seam. Returns an ascending list; `[]` for a single page or an unparseable tree.
 */
function pageBoundaries(svg: string): number[] {
  const tops: number[] = [];
  const re = /<g\b[^>]*class="typst-page"[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) {
    const tm = /transform="[^"]*translate\(\s*[-\d.]+\s*,\s*([-\d.]+)\s*\)/.exec(m[0]);
    if (!tm) continue;
    const y = Number(tm[1]);
    if (Number.isFinite(y)) tops.push(y);
  }
  // Drop the first page's top (y≈0 — the document start is not a seam) and any
  // non-positive entries; keep the strictly-internal boundaries, sorted.
  const seams = tops.filter((y) => y > GUTTER_HALF_PT).sort((a, b) => a - b);
  return seams;
}

/**
 * Return `svg` with a seam drawn at each internal page boundary. No-op (returns
 * the input) when the SVG has fewer than two pages or can't be parsed.
 */
export function insertPageSeparators(svg: string): string {
  if (typeof svg !== "string" || svg.length === 0) return svg;
  const vb = readViewBox(svg);
  if (!vb) return svg;
  const seams = pageBoundaries(svg);
  if (seams.length === 0) return svg;

  const closeIdx = svg.lastIndexOf("</svg>");
  if (closeIdx < 0) return svg;

  const W = vb.w;
  const G = GUTTER_HALF_PT;
  // `pointer-events="none"` so the decorative seams never intercept an inverse-
  // sync click that lands on a boundary — the click passes through to the page.
  const rects = seams
    .map((y) => {
      const top = y - G;
      const h = G * 2;
      return (
        // recessed gutter (the "desk" showing between two sheets)
        `<rect x="0" y="${top}" width="${W}" height="${h}" fill="var(--preview-gutter, #e9e6df)"/>` +
        // soft shadow cast by the upper sheet onto the gutter
        `<rect x="0" y="${top}" width="${W}" height="6" fill="#000" opacity="0.07"/>` +
        // crisp sheet edges: bottom of upper sheet, top of lower sheet
        `<rect x="0" y="${top}" width="${W}" height="0.75" fill="#000" opacity="0.14"/>` +
        `<rect x="0" y="${y + G}" width="${W}" height="0.75" fill="#000" opacity="0.06"/>`
      );
    })
    .join("");

  return svg.slice(0, closeIdx) + `<g pointer-events="none">${rects}</g>` + svg.slice(closeIdx);
}
