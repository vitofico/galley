/**
 * Pure zoom-state helpers for the preview pane. No React, no DOM access beyond
 * the small localStorage read/write wrappers (which are guarded). Kept pure so
 * the zoom math (clamp / step / persistence) can be unit-tested in isolation.
 */

/** Stable localStorage key for the persisted preview zoom level. */
export const ZOOM_STORAGE_KEY = "galley.preview.zoom";

/** Zoom is expressed as a percentage. 100 == actual size (the default). */
export const ZOOM_DEFAULT = 100;
export const ZOOM_MIN = 50;
export const ZOOM_MAX = 300;
export const ZOOM_STEP = 25;

/** Clamp a zoom percentage into the supported [MIN, MAX] range, rounded. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return ZOOM_DEFAULT;
  const rounded = Math.round(zoom);
  if (rounded < ZOOM_MIN) return ZOOM_MIN;
  if (rounded > ZOOM_MAX) return ZOOM_MAX;
  return rounded;
}

/** One step larger, clamped. */
export function zoomIn(zoom: number): number {
  return clampZoom(zoom + ZOOM_STEP);
}

/** One step smaller, clamped. */
export function zoomOut(zoom: number): number {
  return clampZoom(zoom - ZOOM_STEP);
}

/** True when the given zoom is effectively actual-size (no transform needed). */
export function isActualSize(zoom: number): boolean {
  return clampZoom(zoom) === ZOOM_DEFAULT;
}

/**
 * Parse a persisted value into a valid zoom percentage. Anything malformed
 * (null, non-numeric, out of range) collapses to the default.
 */
export function parseStoredZoom(raw: string | null | undefined): number {
  if (raw == null) return ZOOM_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return ZOOM_DEFAULT;
  return clampZoom(n);
}

/**
 * Read the persisted zoom from localStorage, falling back to the default if
 * storage is unavailable (SSR, privacy mode, etc.) or the value is malformed.
 */
export function readStoredZoom(): number {
  try {
    if (typeof localStorage === "undefined") return ZOOM_DEFAULT;
    return parseStoredZoom(localStorage.getItem(ZOOM_STORAGE_KEY));
  } catch {
    return ZOOM_DEFAULT;
  }
}

/** Persist the zoom level; silently no-ops if storage is unavailable. */
export function writeStoredZoom(zoom: number): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(ZOOM_STORAGE_KEY, String(clampZoom(zoom)));
  } catch {
    /* ignore quota / privacy-mode failures */
  }
}
