/**
 * CX-1 — how the command-palette trigger pill presents itself.
 *
 * On a WIDE (desktop) layout the pill reads "⌘K": a keycap that tells a
 * keyboard user the shortcut and reads as "the command menu." On a NARROW
 * (touch) layout that's jargon — there is no ⌘ key, and "⌘K" doesn't read as
 * "the menu" to a tap-only user, so the palette (which on narrow is the ONLY way
 * to reach the rail commands) goes unrecognized. Narrow therefore gets a
 * universal hamburger ☰ with an explicit "Menu" accessible name and tooltip.
 *
 * Same button, same testid, same action — only the affordance (glyph + label)
 * changes with the layout. Pure so the mapping is unit-pinned.
 */
export interface PaletteAffordance {
  /** Visible glyph/text inside the button. */
  readonly content: string;
  /** Accessible name (aria-label). */
  readonly label: string;
  /** Tooltip text — keeps the shortcut hint on wide, mirrors the label on narrow. */
  readonly title: string;
  /** Extra class beyond `pill-icon-btn` — keycap styling only on wide. */
  readonly variantClass: string;
}

export function paletteAffordance(narrow: boolean): PaletteAffordance {
  return narrow
    ? { content: "☰", label: "Menu", title: "Menu", variantClass: "pill-menu" }
    : {
        content: "⌘K",
        label: "Command palette",
        title: "Command palette (⌘K)",
        variantClass: "pill-kbd",
      };
}
