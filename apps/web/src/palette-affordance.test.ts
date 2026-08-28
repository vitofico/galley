import { describe, it, expect } from "vitest";
import { paletteAffordance } from "./palette-affordance.js";

describe("paletteAffordance (CX-1)", () => {
  it("shows the ⌘K keycap on a wide layout", () => {
    const a = paletteAffordance(false);
    expect(a.content).toBe("⌘K");
    expect(a.label).toBe("Command palette");
    // The wide tooltip keeps the shortcut hint.
    expect(a.title).toMatch(/⌘K/);
    expect(a.variantClass).toBe("pill-kbd");
  });

  it("shows a hamburger 'Menu' affordance on narrow — no keyboard jargon", () => {
    const a = paletteAffordance(true);
    // A universal menu glyph, not the ⌘ keycap a touch user can't press.
    expect(a.content).toBe("☰");
    expect(a.content).not.toMatch(/⌘|K/);
    // The accessible name reads as "the menu," not a shortcut.
    expect(a.label).toBe("Menu");
    expect(a.label).not.toMatch(/⌘|palette/i);
    // Tooltip carries no keyboard jargon either.
    expect(a.title).not.toMatch(/⌘|palette/i);
    expect(a.variantClass).toBe("pill-menu");
  });
});
