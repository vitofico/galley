/**
 * file-tree-menu — the PURE core of the file-tree right-click context menu.
 *
 * The menu offers EXACTLY the operations the tree rows already expose as
 * buttons (set-main / rename / delete for files; new-file-in-folder / rename
 * for folders) — it builds item DESCRIPTORS only; the React shell maps each
 * `id` onto the existing handler. No React, no DOM: unit-testable in the
 * node gate, mirroring `menu-nav.ts` / `file-tree-helper.ts` discipline.
 */

/** What was right-clicked: a text-file row, a folder row, or a binary-asset row. */
export type TreeMenuTarget =
  | { kind: "file"; fileId: string; path: string; isMain: boolean }
  | { kind: "folder"; path: string }
  | { kind: "binary"; fileId: string; path: string };

/** The operation ids the shell maps onto its EXISTING handlers. */
export type TreeMenuItemId =
  | "set-main"
  | "rename-file"
  | "delete-file"
  | "new-file-in-folder"
  | "new-subfolder"
  | "rename-folder"
  | "preview-binary"
  | "rename-binary"
  | "download-binary"
  | "delete-binary";

export interface TreeMenuItemSpec {
  id: TreeMenuItemId;
  label: string;
  /** Keyboard navigation skips disabled items (none today; `menu-nav` contract). */
  disabled?: boolean;
}

/**
 * The items for a target, in display order — a file gets the same ops as its
 * row (set-main only when it is NOT already the main file, matching the row's
 * conditional `main` button), a folder gets its row's `+` and `✎` ops.
 */
export function treeMenuItems(target: TreeMenuTarget): TreeMenuItemSpec[] {
  if (target.kind === "folder") {
    return [
      { id: "new-file-in-folder", label: "New file here" },
      { id: "new-subfolder", label: "New subfolder…" },
      { id: "rename-folder", label: "Rename folder" },
    ];
  }
  if (target.kind === "binary") {
    // A binary asset gets the same ops as its row: preview, rename, download,
    // delete — but NEVER set-as-main (the compile entry is always a text file).
    return [
      { id: "preview-binary", label: "Preview" },
      { id: "rename-binary", label: "Rename" },
      { id: "download-binary", label: "Download" },
      { id: "delete-binary", label: "Delete" },
    ];
  }
  const items: TreeMenuItemSpec[] = [];
  if (!target.isMain) items.push({ id: "set-main", label: "Set as main file" });
  items.push({ id: "rename-file", label: "Rename" });
  items.push({ id: "delete-file", label: "Delete" });
  return items;
}

export interface MenuPoint {
  x: number;
  y: number;
}

export interface MenuSize {
  width: number;
  height: number;
}

/**
 * Clamp a context-menu anchor so the menu stays fully inside the viewport,
 * with a small `margin` of breathing room. The menu opens toward the
 * bottom-right of the anchor; when it would overflow an edge it is shifted
 * back (never flipped — a shift keeps the math trivially predictable).
 * Coordinates never go below `margin`, even for a menu taller/wider than the
 * viewport.
 */
export function clampMenuPosition(
  anchor: MenuPoint,
  menu: MenuSize,
  viewport: MenuSize,
  margin = 8,
): MenuPoint {
  const maxX = viewport.width - menu.width - margin;
  const maxY = viewport.height - menu.height - margin;
  return {
    x: Math.max(margin, Math.min(anchor.x, maxX)),
    y: Math.max(margin, Math.min(anchor.y, maxY)),
  };
}

/**
 * The anchor point for an opening gesture. Pointer right-clicks carry real
 * `clientX/clientY`; a KEYBOARD invocation (Shift+F10 / the ContextMenu key —
 * which some browsers surface as a `contextmenu` event at 0,0) anchors at the
 * focused row's bottom-left corner instead, like native menus do.
 */
export function menuAnchor(
  clientX: number,
  clientY: number,
  rowRect: { left: number; bottom: number },
): MenuPoint {
  if (clientX === 0 && clientY === 0) {
    return { x: rowRect.left, y: rowRect.bottom };
  }
  return { x: clientX, y: clientY };
}
