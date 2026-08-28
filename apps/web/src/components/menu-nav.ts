/**
 * Pure keyboard-navigation helpers for small menus/popovers (#19.3) — the
 * Export menu's roving focus. No React, no DOM: unit-testable in the node
 * gate, mirroring the CommandPalette's `moveSelection` discipline.
 */

/** An item the keyboard can land on; disabled items are skipped. */
export interface NavItem {
  disabled?: boolean | undefined;
}

/** Index of the first enabled item, or -1 when every item is disabled/absent. */
export function firstEnabledIndex(items: readonly NavItem[]): number {
  return items.findIndex((it) => !it.disabled);
}

/** Index of the last enabled item, or -1 when every item is disabled/absent. */
export function lastEnabledIndex(items: readonly NavItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (!items[i]!.disabled) return i;
  }
  return -1;
}

/**
 * Move from `index` by `delta` (±1) with wrap-around, skipping disabled items.
 * Returns -1 when no item is enabled; an out-of-range `index` is treated as
 * "before the start" so ArrowDown from the trigger lands on the first item.
 */
export function moveEnabledIndex(
  items: readonly NavItem[],
  index: number,
  delta: 1 | -1,
): number {
  const n = items.length;
  if (n === 0 || firstEnabledIndex(items) === -1) return -1;
  let i = index >= 0 && index < n ? index : delta === 1 ? -1 : n;
  for (let step = 0; step < n; step++) {
    i = (i + delta + n) % n;
    if (!items[i]!.disabled) return i;
  }
  return -1;
}
