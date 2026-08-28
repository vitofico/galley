/**
 * `FileTreeMenu` — the file tree's right-click context menu. A thin, floating
 * `role="menu"` popover over the SAME operations the tree rows already expose
 * as buttons: the pure `treeMenuItems` core decides which items a target gets,
 * and the host maps each item id onto its EXISTING handler (`onAction`) — no
 * file operation is reimplemented here.
 *
 * Interaction contract (WAI-ARIA menu): opens with the first item focused
 * (roving focus, like the Export menu); ↓/↑ wrap, Home/End jump, Enter/Space
 * activates, Escape closes and returns focus to the row that opened it; an
 * outside pointerdown, a scroll, Tab, or a window blur closes WITHOUT stealing
 * focus. `useFocusTrap` is deliberately not used: menus use roving focus and
 * close on Tab (the ARIA menu pattern), they don't trap a Tab cycle the way
 * the blocking dialogs do.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  firstEnabledIndex,
  lastEnabledIndex,
  moveEnabledIndex,
} from "./menu-nav.js";
import { useDismissable, type DismissReason } from "./use-dismissable.js";
import {
  clampMenuPosition,
  treeMenuItems,
  type MenuPoint,
  type TreeMenuItemId,
  type TreeMenuTarget,
} from "./file-tree-menu.js";
import "./rail-and-pills.css";
import "./file-tree-menu.css";

export function FileTreeMenu({
  target,
  anchor,
  onAction,
  onClose,
}: {
  target: TreeMenuTarget;
  anchor: MenuPoint;
  /** Maps an item id onto the host's EXISTING file-op handler. */
  onAction: (id: TreeMenuItemId, target: TreeMenuTarget) => void;
  onClose: () => void;
}) {
  const items = treeMenuItems(target);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // The element focused when the menu opened (the row) — restored on Escape /
  // action, NOT on outside dismissal (the user is already elsewhere).
  const restoreRef = useRef<Element | null>(
    typeof document !== "undefined" ? document.activeElement : null,
  );
  const [active, setActive] = useState(() => firstEnabledIndex(items));
  const [position, setPosition] = useState<MenuPoint>(anchor);

  const close = useCallback(
    (reason: DismissReason | "action") => {
      if (reason !== "outside") {
        const restore = restoreRef.current;
        const root = rootRef.current;
        // Only pull focus back if it is still where the menu put it.
        if (
          restore instanceof HTMLElement &&
          restore.isConnected &&
          (root?.contains(document.activeElement) ||
            document.activeElement === document.body)
        ) {
          restore.focus();
        }
      }
      onClose();
    },
    [onClose],
  );
  useDismissable(true, rootRef, close);

  // Clamp into the viewport once the real menu size is measurable (pre-paint).
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPosition(
      clampMenuPosition(
        anchor,
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [anchor]);

  // The menu mounts at the shell top level (a positioned ancestor with
  // backdrop-filter/overflow would re-anchor and clip position:fixed), so only
  // a page-level scroll still contains it — that closes the menu (the anchor
  // moved with the page). Pane scrollers (files, editor, preview) don't, and
  // must not: outside-pointerdown/Escape/blur already cover dismissal there.
  // Leaving the window (blur) also closes. Neither pulls focus back.
  useEffect(() => {
    const onScroll = (e: Event) => {
      const root = rootRef.current;
      const target =
        e.target instanceof Document
          ? e.target.documentElement
          : e.target instanceof Node
            ? e.target
            : null;
      if (root && target && !target.contains(root)) return;
      close("outside");
    };
    const onBlur = () => close("outside");
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [close]);

  // Roving focus: the active menuitem takes real focus (screen readers track it).
  useEffect(() => {
    if (active >= 0) itemRefs.current[active]?.focus();
  }, [active]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => moveEnabledIndex(items, i, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => moveEnabledIndex(items, i, -1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(firstEnabledIndex(items));
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(lastEnabledIndex(items));
    } else if (e.key === "Tab") {
      // Tab leaves the menu; close so focus lands where the user expects.
      close("outside");
    }
  };

  return (
    <div
      ref={rootRef}
      className="ui-popover file-tree-menu"
      role="menu"
      aria-label={`File tree actions for ${target.path}`}
      data-testid="file-tree-menu"
      data-path={target.path}
      style={{ left: position.x, top: position.y }}
      onKeyDown={onMenuKeyDown}
      // A right-click ON the menu itself must not bubble into another open.
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          ref={(el) => {
            itemRefs.current[i] = el;
          }}
          role="menuitem"
          className="file-tree-menu-item"
          data-testid={`menu-${item.id}`}
          data-path={target.path}
          tabIndex={i === active ? 0 : -1}
          onMouseEnter={() => setActive(i)}
          onClick={() => {
            onAction(item.id, target);
            close("action");
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
