/**
 * Live preview pane. Renders the SVG produced by the compiler. The SVG is
 * compiler output (our own typst render), injected as markup.
 *
 * The zoom controls live in a floating bottom-center `ZoomPill` (#19.3) that
 * auto-fades when idle; it sits OUTSIDE the scroll container (in the
 * `.preview-host` wrapper) so it floats over the page regardless of scroll.
 * Zoom is applied as a CSS transform on `.preview-page` and persisted to
 * localStorage. At the default 100% the page carries no transform, so the
 * rendered DOM/visual is byte-for-byte identical to the un-zoomed pane — the
 * e2e suite depends on this and on the data-testid / class hooks below.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PreviewSourceMap, SourceLineCol } from "@galley/shared";
import { lookupPreviewRegion } from "@galley/compiler";
// Inverse sync (#11.3): preview pixel point -> source line/col (click-to-jump).
import { lookupSourceAtPoint } from "@galley/compiler";
import {
  ZOOM_DEFAULT,
  ZOOM_MIN,
  ZOOM_MAX,
  clampZoom,
  zoomIn,
  zoomOut,
  isActualSize,
  readStoredZoom,
  writeStoredZoom,
} from "./preview-zoom.js";
import "./preview-zoom.css";
import "./preview-source-map.css";
import { ZoomPill } from "./ZoomPill.js";
import { sanitizeCompiledSvg } from "./sanitize-svg.js";
import { scaleSvgToPhysicalPx } from "./preview-svg-size.js";
import { insertPageSeparators } from "./preview-page-separators.js";
import { previewScrollTarget } from "./preview-scroll.js";

export function Preview({
  svg,
  placeholder,
  staleNotice,
  sourceMap,
  activeSourcePos,
  activeFilePath,
  onSourceClick,
}: {
  svg: string | null;
  placeholder: string;
  /**
   * OPTIONAL L4 edge-banner text. When a rendered page is shown but the latest
   * compile failed, the preview keeps the last GOOD render — this surfaces that
   * staleness on the preview itself. `null`/absent → no banner is rendered, so
   * the default DOM (the byte-for-byte contract above) is unchanged.
   */
  staleNotice?: string | null;
  /**
   * OPTIONAL forward source→preview index (#11.3). When supplied together with
   * `activeSourcePos`, the preview scrolls to + highlights the mapped region.
   * Supplied by both shells on the local-worker route; absent (remote/package
   * routes) → the preview behaves exactly as before.
   */
  sourceMap?: PreviewSourceMap;
  /** OPTIONAL editor cursor position (1-based line, 0-based column). */
  activeSourcePos?: SourceLineCol;
  /**
   * OPTIONAL path of the file the cursor (`activeSourcePos`) belongs to (B14).
   * For a multi-file source map (whose entries carry `filePath`), FORWARD sync
   * must only match the cursor against entries from THIS file — otherwise a
   * same-line range in a sibling file could win the lookup. When provided, the
   * forward-sync region lookup is scoped to entries tagged with this path (plus
   * any untagged entries, for backward compat). Absent, or a single-file map (no
   * `filePath` on entries) → no filtering, exactly the prior behavior.
   */
  activeFilePath?: string;
  /**
   * OPTIONAL inverse sync (#11.3): a click in the preview reports the source
   * position under the cursor. Wired ONLY when BOTH this and `sourceMap` are
   * present; absent → no listener is attached and the rendered DOM is
   * byte-for-byte unchanged.
   *
   * B14: `pos` may carry an optional `filePath` (present only for multi-file
   * source maps) identifying the file the clicked content originated from, so the
   * handler can switch to that file before jumping. Absent → the active file is
   * implied (the prior single-file behavior).
   */
  onSourceClick?: (pos: SourceLineCol & { filePath?: string }) => void;
}) {
  const previewRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  // Wraps the rendered <svg> on the forward-sync path and shrink-wraps it tightly
  // (`width: fit-content; max-width: 100%`). The highlight overlay lives INSIDE
  // this frame and is sized as a FRACTION of it, so the overlay tracks the SVG's
  // actual on-screen size — including the `max-width` shrink that bites when the
  // preview pane is narrower than the page's intrinsic width (e.g. agent pane open).
  const frameRef = useRef<HTMLDivElement>(null);
  // Sanitize the compiled SVG before it is injected as markup (SEC·medium:
  // Preview SVG XSS). Memoized so it only re-runs when the SVG actually changes,
  // not on every zoom/scroll re-render. Structure is preserved, so the live-DOM
  // bbox measurements below read the same geometry. `svg` itself still gates
  // presence (an all-stripped SVG should still show the pane, not the empty
  // placeholder); the sanitized bytes are what we inject.
  // Sanitize, then normalize the root to physical CSS px so "actual size" (the
  // 100% zoom) renders at true size rather than 75% (typst.ts emits unitless
  // point dimensions the browser treats as px — see preview-svg-size.ts).
  // Sanitize (untrusted typst markup) → inject trusted multi-page seams →
  // physical-size the root. Seams are added AFTER sanitize so our own trusted
  // rects/`var()` fills aren't stripped, and in the SAME viewBox point space the
  // root keeps (physical-sizing rewrites only width/height), so they align under
  // any zoom. Single-page SVGs pass through `insertPageSeparators` untouched.
  const safeSvg = useMemo(
    () =>
      svg
        ? scaleSvgToPhysicalPx(insertPageSeparators(sanitizeCompiledSvg(svg)))
        : null,
    [svg],
  );
  // Document point-space size, read from the injected SVG's viewBox (Typst points
  // — see preview-page-separators.ts: one combined SVG, one viewBox covering the
  // whole stacked document). The forward-sync overlay and scroll target express
  // their point-space rects as a FRACTION of this, so they scale with the rendered
  // SVG under any pane width / zoom. The viewBox is fixed per compile (independent
  // of pane width), so this only recomputes when the SVG changes — no staleness.
  const docSize = useMemo(() => {
    if (!safeSvg) return null;
    const open = safeSvg.indexOf("<svg");
    if (open < 0) return null;
    const end = safeSvg.indexOf(">", open);
    if (end < 0) return null;
    const m = /viewBox="([\d.\s-]+)"/.exec(safeSvg.slice(open, end));
    if (!m) return null;
    const parts = m[1]!.trim().split(/[\s,]+/).map(Number);
    if (parts.length < 4 || !parts.every(Number.isFinite)) return null;
    const w = parts[2]!;
    const h = parts[3]!;
    return w > 0 && h > 0 ? { w, h } : null;
  }, [safeSvg]);

  // Initialize from storage on mount (lazy initializer = restored once).
  const [zoom, setZoom] = useState<number>(() => readStoredZoom());
  // Live mirror of the zoom for the resize observer (B16): it must read the
  // CURRENT level without re-subscribing the observer on every zoom change.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // Persist whenever the level changes.
  useEffect(() => {
    writeStoredZoom(zoom);
  }, [zoom]);

  // Fit-width: scale so the rendered page fills the available container width.
  // Memoized so the resize-driven auto-fit effect (B16) can depend on a stable
  // reference; `zoom` is read live so the layout-width back-out uses the current
  // transform scale.
  const fitWidth = useCallback(() => {
    const container = previewRef.current;
    const page = pageRef.current;
    if (!container || !page) return;
    // Available content width (minus horizontal padding) of the scroll area.
    const cs = getComputedStyle(container);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const avail = container.clientWidth - padX;
    // We need the document's INTRINSIC width — the width it WANTS to render at,
    // independent of the pane. The rendered <svg> carries `max-width: 100%`, so
    // its on-screen (and layout) width is clamped to the pane whenever the page
    // is wider than it; measuring that would always yield ~avail, making Fit a
    // permanent no-op at 100% and unable to scale DOWN a too-wide page. Read the
    // intrinsic width from the SVG's viewBox instead (Typst user-space units are
    // points; convert pt→CSS px at 96/72). Fall back to the un-zoomed layout
    // width — and finally the page box — only when no viewBox is available.
    const svgEl = page.querySelector("svg");
    const vbW = svgEl?.viewBox?.baseVal?.width ?? 0;
    const intrinsicFromViewBox = vbW > 0 ? vbW * (96 / 72) : 0;
    const currentScale = isActualSize(zoom) ? 1 : zoom / 100;
    const svgLayoutW = svgEl ? svgEl.getBoundingClientRect().width / currentScale : 0;
    const natural =
      intrinsicFromViewBox > 0
        ? intrinsicFromViewBox
        : svgLayoutW > 0
          ? svgLayoutW
          : page.offsetWidth || avail;
    if (natural <= 0 || avail <= 0) return;
    setZoom(clampZoom((avail / natural) * 100));
  }, [zoom]);

  const atActual = isActualSize(zoom);
  const scale = zoom / 100;

  // #11.3 forward sync: resolve the active cursor to a rendered region. Pure +
  // memoized; yields `undefined` (no highlight, no scroll) unless BOTH the index
  // and a cursor position are supplied, so the default path does no extra work.
  //
  // B14: for a multi-file source map (entries carry `filePath`), scope the lookup
  // to the ACTIVE file's entries so the cursor can't match a same-line range in a
  // sibling file. Untagged entries are always kept (single-file maps + backward
  // compat). When nothing is tagged, or no active path is known, the map is used
  // as-is — byte-for-byte the prior behavior.
  const region = useMemo(() => {
    if (!sourceMap || !activeSourcePos) return undefined;
    const scoped =
      activeFilePath && sourceMap.entries.some((e) => e.filePath !== undefined)
        ? {
            ...sourceMap,
            entries: sourceMap.entries.filter(
              (e) => e.filePath === undefined || e.filePath === activeFilePath,
            ),
          }
        : sourceMap;
    return lookupPreviewRegion(scoped, activeSourcePos);
  }, [sourceMap, activeSourcePos, activeFilePath]);

  // Scroll the highlighted region into view when it changes. The region rect is in
  // Typst POINTS; rather than reconstruct its on-screen position from points (which
  // must track the SVG's `max-width` shrink AND the zoom transform), read the live
  // rendered geometry of the SVG frame and map the rect into it as a fraction of
  // the viewBox. `getBoundingClientRect` already folds in the shrink, the zoom
  // transform, and the page offset, so the target stays consistent with the overlay
  // at any pane width. Best-effort: bails if refs/region/docSize are absent, never
  // disturbs scrolling when forward-sync is off.
  useEffect(() => {
    if (!region || !docSize) return;
    const container = previewRef.current;
    const frame = frameRef.current;
    if (!container || !frame) return;
    const cRect = container.getBoundingClientRect();
    const fRect = frame.getBoundingClientRect();
    // On-screen y of the region's top, expressed in the container's scroll space.
    const regionTop =
      fRect.top - cRect.top + container.scrollTop +
      (region.rect.y / docSize.h) * fRect.height;
    const regionLen = (region.rect.height / docSize.h) * fRect.height;
    // H2: vertical scroll is GATED on viewport bounds — recenter only when the
    // region's top sits OUTSIDE the current view, so a cursor move within an
    // already-visible region no longer yanks the page (mirrors the horizontal guard).
    const top = previewScrollTarget({
      regionStart: regionTop,
      regionLength: regionLen,
      viewStart: container.scrollTop,
      viewLength: container.clientHeight,
    });
    if (top !== null) container.scrollTo({ top, behavior: "smooth" });
    // Horizontal nudge only if the region sits outside the current view.
    const regionLeft =
      fRect.left - cRect.left + container.scrollLeft +
      (region.rect.x / docSize.w) * fRect.width;
    const viewLeft = container.scrollLeft;
    const viewRight = viewLeft + container.clientWidth;
    if (regionLeft < viewLeft || regionLeft > viewRight) {
      container.scrollTo({
        left: Math.max(0, regionLeft - 24),
        behavior: "smooth",
      });
    }
  }, [region, docSize]);

  // B16 — auto re-fit on pane resize. The "Fit" button computes a zoom from the
  // container width; when the splitter resizes the preview pane (SplitPanes only
  // mutates CSS custom properties — no React re-render and no resize event on the
  // pane itself), that fitted zoom goes stale. A ResizeObserver watches the scroll
  // container and recomputes the fit when its width changes.
  //
  // Smart gate (respects user intent): auto-refit only when the user is NOT at
  // actual size (100%). A deliberate "Actual size" / 100% reading is left alone;
  // every other level (including a prior Fit result, or a manual zoom) tracks the
  // pane width so the page keeps filling it. Re-armed whenever the SVG changes so
  // the observer always points at the live page. Fully additive: the manual Fit
  // button is unchanged, and with no SVG (placeholder) the effect is a no-op.
  const fitWidthRef = useRef(fitWidth);
  fitWidthRef.current = fitWidth;
  useEffect(() => {
    const container = previewRef.current;
    if (!svg || !container || typeof ResizeObserver === "undefined") return;
    let lastWidth = container.clientWidth;
    // ResizeObserver fires once on observe() with the current size. SKIP that
    // first delivery unconditionally so mounting NEVER overrides the persisted /
    // user-set zoom — only a genuine LATER width change triggers an auto re-fit.
    let primed = false;
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth;
      if (!primed) {
        primed = true;
        lastWidth = w;
        return;
      }
      // Only react to genuine WIDTH changes (height-only changes don't affect the
      // fit). The 1px guard avoids sub-pixel thrash during a drag.
      if (Math.abs(w - lastWidth) < 1) return;
      lastWidth = w;
      // Respect a deliberate actual-size reading; re-fit any other level.
      if (isActualSize(zoomRef.current)) return;
      fitWidthRef.current();
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [svg]);

  // #11.3 inverse sync: a click in the preview reports the source position under
  // the cursor. Active ONLY when BOTH the index and the callback are supplied.
  //
  // We map the DOM click to the page's document (SVG user-space) coordinates by
  // measuring the rendered <svg>'s live bounding rect and reading its viewBox.
  // `getBoundingClientRect()` already reflects the applied zoom CSS transform
  // (scale + `transform-origin: top center`) and the page's layout offset, so the
  // fraction-of-rect → fraction-of-viewBox mapping inverts BOTH the zoom and the
  // offset without any manual matrix math — keeping it consistent with how the
  // page (and the forward-sync highlight inside it) is rendered.
  const inverseEnabled = Boolean(sourceMap && onSourceClick);
  const handlePreviewClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!sourceMap || !onSourceClick) return;
      const host = e.currentTarget;
      const svgEl = host.querySelector("svg");
      if (!svgEl) return;
      const rect = svgEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      // Document-space size of the page: the SVG viewBox (Typst points). Fall back
      // to the on-screen rect (treat 1px = 1pt) if the viewBox is unavailable.
      const vb = svgEl.viewBox?.baseVal;
      const docW = vb && vb.width > 0 ? vb.width : rect.width;
      const docH = vb && vb.height > 0 ? vb.height : rect.height;
      const vbX = vb ? vb.x : 0;
      const vbY = vb ? vb.y : 0;
      const fx = (e.clientX - rect.left) / rect.width;
      const fy = (e.clientY - rect.top) / rect.height;
      const point = { x: vbX + fx * docW, y: vbY + fy * docH };
      const pos = lookupSourceAtPoint(sourceMap, point);
      if (pos) onSourceClick(pos);
    },
    [sourceMap, onSourceClick],
  );

  // Spread onto `.preview-page` ONLY when inverse sync is enabled. When disabled
  // the object is empty, so no `onClick`/data attribute is attached and the
  // rendered DOM is byte-for-byte identical to the default preview.
  const sourceClickProps = inverseEnabled
    ? {
        onClick: handlePreviewClick,
        "data-source-clickable": "true" as const,
      }
    : {};

  // Drive the CSS custom property used by the [data-zoomed] rule. Using a layout
  // effect keeps the transform in sync before paint when the level changes.
  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    page.style.setProperty("--preview-zoom", String(scale));
  }, [scale, svg]);

  return (
    <div className="preview-host">
      {svg && staleNotice && (
        <div
          className="preview-stale-notice"
          data-testid="preview-stale-notice"
          role="status"
        >
          {staleNotice}
        </div>
      )}
      <div className="preview" data-testid="preview" ref={previewRef}>
        {svg ? (
          region ? (
            // Opt-in #11.3 path only: the SVG is injected into an inner host so the
            // React-owned highlight overlay can be a sibling (dangerouslySetInnerHTML
            // forbids JSX children on the same node). This branch runs ONLY when a
            // region is active, so the default DOM below stays byte-for-byte intact.
            <div
              className="preview-page"
              ref={pageRef}
              data-zoomed={atActual ? undefined : "true"}
              {...sourceClickProps}
            >
              {/* Frame shrink-wraps the SVG (width: fit-content; max-width: 100%)
                  so the overlay below — positioned as a FRACTION of this box — sits
                  on the content at any pane width. */}
              <div className="preview-page-frame" ref={frameRef}>
                <div
                  className="preview-svg-host"
                  dangerouslySetInnerHTML={{ __html: safeSvg ?? "" }}
                />
                {docSize && (
                  <div
                    className="preview-source-highlight"
                    data-testid="preview-source-highlight"
                    aria-hidden="true"
                    // The rect is in Typst points (viewBox space). Express it as a
                    // percentage of the document so the overlay scales EXACTLY with
                    // the rendered SVG — both the `max-width` shrink (pane narrower
                    // than the page) and the `.preview-page` zoom transform apply to
                    // the frame, and the overlay follows as a fraction of it.
                    style={{
                      left: `${(region.rect.x / docSize.w) * 100}%`,
                      top: `${(region.rect.y / docSize.h) * 100}%`,
                      width: `${(region.rect.width / docSize.w) * 100}%`,
                      height: `${(region.rect.height / docSize.h) * 100}%`,
                    }}
                  />
                )}
              </div>
            </div>
          ) : (
            <div
              className="preview-page"
              ref={pageRef}
              data-zoomed={atActual ? undefined : "true"}
              {...sourceClickProps}
              dangerouslySetInnerHTML={{ __html: safeSvg ?? "" }}
            />
          )
        ) : (
          <div className="preview-empty">{placeholder}</div>
        )}
      </div>
      {svg && (
        <ZoomPill
          zoom={zoom}
          atActual={atActual}
          canZoomOut={zoom > ZOOM_MIN}
          canZoomIn={zoom < ZOOM_MAX}
          onZoomOut={() => setZoom((z) => zoomOut(z))}
          onZoomIn={() => setZoom((z) => zoomIn(z))}
          onFit={fitWidth}
          onActualSize={() => setZoom(ZOOM_DEFAULT)}
          hostRef={previewRef}
        />
      )}
    </div>
  );
}
