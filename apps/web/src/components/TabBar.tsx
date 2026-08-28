import { useRef, type KeyboardEvent } from "react";
import type { PaneTab } from "../use-responsive.js";
import { tablistKeyTarget } from "./tablist-nav.js";
import "./tab-bar.css";

/**
 * Pane tab bar for the collapsed (narrow) layout (roadmap #11.9).
 *
 * Presentational + INJECTION-ONLY: it renders the editor/preview/agent (and, in
 * project mode, files) switch and reports selection via `onSelect`. It mounts
 * nowhere itself and holds no state — the coordinator wires it into the editor
 * shells' grid→tabs collapse during the integration sweep. No module-scope side
 * effects; styling comes from design tokens in tab-bar.css.
 *
 * Keyboard (#H7, WAI-ARIA tablist): roving `tabIndex` puts the active tab in the
 * tab order, and Left/Right/Home/End move focus across the tabs (manual
 * activation — Enter/Space still activate via the native button). Each tab
 * `aria-controls` the shared `tab-panel`, which is the live pane below.
 */
export interface TabBarProps {
  /** The tabs to show, in display order. */
  tabs: readonly { id: PaneTab; label: string }[];
  /** The currently active pane. */
  active: PaneTab;
  /** Called with a tab's id when it is chosen. */
  onSelect: (id: PaneTab) => void;
}

/** The id of the panel a `TabBar` tab controls (the narrow active-pane host). */
export const TAB_PANEL_ID = "tab-panel";

export function TabBar({ tabs, active, onSelect }: TabBarProps) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = tablistKeyTarget(e.key, index, tabs.length);
    if (target === null) return;
    e.preventDefault();
    tabRefs.current[target]?.focus();
  };

  return (
    <div
      className="tab-bar"
      data-testid="tab-bar"
      role="tablist"
      aria-label="Editor panes"
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            id={`tab-${tab.id}`}
            role="tab"
            className="tab-bar-tab"
            data-testid="tab"
            data-tab={tab.id}
            aria-selected={selected}
            aria-controls={TAB_PANEL_ID}
            {...(selected ? { "aria-current": "page" as const } : {})}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(e) => onKeyDown(e, index)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
