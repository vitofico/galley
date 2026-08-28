/**
 * `useDismissable` — the one shared dismissal contract for the 19.3 floating
 * surfaces (the Export menu, the status-chip popover, the Share popover):
 * while `open`, a pointerdown OUTSIDE `rootRef` or a global Escape dismisses.
 *
 * Escape calls `onDismiss("escape")` so the host can return focus to its
 * trigger (the a11y rule for menus/dialogs); outside clicks call
 * `onDismiss("outside")` and deliberately do NOT steal focus back — the user
 * is already interacting elsewhere.
 *
 * Closed (`open === false`) attaches NOTHING, so an idle popover adds zero
 * document listeners.
 */
import { useEffect, type RefObject } from "react";

export type DismissReason = "escape" | "outside";

export function useDismissable(
  open: boolean,
  rootRef: RefObject<HTMLElement | null>,
  onDismiss: (reason: DismissReason) => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (root && e.target instanceof Node && !root.contains(e.target)) {
        onDismiss("outside");
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss("escape");
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, rootRef, onDismiss]);
}
