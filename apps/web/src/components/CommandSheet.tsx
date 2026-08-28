import { useEffect, useRef } from "react";
import { formatKeys, type Shortcut } from "../use-shortcuts.js";
import { useFocusTrap } from "./use-focus-trap.js";
import "./command-sheet.css";

/**
 * Command sheet — a discoverable cheat-sheet of keyboard shortcuts (roadmap
 * #11.7). Presentational + INJECTION-ONLY: it takes the shortcut list and its
 * open/close state via props and mounts nowhere itself. The coordinator wires it
 * into the editor shells (and binds a `?`-style toggle through `useShortcuts`)
 * during the integration sweep.
 *
 * No global listeners or side effects run at module scope; the only listener is
 * an Escape handler attached while the sheet is open and removed when it closes.
 */
export interface CommandSheetProps {
  shortcuts: readonly Shortcut[];
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

const UNGROUPED = "General";

/** Group shortcuts by `group`, preserving first-seen order of both groups and items. */
function groupShortcuts(
  shortcuts: readonly Shortcut[],
): Array<{ group: string; items: Shortcut[] }> {
  const order: string[] = [];
  const buckets = new Map<string, Shortcut[]>();
  for (const s of shortcuts) {
    const g = s.group ?? UNGROUPED;
    let bucket = buckets.get(g);
    if (!bucket) {
      bucket = [];
      buckets.set(g, bucket);
      order.push(g);
    }
    bucket.push(s);
  }
  return order.map((group) => ({ group, items: buckets.get(group) ?? [] }));
}

export function CommandSheet({ shortcuts, open, onClose }: CommandSheetProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // A11y (#23.5): trap Tab within the sheet + restore focus to the trigger on
  // close. Additive — Escape is handled separately below.
  useFocusTrap(dialogRef, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // A11y (#23.5): move focus INTO the sheet on open (its Close button) so a
  // keyboard user lands inside the dialog rather than on the page behind.
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const isMac = detectMac();
  const groups = groupShortcuts(shortcuts);

  return (
    <div
      ref={dialogRef}
      className="cmd-sheet-backdrop"
      data-testid="command-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={onClose}
    >
      <div
        className="cmd-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="cmd-sheet-header">
          <h2 className="cmd-sheet-title">Keyboard shortcuts</h2>
          <button
            type="button"
            ref={closeRef}
            className="cmd-sheet-close"
            aria-label="Close"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="cmd-sheet-body">
          {groups.length === 0 ? (
            <div className="cmd-sheet-empty" data-testid="command-sheet-empty">
              No shortcuts available
            </div>
          ) : (
            groups.map(({ group, items }) => (
              <section className="cmd-sheet-group" key={group}>
                <h3 className="cmd-sheet-group-title">{group}</h3>
                <ul className="cmd-sheet-list">
                  {items.map((s) => (
                    <li className="cmd-sheet-row" key={s.id} data-testid="command-sheet-row">
                      <span className="cmd-sheet-label">{s.label}</span>
                      <kbd className="cmd-sheet-keys">{formatKeys(s.keys, isMac)}</kbd>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
