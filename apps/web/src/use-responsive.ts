/**
 * `useResponsive` — viewport-width breakpoint hook for the tabbed layout (#11.9).
 *
 * Below {@link DEFAULT_BREAKPOINT}px the editor shells' fixed multi-column grid
 * collapses into a TABBED editor/preview/agent stack. This module owns:
 *
 *   - the pure WIDTH → "narrow?" decision ({@link isNarrow}), unit-tested with no
 *     DOM, and
 *   - the React hook ({@link useResponsive}) that tracks the live viewport width
 *     and re-renders when it crosses the breakpoint.
 *
 * SSR / Node SAFETY (Architect ruling): `window`/`matchMedia` are NEVER touched
 * at module-eval or initial render. The hook's initial state defaults to NOT
 * narrow when there is no `window`, and the only `window` access happens inside
 * a `useEffect` (which never runs on the server / under Node). Every access is
 * additionally guarded by `typeof window !== "undefined"`.
 */
import { useEffect, useState } from "react";

/**
 * Width (CSS px) at and above which the shell keeps its multi-column grid. Below
 * it, the grid collapses to tabs. 820 sits just under a typical small-tablet /
 * large-phone landscape width, so the three side-by-side panes only collapse
 * when they would genuinely be too cramped.
 */
export const DEFAULT_BREAKPOINT = 820;

/** The selectable panes in the collapsed (tabbed) layout. */
export type PaneTab = "editor" | "preview" | "agent" | "files";

/**
 * PURE: is `width` below `breakpoint`? The boundary is inclusive of the wide
 * layout (`width === breakpoint` is NOT narrow). Non-finite widths (e.g. `NaN`
 * before the first measurement) are treated as not narrow so SSR/first paint
 * renders the wide layout.
 */
export function isNarrow(width: number, breakpoint: number = DEFAULT_BREAKPOINT): boolean {
  if (!Number.isFinite(width)) return false;
  return width < breakpoint;
}

/** Read the current viewport width, or `undefined` when there is no `window`. */
function currentWidth(): number | undefined {
  if (typeof window === "undefined") return undefined;
  return window.innerWidth;
}

/**
 * Track whether the viewport is narrower than `breakpoint`. SSR-safe: returns
 * `{ narrow: false }` when rendered without a `window`, and only subscribes to
 * resize events inside `useEffect`.
 */
export function useResponsive(breakpoint: number = DEFAULT_BREAKPOINT): { narrow: boolean } {
  const [narrow, setNarrow] = useState<boolean>(() => {
    const w = currentWidth();
    return w === undefined ? false : isNarrow(w, breakpoint);
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setNarrow(isNarrow(window.innerWidth, breakpoint));
    // Re-sync immediately in case the width changed between initial render and
    // effect (or this is the first client render after an SSR/false default).
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [breakpoint]);

  return { narrow };
}
