/**
 * Keyboard control + command surface core (roadmap #11.7).
 *
 * A tiny, dependency-light keymap: pure matching/formatting helpers plus a thin
 * React hook that attaches a single `keydown` listener to `window`. The actual
 * action handlers (Export, Run agent, toggle panes, zoom…) live in the editor
 * shells and are bound by the coordinator during the integration sweep — this
 * module only provides the reusable machinery and the data shape.
 *
 * The matcher and formatter are PURE so they can be unit-tested without a
 * browser; the hook is a thin wrapper that is default-off-friendly (the host
 * decides when to enable it).
 */
import { useEffect } from "react";

/** A single bindable command. */
export interface Shortcut {
  /** Stable identifier (also used as a React key). */
  id: string;
  /** Chord spec, e.g. `"Mod-e"`, `"Mod-Enter"`, `"?"`. `Mod` = ⌘ on mac, Ctrl elsewhere. */
  keys: string;
  /** Human label for the command sheet. */
  label: string;
  /** Optional grouping bucket for the sheet (e.g. "File", "View"). */
  group?: string;
  /**
   * When true the binding fires even while focus is inside a text field /
   * contentEditable (e.g. the help key). Defaults to false: editable focus
   * suppresses the binding so typing is never hijacked.
   */
  global?: boolean;
  /** The action to run on a match. */
  run: () => void;
}

/** The minimal keyboard-event shape the pure matcher needs. */
export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Canonical modifier order so chord specs compare regardless of authoring order. */
const MOD_ORDER = ["mod", "alt", "shift"] as const;

/**
 * Normalize a chord spec to a canonical, case-folded form:
 * modifiers (mod/alt/shift) sorted into a fixed order, then the base key
 * lower-cased. `"Shift-Mod-E"` → `"mod-shift-e"`.
 */
export function normalizeKeys(keys: string): string {
  const parts = keys.split("-");
  const base = parts[parts.length - 1] ?? "";
  const mods = new Set(parts.slice(0, -1).map((p) => p.toLowerCase()));
  const ordered = MOD_ORDER.filter((m) => mods.has(m));
  return [...ordered, base.toLowerCase()].join("-");
}

/**
 * Build the normalized chord that an actual event represents. Mirrors
 * {@link normalizeKeys} so the two can be string-compared. `metaKey || ctrlKey`
 * collapses to the `mod` token.
 */
function eventChord(event: KeyEventLike): string {
  const mods: string[] = [];
  if (event.metaKey || event.ctrlKey) mods.push("mod");
  if (event.altKey) mods.push("alt");
  if (event.shiftKey) mods.push("shift");
  return [...mods, event.key.toLowerCase()].join("-");
}

/**
 * PURE: return the first shortcut whose chord matches `event`, or undefined.
 * `Mod` matches metaKey OR ctrlKey; letter keys are case-insensitive; shift and
 * alt must match exactly (so `Mod-e` does not swallow `Mod-Shift-e`).
 */
export function matchShortcut(
  event: KeyEventLike,
  shortcuts: readonly Shortcut[],
): Shortcut | undefined {
  const chord = eventChord(event);
  return shortcuts.find((s) => normalizeKeys(s.keys) === chord);
}

const KEY_GLYPHS_MAC: Record<string, string> = {
  enter: "↩",
  escape: "⎋",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  backspace: "⌫",
  tab: "⇥",
  " ": "Space",
};

/** Title-case a bare key for the non-mac label (`enter` → `Enter`, `e` → `E`). */
function prettyBase(base: string, isMac: boolean): string {
  if (base.length === 1) return base.toUpperCase();
  if (isMac && KEY_GLYPHS_MAC[base]) return KEY_GLYPHS_MAC[base];
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * PURE: pretty-print a chord for display. Mac → glyphs with no separators
 * (`⇧⌘E`); other platforms → `Ctrl+Shift+E`.
 */
export function formatKeys(keys: string, isMac: boolean): string {
  const norm = normalizeKeys(keys);
  const parts = norm.split("-");
  const base = parts[parts.length - 1] ?? "";
  const mods = new Set(parts.slice(0, -1));

  if (isMac) {
    // Mac convention: ⌃⌥⇧⌘ then the key, concatenated.
    let out = "";
    if (mods.has("alt")) out += "⌥";
    if (mods.has("shift")) out += "⇧";
    if (mods.has("mod")) out += "⌘";
    return out + prettyBase(base, true);
  }

  const segs: string[] = [];
  if (mods.has("mod")) segs.push("Ctrl");
  if (mods.has("alt")) segs.push("Alt");
  if (mods.has("shift")) segs.push("Shift");
  segs.push(prettyBase(base, false));
  return segs.join("+");
}

/** True when the keystroke target is a text input / contentEditable surface. */
function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  if (el.isContentEditable === true) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** The full event shape the keydown handler consumes (event-like + DOM bits). */
interface HandlerEvent extends KeyEventLike {
  preventDefault: () => void;
  target: unknown;
}

/**
 * Build the keydown handler used by {@link useShortcuts}. Exported so the
 * matching + editable-guard + preventDefault behaviour is unit-testable without
 * a DOM. On a match it runs the command and calls `preventDefault`; non-global
 * bindings are suppressed while focus is in an editable element.
 */
export function createKeydownHandler(
  shortcuts: readonly Shortcut[],
): (event: HandlerEvent) => void {
  return (event: HandlerEvent) => {
    const hit = matchShortcut(event, shortcuts);
    if (!hit) return;
    if (!hit.global && isEditableTarget(event.target)) return;
    event.preventDefault();
    hit.run();
  };
}

/**
 * Attach a single `window` keydown listener that dispatches to `shortcuts`.
 * Re-binds when the list or `enabled` changes and cleans up on unmount. When
 * `enabled` is false no listener is attached at all (default-off friendly — the
 * host decides when the layer is live).
 */
export function useShortcuts(
  shortcuts: readonly Shortcut[],
  opts?: { enabled?: boolean },
): void {
  const enabled = opts?.enabled ?? true;
  useEffect(() => {
    if (!enabled) return;
    const handler = createKeydownHandler(shortcuts);
    const listener = (e: KeyboardEvent) => handler(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [shortcuts, enabled]);
}
