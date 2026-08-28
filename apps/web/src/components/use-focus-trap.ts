import { useEffect, useRef, type RefObject } from "react";

/**
 * `useFocusTrap` (#23.5 a11y) — a small, reusable focus-trap + focus-restore hook
 * for the app's BLOCKING modals/dialogs. It is purely ADDITIVE: every modal here
 * already (a) renders `role="dialog"` + `aria-modal="true"`, (b) moves focus into
 * itself on open, and (c) closes on Escape. The two consistent gaps it closes:
 *
 *   - TRAP: Tab / Shift-Tab from the dialog's edge wrap WITHIN the dialog instead
 *     of escaping to the page behind it (which a sighted keyboard or screen-reader
 *     user can't see and gets lost in).
 *   - RESTORE: on close, focus returns to whatever element was focused when the
 *     dialog opened (its trigger) — so the keyboard user lands back where they
 *     were, not at the top of the document.
 *
 * It does NOT autofocus (the modals already do that, each picking the right first
 * target — textarea / input / the safe-default button) and does NOT handle
 * Escape (ditto). Keeping those in the components preserves their behavior
 * BYTE-FOR-BYTE; this hook only adds the trap + the restore.
 *
 * Usage: attach the returned ref to the dialog's container element and pass the
 * live `open` flag. Inert (binds nothing, restores nothing) while `open` is false.
 */

/** The interactive elements the trap can move focus to, in document order. */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * PURE decision core: given the dialog's focusable elements (in document order)
 * and the currently-focused element, return the element Tab/Shift-Tab should
 * redirect focus to in order to keep it INSIDE the dialog — or `null` when the
 * browser's native traversal already keeps it inside (don't fight it).
 *
 * Generic over a minimal `T` (compared by identity) so it is testable with plain
 * objects in the repo's jsdom-free `node` test environment.
 *
 *   - Empty list → null (nothing focusable; caller no-ops).
 *   - Tab on the last (or focus outside the dialog) → wrap to the first.
 *   - Shift-Tab on the first (or focus outside) → wrap to the last.
 *   - Otherwise (focus is an interior element) → null.
 */
export function nextTrapFocus<T>(
  focusables: readonly T[],
  active: T | null,
  shift: boolean,
): T | null {
  if (focusables.length === 0) return null;
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const index = active == null ? -1 : focusables.indexOf(active);
  if (shift) {
    // Shift-Tab: wrap when at the first element or focus has escaped the dialog.
    if (index <= 0) return last;
    return null;
  }
  // Tab: wrap when at the last element or focus has escaped the dialog.
  if (index === -1 || index === focusables.length - 1) return first;
  return null;
}

/**
 * Bind a focus trap to `containerRef` while `open`, and restore focus to the
 * previously-focused element when it closes (or the hook unmounts). The
 * container ref must point at the dialog element (the one carrying
 * `role="dialog"`); the trap queries its focusable descendants live on each Tab.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  open: boolean,
): void {
  // The element to restore focus to — captured at OPEN time (the trigger).
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;
    const doc = container.ownerDocument;

    // Capture the trigger once, at open, so close returns focus to it. The
    // modals autofocus their own first target in a separate effect; whichever
    // effect runs first, this snapshot is taken before that focus moves (React
    // runs effects top-down, and consumers call this hook FIRST), and even if
    // not, the active element at open is still a sensible restore target.
    restoreRef.current =
      doc.activeElement instanceof HTMLElement ? doc.activeElement : null;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        // Skip elements that aren't actually focusable (hidden / zero-size).
      ).filter((el) => el.offsetParent !== null || el === doc.activeElement);
      const active =
        doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
      const target = nextTrapFocus(focusables, active, e.shiftKey);
      if (target) {
        e.preventDefault();
        target.focus();
      }
    };

    // Capture phase so we decide before the browser's own Tab traversal runs.
    container.addEventListener("keydown", onKeyDown, true);
    return () => {
      container.removeEventListener("keydown", onKeyDown, true);
      // Restore focus to the trigger on close/unmount, but only if focus is
      // still somewhere we put it (inside the now-closing dialog) — never yank
      // focus the user has since moved elsewhere.
      const restore = restoreRef.current;
      restoreRef.current = null;
      if (
        restore &&
        restore.isConnected &&
        typeof restore.focus === "function" &&
        (container.contains(doc.activeElement) || doc.activeElement === doc.body)
      ) {
        restore.focus();
      }
    };
  }, [open, containerRef]);
}
