/**
 * Normalize the compiled preview SVG to render at TRUE physical size.
 *
 * typst.ts emits the page `<svg>` with UNITLESS width/height equal to the page
 * size in Typst points, e.g. `width="420" height="596"` for A5 (viewBox in the
 * same point units). The browser reads a unitless SVG length as CSS pixels, so a
 * 420 pt-wide A5 page renders at 420 px — 75% of its physical size on a 96 dpi
 * screen (1 pt should be 96/72 px). At the preview's "100% / actual size" zoom
 * that makes the page (and its text) a quarter smaller than it should be — the
 * reported "text is super small to read".
 *
 * This rewrites ONLY the root `<svg>` tag's `width`/`height` from points to CSS
 * pixels (× 96/72), so "actual size" means physical size. The `viewBox` (point
 * coordinates) is LEFT UNTOUCHED — the page content scales up to fill the larger
 * box, and every downstream consumer that reads the viewBox (the source-map
 * click mapping, the fit-to-width intrinsic-width calc, which already converts
 * `viewBox × 96/72`) stays consistent. `data-width`/`data-height` are preserved.
 *
 * Pure string transform (no DOM), so it runs before injection and is unit
 * tested. A no-op for SVGs without a unitless root width/height (returns the
 * input unchanged), so it is safe on any unexpected shape.
 */

/**
 * Typst point → physical CSS pixel factor (96 dpi screen, 72 pt/in). The root
 * `<svg>` width/height is rewritten by this below, so the rendered page occupies
 * `point × PT_TO_CSS_PX` CSS px while its viewBox stays in points. Exported so the
 * forward-sync overlay/scroll (which position point-space rects over that rendered
 * page) can convert into the SAME physical-px space — see preview-source-geometry.ts.
 */
export const PT_TO_CSS_PX = 96 / 72;

/** Rewrite a `name="<number>"` attribute inside `tag` to its pt→px value. */
function scaleUnitlessAttr(tag: string, name: string): string {
  // Match ` width="420.000"` — a leading space (so `data-width` / `data-height`,
  // preceded by `-`, never match) and a purely numeric (unitless) value.
  const re = new RegExp(`(\\s${name}=")(\\d+(?:\\.\\d+)?)(")`);
  return tag.replace(re, (_m, pre: string, num: string, post: string) => {
    const px = Number(num) * PT_TO_CSS_PX;
    if (!Number.isFinite(px) || px <= 0) return `${pre}${num}${post}`;
    // Trim to a sensible precision; emit explicit `px` so intent is unambiguous.
    return `${pre}${Number(px.toFixed(3))}px${post}`;
  });
}

/**
 * Return `svg` with the root `<svg>` element's unitless point width/height
 * rewritten to physical CSS pixels. Only the first `<svg …>` open tag is
 * touched; everything else is byte-for-byte unchanged.
 */
export function scaleSvgToPhysicalPx(svg: string): string {
  const open = svg.indexOf("<svg");
  if (open < 0) return svg;
  const end = svg.indexOf(">", open);
  if (end < 0) return svg;
  const head = svg.slice(open, end); // the `<svg …` open tag, sans `>`
  const scaled = scaleUnitlessAttr(scaleUnitlessAttr(head, "width"), "height");
  if (scaled === head) return svg;
  return svg.slice(0, open) + scaled + svg.slice(end);
}
