/**
 * L9 — keyboard operation for the pane splitters (`SplitPanes`). The drag
 * handles were `role="separator"` but `tabIndex={-1}` and pointer-only, so a
 * keyboard user could neither focus nor move them. These pure helpers map an
 * arrow key to a signed pixel nudge (fed through the SAME `beginResize→dragTo→
 * endResize` pipeline the pointer drag uses) and compute the ARIA value the
 * separator reports. No DOM/React, so the node gate unit-tests them.
 */

/** The pixel nudge per arrow press (converted to an `fr` delta by `pxToFr`). */
export const SPLIT_STEP_PX = 24;

/**
 * The signed pixel delta for a key on a vertical separator (which resizes
 * horizontally). Left shrinks the left pane, Right grows it; everything else is
 * `0` so the handler no-ops (and never preventDefaults a key it didn't act on).
 */
export function splitKeyStepPx(key: string, stepPx: number = SPLIT_STEP_PX): number {
  switch (key) {
    case "ArrowLeft":
      return -stepPx;
    case "ArrowRight":
      return stepPx;
    default:
      return 0;
  }
}

/**
 * The ARIA range a separator reports for the joint between two panes, as integer
 * percentages of the joint's combined size: `now` = the LEFT pane's share, with
 * `min`/`max` derived from the minimum each pane may shrink to (`minFr`). Mirrors
 * the clamp in `resizeAt`, so the announced range matches what a drag can reach.
 */
export function splitterAria(
  leftFr: number,
  rightFr: number,
  minFr: number,
): { now: number; min: number; max: number } {
  const total = leftFr + rightFr;
  if (total <= 0) return { now: 50, min: 0, max: 100 };
  const pct = (v: number) => Math.round((v / total) * 100);
  return { now: pct(leftFr), min: pct(minFr), max: pct(total - minFr) };
}
