import { describe, it, expect } from "vitest";
import { DARK_SYNTAX_COLORS, ON_AGENT_DARK, AGENT_FILL_DARK } from "./typst-highlight.js";

/**
 * Durable WCAG AA contrast guard for the DARK ("press") theme (#11.6 / R6).
 *
 * The Typst syntax palette and the agent Send button are themed via CSS custom
 * properties: the LIGHT values live on `:root` in styles.css, the DARK overrides
 * in theme.css. This test pins the DARK values (exported alongside the highlight
 * style so they cannot silently drift from the CSS) and asserts each clears the
 * AA body-text floor (4.5:1) against the surface it actually sits on.
 *
 * Background: the editor's dark ground is the raised-surface charcoal
 * `--paper-raised: #17181b`. (CodeMirror's `.cm-scroller` paints on the editor
 * surface, which is the raised paper, not the deepest `--paper`.)
 */

/** WCAG relative luminance of an `#rrggbb` color. */
function relativeLuminance(hex: string): number {
  const c = hex.replace("#", "");
  const chan = (i: number) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(0) + 0.7152 * chan(2) + 0.0722 * chan(4);
}

/** WCAG contrast ratio between two `#rrggbb` colors (>= 1). */
function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** The editor's dark raised-paper ground (theme.css `--paper-raised`). */
const DARK_GROUND = "#17181b";

/** AA contrast floor for normal-size text/code tokens. */
const AA = 4.5;

describe("dark-theme contrast — WCAG AA (R6)", () => {
  it("sanity-checks the contrast helper against known WCAG pairs", () => {
    // Pure black on pure white is the canonical 21:1.
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    // Identical colors are 1:1.
    expect(contrastRatio("#232019", "#232019")).toBeCloseTo(1, 5);
  });

  for (const [token, color] of Object.entries(DARK_SYNTAX_COLORS)) {
    it(`syntax token "${token}" (${color}) clears AA on the dark ground`, () => {
      const ratio = contrastRatio(color, DARK_GROUND);
      expect(ratio).toBeGreaterThanOrEqual(AA);
    });
  }

  it("agent Send label clears AA on the agent fill (R6 — finding 1)", () => {
    // White-on-teal was 2.40:1; the on-agent ink token must clear AA.
    const ratio = contrastRatio(ON_AGENT_DARK, AGENT_FILL_DARK);
    expect(ratio).toBeGreaterThanOrEqual(AA);
  });

  it("keeps the warm and teal token families visually distinct (no hue collapse)", () => {
    // Heading (amber) vs keyword (coral) vs function (teal) vs string (sage)
    // must not be the same color — a regression that collapses them would
    // still pass the AA loop above, so guard distinctness explicitly.
    const distinct = new Set([
      DARK_SYNTAX_COLORS.heading,
      DARK_SYNTAX_COLORS.keyword,
      DARK_SYNTAX_COLORS.function,
      DARK_SYNTAX_COLORS.string,
    ]);
    expect(distinct.size).toBe(4);
  });
});
