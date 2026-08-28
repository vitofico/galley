/**
 * `ZoomPill` (#19.3, spec §1/§2) — the preview's zoom controls as a floating
 * bottom-center pill (− / % / + / Fit) that auto-fades when idle and
 * reappears on pointer movement or scrolling over the preview.
 *
 * Consolidation: the five-control toolbar becomes four — the % readout itself
 * is the "Actual size" reset button (it was a separate fifth button).
 *
 * Fade contract (rubric R7: floating chrome must not occlude the page):
 * - after ~1.5s without pointer/scroll activity over the preview the pill
 *   fades out AND stops intercepting pointer events (`data-idle="true"`);
 * - any pointer move / wheel / scroll over the preview wakes it;
 * - the fade is SUSPENDED while the pill has hover or focus within it, so
 *   keyboard users (Tab reaches every button) never lose the control they're
 *   on — revealed-by-hover is never hover-only.
 *
 * The wake/sleep flip writes `data-idle` straight onto the DOM node (not via
 * setState) so a pointer entering the preview re-enables hit-testing
 * SYNCHRONOUSLY — no React-batching race between the hover that wakes the
 * pill and the click that follows it.
 *
 * Testid/behavior contract preserved from the toolbar era: `preview-zoom-level`
 * shows "NNN%", buttons keep their accessible names ("Zoom out", "Zoom in",
 * "Fit width"), zoom persists, and 100% renders no transform (no data-zoomed).
 */
import { useEffect, useRef, type RefObject } from "react";
import "./preview-zoom.css";

/** Idle delay before the pill fades (ms). Exported for tests/docs. */
export const ZOOM_PILL_IDLE_MS = 1500;

export interface ZoomPillProps {
  zoom: number;
  atActual: boolean;
  canZoomOut: boolean;
  canZoomIn: boolean;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFit: () => void;
  onActualSize: () => void;
  /** The preview scroll container; its pointer/scroll activity wakes the pill. */
  hostRef: RefObject<HTMLElement | null>;
}

export function ZoomPill({
  zoom,
  atActual,
  canZoomOut,
  canZoomIn,
  onZoomOut,
  onZoomIn,
  onFit,
  onActualSize,
  hostRef,
}: ZoomPillProps) {
  const pillRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const pill = pillRef.current;
    if (!host || !pill) return;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const sleep = () => {
      // Suspend the fade while the user is ON the pill (pointer or keyboard).
      if (pill.matches(":hover") || pill.matches(":focus-within")) {
        timer = setTimeout(sleep, ZOOM_PILL_IDLE_MS);
        return;
      }
      pill.setAttribute("data-idle", "true");
    };
    const wake = () => {
      pill.removeAttribute("data-idle");
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(sleep, ZOOM_PILL_IDLE_MS);
    };

    wake();
    host.addEventListener("pointermove", wake, { passive: true });
    host.addEventListener("pointerdown", wake, { passive: true });
    host.addEventListener("wheel", wake, { passive: true });
    host.addEventListener("scroll", wake, { passive: true });
    pill.addEventListener("focusin", wake);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      host.removeEventListener("pointermove", wake);
      host.removeEventListener("pointerdown", wake);
      host.removeEventListener("wheel", wake);
      host.removeEventListener("scroll", wake);
      pill.removeEventListener("focusin", wake);
    };
  }, [hostRef]);

  return (
    <div
      className="preview-zoom-bar"
      role="toolbar"
      aria-label="Preview zoom"
      ref={pillRef}
    >
      <button
        type="button"
        className="preview-zoom-btn"
        onClick={onZoomOut}
        disabled={!canZoomOut}
        aria-label="Zoom out"
        title="Zoom out"
      >
        −
      </button>
      <button
        type="button"
        className="preview-zoom-btn preview-zoom-reset"
        onClick={onActualSize}
        disabled={atActual}
        aria-label="Zoom level — click for actual size"
        title="Actual size (100%)"
      >
        <span
          className="preview-zoom-level"
          aria-live="polite"
          data-testid="preview-zoom-level"
        >
          {Math.round(zoom)}%
        </span>
      </button>
      <button
        type="button"
        className="preview-zoom-btn"
        onClick={onZoomIn}
        disabled={!canZoomIn}
        aria-label="Zoom in"
        title="Zoom in"
      >
        +
      </button>
      <span className="preview-zoom-sep" aria-hidden="true" />
      <button
        type="button"
        className="preview-zoom-btn"
        onClick={onFit}
        aria-label="Fit width"
        title="Fit width"
      >
        Fit
      </button>
    </div>
  );
}
