/**
 * Sanitize compiled-preview SVG before it is injected via
 * `dangerouslySetInnerHTML` (SEC·medium: Preview SVG XSS).
 *
 * The SVG is our own typst render, but a *document* is attacker-controlled: a
 * shared/imported doc can steer the renderer into emitting markup we never
 * intended — most realistically a `#link("javascript:…")` that typst exports as
 * an `<a xlink:href>`, or hostile content smuggled through the `<foreignObject>`
 * that typst.ts wraps every text run in. Injected raw, that is stored XSS. The
 * web-server sends a strict CSP (`DEFAULT_CSP`) that blocks it, but a plain
 * static host (vite preview / S3 / GitHub Pages) sends no CSP — so the bytes
 * must be safe on their own. We sanitize here and ALSO ship a baseline `<meta>`
 * CSP in `index.html`; either alone closes the hole, together they are
 * defense-in-depth.
 *
 * DOMPurify config notes:
 *   - `svg` + `svgFilters` profiles keep the SVG vocabulary (paths, gradients,
 *     filter primitives, `<use>` glyph refs).
 *   - `html` profile + `ADD_TAGS: ["foreignObject"]`: typst.ts 0.7 renders EVERY
 *     visible text run as `<g class="typst-text">…<foreignObject>…<div>text</div>`.
 *     Stripping `foreignObject` (DOMPurify's svg-profile default) would erase all
 *     text from the preview, so we keep it and let DOMPurify sanitize the XHTML
 *     inside — `<script>`, `<iframe>`/`<object>`/`<embed>`, `on*` handlers and
 *     `javascript:` URIs are NOT in any allowlist and are removed regardless of
 *     profile.
 *   - `data:` URIs survive on `<image>`/`<img>` (DOMPurify's built-in
 *     `DATA_URI_TAGS`) so binary-asset images (#7, embedded as `data:image/...`)
 *     keep rendering.
 *
 * The full structure typst emits (classes, `transform`, `viewBox`, the
 * `foreignObject` x/y/width/height extents) is preserved, so the source-map's
 * live-DOM bbox measurement in `Preview.tsx` reads the same geometry as before.
 *
 * Verified by the Docker e2e gate: `preview.spec.ts` proves foreignObject text
 * still renders and `binary-import.spec.ts` proves a `data:` image still renders
 * through the sanitizer (the regression net against over-stripping).
 */
import DOMPurify from "dompurify";

export function sanitizeCompiledSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    // `foreignObject`: typst.ts wraps every text run's selectable text in one.
    // `use`: typst.ts paints VISIBLE glyphs by instancing `<defs>` outlines via
    // `<use href="#glyphId">` (10k+ per page). DOMPurify's profiles don't admit
    // `use` by default, so without this it stripped EVERY `<use>` — the glyph
    // outlines stayed orphaned in `<defs>` and nothing painted (only the faint
    // foreignObject overlay showed), while PDF export looked fine. The href stays
    // scrubbed by DOMPurify's URI allowlist, so only same-document `#fragment`
    // glyph refs survive — external / `javascript:` / `data:` `use` refs are
    // still removed, so this widens nothing security-relevant.
    ADD_TAGS: ["foreignObject", "use"],
    // typst.ts never emits SMIL animation; DOMPurify already neutralizes the
    // classic `<animate attributeName="href" to="javascript:…">` vector, but
    // forbidding the whole family removes the surface entirely at zero cost to
    // legitimate output (belt-and-suspenders).
    FORBID_TAGS: ["animate", "animateTransform", "animateMotion", "set", "mpath", "discard"],
  });
}
