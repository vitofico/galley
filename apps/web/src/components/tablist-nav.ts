/**
 * WAI-ARIA tablist keyboard navigation (#H7) — PURE, framework-free so it
 * unit-tests in the Node gate and both tablists (the narrow `TabBar` and the
 * docked Insert tabs) share one implementation.
 *
 * Both our tablists are horizontal, so Left/Right walk the tabs (wrapping at
 * the ends) and Home/End jump to the first/last. Given the key, the currently
 * focused tab index, and the tab count, return the index to move focus to — or
 * `null` when the key isn't a navigation key, so the caller leaves it alone
 * (Enter/Space keep their native button activation; manual-activation pattern).
 */
export function tablistKeyTarget(
  key: string,
  current: number,
  count: number,
): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
