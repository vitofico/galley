/**
 * `usePanes` — the editor-shell layout model (roadmap #11.1).
 *
 * The shell is a CSS grid whose track list is driven by custom properties
 * (`--col-*`). This hook owns the per-column `fr` weights and the collapsed
 * flags, persists them to `localStorage` under a versioned key, and exposes
 * pointer-drag / collapse / reset handlers.
 *
 * The math + persistence are factored into the pure functions below so they can
 * be unit-tested without a browser; the React hook is a thin wrapper.
 */
import { useCallback, useMemo, useRef, useState } from "react";

/** Bumped if the persisted shape ever changes incompatibly. */
export const PANES_VERSION = 1;
export const PANES_KEY = `galley.panes.v${PANES_VERSION}`;

/** Logical columns, in DOM order, per layout. */
export const SINGLE_COLS = ["editor", "center", "sidebar"] as const;
export const PROJECT_COLS = ["files", "editor", "center", "sidebar"] as const;
export type Layout = "single" | "project" | "rail";
export type ColName = (typeof PROJECT_COLS)[number];

/** Default `fr` weights — byte-for-byte the pre-#11.1 CSS grid templates. */
export const DEFAULTS: Record<Layout, Record<string, number>> = {
  single: { editor: 1, center: 1.12, sidebar: 0.92 },
  project: { files: 0.5, editor: 1, center: 1.12, sidebar: 0.92 },
  // Rail & Islands (#19.2): the file list left the grid for the docked rail
  // panel, so the tiled columns match the single layout. "files" survives as a
  // COLLAPSIBLE flag only — it persists the dock's open/closed choice.
  // The preview (`center`) is weighted wider than the editor by default: a page
  // is only legible with enough width, and an editor-heavy split shrank an A5
  // page (and its text) into a cramped pane (the reported "text is super small").
  // The extra width is taken from the EDITOR only — the agent/diff `sidebar`
  // keeps its original 0.92/3.04 share so its proposal-review layout is unchanged.
  rail: { editor: 0.62, center: 1.5, sidebar: 0.92 },
};

/** Which columns can be collapsed (a focused-writing view), per layout. */
export const COLLAPSIBLE: Record<Layout, ColName[]> = {
  single: ["sidebar"],
  project: ["sidebar", "files"],
  rail: ["sidebar", "files"],
};


/** Minimum `fr` weight a column may be dragged to (keeps a pane usable). */
export const MIN_FR = 0.18;

export type PanesState = {
  sizes: Record<string, number>;
  collapsed: Record<string, boolean>;
};

export const colsFor = (layout: Layout): readonly ColName[] =>
  layout === "project" ? PROJECT_COLS : SINGLE_COLS;

/** The pristine state for a layout: default weights, nothing collapsed. */
export function defaultState(layout: Layout): PanesState {
  return { sizes: { ...DEFAULTS[layout] }, collapsed: {} };
}

/**
 * Coerce arbitrary parsed JSON into a valid state for `layout`, dropping unknown
 * keys and clamping sizes. Returns the default state for anything unusable so a
 * corrupt/old payload can never break the shell.
 */
export function sanitize(layout: Layout, raw: unknown): PanesState {
  const base = defaultState(layout);
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Partial<PanesState>;
  const cols = colsFor(layout);
  if (r.sizes && typeof r.sizes === "object") {
    for (const c of cols) {
      const v = (r.sizes as Record<string, unknown>)[c];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) {
        base.sizes[c] = Math.max(MIN_FR, v);
      }
    }
  }
  if (r.collapsed && typeof r.collapsed === "object") {
    for (const c of COLLAPSIBLE[layout]) {
      if ((r.collapsed as Record<string, unknown>)[c] === true) base.collapsed[c] = true;
    }
  }
  return base;
}

/** Read + sanitize persisted state (try/catch like the `galley.provider` usage). */
export function loadState(layout: Layout): PanesState {
  try {
    const raw = localStorage.getItem(PANES_KEY);
    if (!raw) return defaultState(layout);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return sanitize(layout, parsed[layout]);
  } catch {
    return defaultState(layout);
  }
}

/** Persist this layout's state, merged with any sibling layout already stored. */
export function saveState(layout: Layout, state: PanesState): void {
  try {
    let store: Record<string, unknown> = {};
    const raw = localStorage.getItem(PANES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") store = parsed as Record<string, unknown>;
    }
    store[layout] = state;
    localStorage.setItem(PANES_KEY, JSON.stringify(store));
  } catch {
    /* ignore quota/availability errors */
  }
}

/**
 * Apply a drag between the column at `index` and its right neighbour. `deltaFr`
 * is the signed change in `fr` weight to move from the right column into the
 * left one. Both stay >= MIN_FR (the drag is clamped at the joint). Pure.
 */
export function resizeAt(
  layout: Layout,
  sizes: Record<string, number>,
  index: number,
  deltaFr: number,
): Record<string, number> {
  const cols = colsFor(layout);
  const left = cols[index];
  const right = cols[index + 1];
  if (!left || !right) return sizes;
  const leftSize = sizes[left] ?? 0;
  const rightSize = sizes[right] ?? 0;
  const total = leftSize + rightSize;
  let nextLeft = leftSize + deltaFr;
  nextLeft = Math.max(MIN_FR, Math.min(total - MIN_FR, nextLeft));
  const nextRight = total - nextLeft;
  return { ...sizes, [left]: nextLeft, [right]: nextRight };
}

/** Convert a pixel delta over a container width into an `fr` delta. */
export function pxToFr(
  layout: Layout,
  sizes: Record<string, number>,
  collapsed: Record<string, boolean>,
  deltaPx: number,
  containerPx: number,
): number {
  if (containerPx <= 0) return 0;
  // Only non-collapsed columns occupy track space, so the visible fr total maps
  // onto the full container width.
  const cols = colsFor(layout);
  const visibleTotal = cols.reduce((s, c) => (collapsed[c] ? s : s + (sizes[c] ?? 0)), 0);
  if (visibleTotal <= 0) return 0;
  return (deltaPx / containerPx) * visibleTotal;
}

/**
 * The grid `grid-template-columns` track list as CSS custom properties. A
 * collapsed column becomes `0fr` (the pane itself is hidden via `aria-hidden`/
 * display in the component), so its splitter and width vanish.
 */
export function gridVars(
  layout: Layout,
  sizes: Record<string, number>,
  collapsed: Record<string, boolean>,
): Record<string, string> {
  const cols = colsFor(layout);
  const out: Record<string, string> = {};
  for (const c of cols) {
    out[`--col-${c}`] = collapsed[c] ? "0fr" : `${sizes[c] ?? 0}fr`;
  }
  return out;
}

export type UsePanes = {
  state: PanesState;
  vars: Record<string, string>;
  isCollapsed: (col: ColName) => boolean;
  toggleCollapse: (col: ColName) => void;
  /** Begin a drag at the joint after column `index` (0-based, left of joint). */
  beginResize: (index: number, e: { clientX: number }, containerPx: number) => void;
  /** Continuous drag update (pointer move). */
  dragTo: (clientX: number, containerPx: number) => void;
  endResize: () => void;
  /** Reset the whole layout to defaults (double-click a splitter). */
  reset: () => void;
};

export function usePanes(layout: Layout): UsePanes {
  const [state, setState] = useState<PanesState>(() => loadState(layout));
  const drag = useRef<{ index: number; startX: number; startSizes: Record<string, number> } | null>(
    null,
  );

  const commit = useCallback(
    (next: PanesState) => {
      setState(next);
      saveState(layout, next);
    },
    [layout],
  );

  const beginResize = useCallback(
    (index: number, e: { clientX: number }) => {
      drag.current = { index, startX: e.clientX, startSizes: { ...state.sizes } };
    },
    [state.sizes],
  );

  const dragTo = useCallback(
    (clientX: number, containerPx: number) => {
      const d = drag.current;
      if (!d) return;
      const deltaPx = clientX - d.startX;
      const deltaFr = pxToFr(layout, d.startSizes, state.collapsed, deltaPx, containerPx);
      const sizes = resizeAt(layout, d.startSizes, d.index, deltaFr);
      // Live update without persisting on every pixel; persisted on endResize.
      setState((s) => ({ ...s, sizes }));
    },
    [layout, state.collapsed],
  );

  const endResize = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    // Persist the settled sizes.
    setState((s) => {
      saveState(layout, s);
      return s;
    });
  }, [layout]);

  const toggleCollapse = useCallback(
    (col: ColName) => {
      setState((s) => {
        const next = { ...s, collapsed: { ...s.collapsed } };
        if (next.collapsed[col]) delete next.collapsed[col];
        else next.collapsed[col] = true;
        saveState(layout, next);
        return next;
      });
    },
    [layout],
  );

  const reset = useCallback(() => commit(defaultState(layout)), [commit, layout]);

  const isCollapsed = useCallback((col: ColName) => state.collapsed[col] === true, [state.collapsed]);

  const vars = useMemo(
    () => gridVars(layout, state.sizes, state.collapsed),
    [layout, state.sizes, state.collapsed],
  );

  return { state, vars, isCollapsed, toggleCollapse, beginResize, dragTo, endResize, reset };
}
