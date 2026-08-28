import { describe, it, expect, vi } from "vitest";
import {
  matchShortcut,
  formatKeys,
  normalizeKeys,
  type Shortcut,
  type KeyEventLike,
} from "./use-shortcuts.js";

/** A minimal synthetic event factory for the pure matcher. */
function ev(partial: Partial<KeyEventLike>): KeyEventLike {
  return {
    key: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...partial,
  };
}

const shortcut = (keys: string, id = keys): Shortcut => ({
  id,
  keys,
  label: id,
  run: () => {},
});

describe("normalizeKeys", () => {
  it("lowercases the letter and orders modifiers canonically", () => {
    expect(normalizeKeys("Mod-E")).toBe("mod-e");
    expect(normalizeKeys("Shift-Mod-e")).toBe("mod-shift-e");
    expect(normalizeKeys("Alt-Shift-Mod-K")).toBe("mod-alt-shift-k");
  });

  it("leaves bare keys alone (case-folded)", () => {
    expect(normalizeKeys("?")).toBe("?");
    expect(normalizeKeys("Enter")).toBe("enter");
  });
});

describe("matchShortcut", () => {
  it("matches Mod via metaKey (mac)", () => {
    const list = [shortcut("Mod-e", "export")];
    expect(matchShortcut(ev({ key: "e", metaKey: true }), list)?.id).toBe("export");
  });

  it("matches Mod via ctrlKey (non-mac)", () => {
    const list = [shortcut("Mod-e", "export")];
    expect(matchShortcut(ev({ key: "e", ctrlKey: true }), list)?.id).toBe("export");
  });

  it("is case-insensitive on letter keys", () => {
    const list = [shortcut("Mod-e", "export")];
    expect(matchShortcut(ev({ key: "E", metaKey: true }), list)?.id).toBe("export");
  });

  it("discriminates on shift", () => {
    const list = [shortcut("Mod-e", "export"), shortcut("Mod-Shift-e", "export-all")];
    expect(matchShortcut(ev({ key: "e", metaKey: true }), list)?.id).toBe("export");
    expect(
      matchShortcut(ev({ key: "e", metaKey: true, shiftKey: true }), list)?.id,
    ).toBe("export-all");
  });

  it("discriminates on alt", () => {
    const list = [shortcut("Mod-e", "export"), shortcut("Mod-Alt-e", "export-alt")];
    expect(
      matchShortcut(ev({ key: "e", metaKey: true, altKey: true }), list)?.id,
    ).toBe("export-alt");
    // A plain Mod-e event must NOT match the alt binding.
    expect(matchShortcut(ev({ key: "e", metaKey: true }), list)?.id).toBe("export");
  });

  it("does not match a Mod binding when no modifier is held", () => {
    const list = [shortcut("Mod-e", "export")];
    expect(matchShortcut(ev({ key: "e" }), list)).toBeUndefined();
  });

  it("matches a bare ? key (the help binding)", () => {
    const list = [shortcut("?", "help")];
    expect(matchShortcut(ev({ key: "?" }), list)?.id).toBe("help");
  });

  it("requires no modifiers for a bare key", () => {
    const list = [shortcut("?", "help")];
    expect(matchShortcut(ev({ key: "?", metaKey: true }), list)).toBeUndefined();
  });

  it("matches Mod-Enter", () => {
    const list = [shortcut("Mod-Enter", "run")];
    expect(matchShortcut(ev({ key: "Enter", metaKey: true }), list)?.id).toBe("run");
  });

  it("returns the FIRST matching shortcut", () => {
    const list = [shortcut("Mod-e", "a"), shortcut("Mod-e", "b")];
    expect(matchShortcut(ev({ key: "e", metaKey: true }), list)?.id).toBe("a");
  });

  it("returns undefined when nothing matches", () => {
    const list = [shortcut("Mod-e", "export")];
    expect(matchShortcut(ev({ key: "x", metaKey: true }), list)).toBeUndefined();
  });
});

describe("formatKeys", () => {
  it("renders mac glyphs", () => {
    expect(formatKeys("Mod-e", true)).toBe("⌘E");
    expect(formatKeys("Mod-Shift-e", true)).toBe("⇧⌘E");
    expect(formatKeys("Mod-Alt-k", true)).toBe("⌥⌘K");
    expect(formatKeys("Mod-Enter", true)).toBe("⌘↩");
  });

  it("renders non-mac labels", () => {
    expect(formatKeys("Mod-e", false)).toBe("Ctrl+E");
    expect(formatKeys("Mod-Shift-e", false)).toBe("Ctrl+Shift+E");
    expect(formatKeys("Mod-Alt-k", false)).toBe("Ctrl+Alt+K");
    expect(formatKeys("Mod-Enter", false)).toBe("Ctrl+Enter");
  });

  it("renders a bare key with no modifiers", () => {
    expect(formatKeys("?", true)).toBe("?");
    expect(formatKeys("?", false)).toBe("?");
  });
});

/**
 * Hook smoke test. The Vitest env is `node` (no jsdom), so we stand up a tiny
 * fake `window` that records listeners, then exercise the hook through React's
 * test renderer-free path: we call the effect's wiring directly via a fake.
 *
 * Rather than mount React (no DOM), we verify the listener contract by reusing
 * the exported `handleKeydown` factory the hook relies on.
 */
describe("createKeydownHandler (the hook's core)", () => {
  it("runs a matching shortcut and prevents default", () => {
    const run = vi.fn();
    const preventDefault = vi.fn();
    const handler = createHandler([
      { id: "export", keys: "Mod-e", label: "Export", run },
    ]);
    handler({
      key: "e",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault,
      target: null,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("ignores keystrokes when focus is in an editable element (non-global)", () => {
    const run = vi.fn();
    const handler = createHandler([
      { id: "export", keys: "Mod-e", label: "Export", run },
    ]);
    handler({
      key: "e",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => {},
      target: { tagName: "TEXTAREA", isContentEditable: false },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("still fires a global shortcut from within an editable element", () => {
    const run = vi.fn();
    const handler = createHandler([
      { id: "help", keys: "?", label: "Help", group: "General", global: true, run },
    ]);
    handler({
      key: "?",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => {},
      target: { tagName: "INPUT", isContentEditable: false },
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("does nothing when no shortcut matches", () => {
    const run = vi.fn();
    const preventDefault = vi.fn();
    const handler = createHandler([
      { id: "export", keys: "Mod-e", label: "Export", run },
    ]);
    handler({
      key: "x",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault,
      target: null,
    });
    expect(run).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

// Imported lazily so the pure-function describe blocks above read first.
import { createKeydownHandler as createHandler } from "./use-shortcuts.js";
