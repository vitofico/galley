/**
 * `ExportMenu` (#19.3, spec §2) — the actions pill's ONE Export button. The
 * three always-visible export buttons (PDF / source bundle / git repo)
 * collapse into a single trigger opening a small, keyboard-navigable menu.
 *
 * The menu ITEMS keep the old data-testids (`export-pdf`, `export-bundle`,
 * `export-git-repo`) so the e2e suite only gains an "open the menu" step —
 * the assertions against the controls themselves are unchanged.
 *
 * Keyboard contract (WAI-ARIA menu-button): trigger opens on click / Enter /
 * Space / ArrowDown (focusing the first enabled item; ArrowUp opens on the
 * last); ↓/↑ wrap over enabled items, Home/End jump, Enter/Space activates,
 * Escape closes and returns focus to the trigger. An outside pointerdown
 * closes without stealing focus.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  firstEnabledIndex,
  lastEnabledIndex,
  moveEnabledIndex,
} from "./menu-nav.js";
import { useDismissable, type DismissReason } from "./use-dismissable.js";
import "./rail-and-pills.css";

export interface ExportMenuItem {
  /** Stable id; doubles as the data-testid the e2e suite already targets. */
  testId: string;
  label: string;
  /** Quiet second line (e.g. the produced file shape). */
  hint?: string;
  /** Inline shortcut hint (e.g. "⌘E"). Display-only. */
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
}

export function ExportMenu({ items }: { items: readonly ExportMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = useCallback((reason: DismissReason | "action") => {
    setOpen(false);
    setActive(-1);
    if (reason !== "outside") triggerRef.current?.focus();
  }, []);
  useDismissable(open, rootRef, close);

  const openAt = (index: number) => {
    setOpen(true);
    setActive(index);
  };

  // Roving focus: the active menuitem takes real focus (screen readers track it).
  useEffect(() => {
    if (open && active >= 0) itemRefs.current[active]?.focus();
  }, [open, active]);

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      openAt(firstEnabledIndex(items));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openAt(lastEnabledIndex(items));
    }
  };

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

  const activate = (item: ExportMenuItem) => {
    if (item.disabled) return;
    item.run();
    close("action");
  };

  return (
    <div className="export-menu-wrap" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="pill-btn"
        data-testid="export-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Export the document or project"
        onClick={() => (open ? close("action") : openAt(firstEnabledIndex(items)))}
        onKeyDown={onTriggerKeyDown}
      >
        Export
        <span className="pill-btn-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div
          className="ui-popover export-menu"
          role="menu"
          aria-label="Export"
          data-testid="export-menu"
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, i) => (
            <button
              key={item.testId}
              type="button"
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              role="menuitem"
              className="export-menu-item"
              data-testid={item.testId}
              disabled={item.disabled ?? false}
              tabIndex={i === active ? 0 : -1}
              onMouseEnter={() => {
                if (!item.disabled) setActive(i);
              }}
              onClick={() => activate(item)}
            >
              <span className="export-menu-item-label">
                {item.label}
                {item.hint && <span className="export-menu-item-hint">{item.hint}</span>}
              </span>
              {item.shortcut && <kbd className="export-menu-keys">{item.shortcut}</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
