import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dirname, "components");

// Brand-family hexes that MUST NOT appear hardcoded in component CSS — they
// break a skin swap. Allowed only in styles.css/theme.css (the token layer).
// Covers BOTH skins' accent fills so a hardcoded color can't survive a swap in
// either direction: Studio tangerine (f0510e/ad4b00/ff6a3d/ff9170/fdeae0) AND
// Press gold (e8b04b accent, c9912f/8a5a12 accent-deep, f6ead0 accent-soft).
const FORBIDDEN = /#(f0510e|ad4b00|ff6a3d|ff9170|fdeae0|e8b04b|c9912f|8a5a12|f6ead0)\b/i;

const CSS_FILES = readdirSync(DIR).filter((n) => n.endsWith(".css"));

describe("skin discipline: no brand literals in component CSS", () => {
  // Guard against a vacuous pass if the directory is ever renamed/emptied.
  it("scans a non-empty set of component stylesheets", () => {
    expect(CSS_FILES.length).toBeGreaterThan(0);
  });

  for (const f of CSS_FILES) {
    it(`${f} uses tokens, not brand hexes`, () => {
      const css = readFileSync(join(DIR, f), "utf8");
      const hit = css.match(FORBIDDEN);
      expect(hit, `found ${hit?.[0]} in ${f} — use var(--accent…) instead`).toBeNull();
    });
  }
});
