import { useEffect, useMemo, useRef, useState } from "react";
import {
  filterCommands,
  groupCommands,
  isAvailable,
  type Command,
} from "../commands/registry.js";
import { formatKeys } from "../use-shortcuts.js";
import { useFocusTrap } from "./use-focus-trap.js";
import "./command-palette.css";

/**
 * Command palette (#19.1, Rail & Islands stage 1) — the ⌘K fuzzy-search
 * surface over the CommandRegistry. Presentational + INJECTION-ONLY (same
 * discipline as the CommandSheet): the host owns the open/close state, the
 * Mod-K binding, and the command list; the palette renders nowhere by itself
 * and `open={false}` renders NOTHING (the shipped DOM stays byte-identical).
 *
 * Keyboard-first: the search input is focused on open, ↑/↓ move the selection
 * (wrap-around) over the grouped results, Enter runs the selected command,
 * Escape closes. Shortcut hints render inline. Commands whose `available()` is
 * false are never listed and never run (the gate is re-checked at Enter-time).
 * Running a command only invokes the host's EXISTING handler and closes —
 * nothing is auto-applied and no editor state is touched.
 */
export interface CommandPaletteProps {
  commands: readonly Command[];
  open: boolean;
  onClose: () => void;
}

/** Best-effort platform check; falls back to non-mac in non-browser contexts. */
function detectMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * PURE: the palette's result pipeline — availability gate, then the fuzzy
 * filter (ranked), then grouping (first-seen group order over the ranked list).
 */
export function paletteResults(
  commands: readonly Command[],
  query: string,
): Array<{ group: string; items: Command[] }> {
  return groupCommands(filterCommands(commands.filter(isAvailable), query));
}

/** PURE: the grouped results flattened back to the keyboard-selection order. */
export function flattenResults(
  groups: ReadonlyArray<{ group: string; items: Command[] }>,
): Command[] {
  return groups.flatMap((g) => g.items);
}

/**
 * PURE: move the selection by `delta` over `count` results with wrap-around;
 * an out-of-range index is clamped first (results can shrink while typing).
 * No results → 0.
 */
export function moveSelection(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  const clamped = Math.min(Math.max(index, 0), count - 1);
  return (clamped + delta + count) % count;
}

/**
 * PURE: the run gate — execute `command` (when present AND available) via its
 * existing handler, then close. Returns whether it ran. Never runs a command
 * whose `available()` is false, even if one slipped into the rendered list.
 */
export function executePaletteCommand(
  command: Command | undefined,
  close: () => void,
): boolean {
  if (!command || !isAvailable(command)) return false;
  command.run();
  close();
  return true;
}

export function CommandPalette({ commands, open, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // A11y (#23.5): restore focus to the trigger on close. The palette's own
  // arrow-key list is the primary navigation; the trap additionally keeps Tab
  // inside the overlay (it has only the input + option buttons).
  useFocusTrap(dialogRef, open);

  // Fresh slate on every open: empty query, selection at the top, input
  // focused. Focusing OUR input is the only focus change; closing restores
  // nothing by force, so the host's editor state is never clobbered.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    inputRef.current?.focus();
  }, [open]);

  const groups = useMemo(
    () => (open ? paletteResults(commands, query) : []),
    [open, commands, query],
  );
  const flat = useMemo(() => flattenResults(groups), [groups]);
  const isMac = useMemo(detectMac, []);

  if (!open) return null;

  const selectedIndex = Math.min(selected, Math.max(flat.length - 1, 0));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => moveSelection(i, 1, flat.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => moveSelection(i, -1, flat.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      executePaletteCommand(flat[selectedIndex], onClose);
    }
  };

  // Option ids for aria-activedescendant (flat keyboard order).
  let optionIndex = -1;

  return (
    <div
      ref={dialogRef}
      className="cmd-palette-backdrop"
      data-testid="command-palette"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={onClose}
    >
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmd-palette-input"
          data-testid="command-palette-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="cmd-palette-options"
          {...(flat.length > 0
            ? { "aria-activedescendant": `cmd-palette-opt-${selectedIndex}` }
            : {})}
          aria-label="Search commands"
          placeholder="Type a command or file name…"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="cmd-palette-body" id="cmd-palette-options" role="listbox" aria-label="Commands">
          {flat.length === 0 ? (
            <div className="cmd-palette-empty" data-testid="command-palette-empty">
              No matching commands
            </div>
          ) : (
            groups.map(({ group, items }) => (
              <section className="cmd-palette-group" key={group}>
                <h3 className="cmd-palette-group-title">{group}</h3>
                <ul className="cmd-palette-list">
                  {items.map((command) => {
                    optionIndex += 1;
                    const index = optionIndex;
                    return (
                      <li key={command.id}>
                        <button
                          type="button"
                          id={`cmd-palette-opt-${index}`}
                          className={`cmd-palette-item${index === selectedIndex ? " is-selected" : ""}`}
                          data-testid="command-palette-item"
                          data-command-id={command.id}
                          role="option"
                          aria-selected={index === selectedIndex}
                          // Keep focus in the search input while clicking.
                          onMouseDown={(e) => e.preventDefault()}
                          onMouseEnter={() => setSelected(index)}
                          onClick={() => executePaletteCommand(command, onClose)}
                        >
                          <span className="cmd-palette-item-title">{command.title}</span>
                          {command.shortcut && (
                            <kbd className="cmd-palette-keys">{formatKeys(command.shortcut, isMac)}</kbd>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
