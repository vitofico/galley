/**
 * Dock model for the "Rail & Islands" shell (#19.2 — spec §1).
 *
 * The icon rail docks ONE panel at a time beside it as a floating card (the
 * DockedPanel host): Files, History, Git, Insert (figure/citation/import as
 * tabs of one panel), or Outline (the document heading navigator, relocated out
 * of the center stats block). The agent sidebar stays a SplitPanes tile in this stage;
 * its rail icon drives the existing pane collapse. The editor-prefs dock was
 * RETIRED by #19.7 — preferences live on the `/settings` route now.
 *
 * PURE + UNIT-TESTED: this module owns the open/switch/close transitions and
 * nothing else (no React, no storage). ProjectApp wraps it in useState and
 * persists only the Files open/closed choice through the existing panes
 * collapse flag, so the file list survives a reload the way the old pane did.
 */

/** The panels the rail can dock, in rail order. */
export const DOCK_IDS = ["files", "search", "history", "git", "insert", "outline"] as const;
export type DockId = (typeof DOCK_IDS)[number];

/** Tabs of the single docked Insert panel (spec §1: one panel, three tabs). */
export const INSERT_TABS = ["figure", "citation", "import"] as const;
export type InsertTab = (typeof INSERT_TABS)[number];

export interface DockState {
  /** The currently docked panel, or `null` when the dock is empty. */
  open: DockId | null;
  /** The Insert panel's active tab (remembered while the dock is closed). */
  insertTab: InsertTab;
}

/** Card titles for the DockedPanel header, keyed by panel. */
export const DOCK_TITLES: Record<DockId, string> = {
  files: "Files",
  search: "Search",
  history: "Version history",
  git: "Git sync",
  insert: "Insert",
  outline: "Outline",
};

/**
 * The boot state: the Files panel defaults OPEN (it is the workspace's file
 * tree, not a transient tool) unless the user had explicitly closed it
 * (`filesClosed`, read from the persisted panes collapse flag). Transient
 * panels (history/git/insert) always boot closed.
 */
export function initialDockState(filesClosed: boolean): DockState {
  return { open: filesClosed ? null : "files", insertTab: "figure" };
}

/**
 * Laptop-width range where the Files dock auto-collapses on a FIRST run so the
 * preview can render its page near physical size (#preview-legibility).
 *
 * The dock is a 19rem (~304px) flex tile that pushes the editor/preview/agent
 * grid right. On a laptop (≈1280–1440px) that, plus the agent panel, squeezes
 * an A5 page (560px physical) into a ~320px pane, shrinking the rendered text to
 * ~8px — the reported "preview text is small". Below `MORPH_WIDTH` the shell
 * already morphs to a tabbed stack (the dock isn't a tile there), and at/above
 * `WIDE_WIDTH` there is room for the dock AND a physical-size page, so the file
 * tree stays open. Only the in-between band auto-collapses, and only when the
 * user has expressed no explicit choice — one rail click reopens it and is
 * remembered thereafter (see `onRailToggle`).
 */
export const FILES_AUTO_COLLAPSE_MORPH_WIDTH = 820;
export const FILES_AUTO_COLLAPSE_WIDE_WIDTH = 1680;

/**
 * Resolve whether the Files dock should boot CLOSED, honoring an explicit user
 * choice above all and otherwise auto-collapsing in the laptop band above.
 *
 * `explicit` is the persisted choice: `true`/`false` once the user has toggled
 * the dock (open/closed is then sticky), or `null`/`undefined` on a first run.
 * A non-finite width (SSR / pre-measure) never auto-collapses, so the file tree
 * is present by default everywhere except a measured laptop viewport.
 */
export function shouldBootFilesClosed(
  explicit: boolean | null | undefined,
  viewportWidth: number,
): boolean {
  if (explicit === true) return true;
  if (explicit === false) return false;
  if (!Number.isFinite(viewportWidth)) return false;
  return (
    viewportWidth >= FILES_AUTO_COLLAPSE_MORPH_WIDTH &&
    viewportWidth < FILES_AUTO_COLLAPSE_WIDE_WIDTH
  );
}

/** Rail-icon click: close the panel if it is the docked one, else dock it. */
export function toggleDock(state: DockState, id: DockId): DockState {
  return { ...state, open: state.open === id ? null : id };
}

/** Open a specific panel (palette commands, programmatic opens). Idempotent. */
export function openDock(state: DockState, id: DockId): DockState {
  return { ...state, open: id };
}

/** Close the dock entirely (card ✕, Escape inside a panel, post-Accept). */
export function closeDock(state: DockState): DockState {
  return { ...state, open: null };
}

/**
 * Close the dock ONLY if `id` is the docked panel — the host's per-panel
 * `onClose` callbacks use this so a stale close (from a panel that was just
 * replaced by another) can never dismiss the newcomer.
 */
export function closeDockIf(state: DockState, id: DockId): DockState {
  return state.open === id ? { ...state, open: null } : state;
}

/** Open the Insert panel at a specific tab (or just switch tabs when docked). */
export function openInsertTab(state: DockState, tab: InsertTab): DockState {
  return { ...state, open: "insert", insertTab: tab };
}
