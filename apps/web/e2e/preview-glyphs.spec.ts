import { test, expect } from "@playwright/test";

/**
 * Regression for the white/faint preview (2026-06-16): typst.ts paints VISIBLE
 * text by baking each glyph outline into `<defs>` and instancing it with
 * `<use href="#glyphId">` (10k+ per page). The SVG sanitizer (`sanitize-svg.ts`)
 * was stripping EVERY `<use>` — the outlines stayed orphaned in `<defs>` and
 * nothing painted, so only the faint `<foreignObject>` selection overlay showed
 * (while PDF export, which skips this path, looked fine). The earlier sanitizer
 * tests only proved the `<foreignObject>` overlay survived — never the glyph
 * layer. This asserts the glyph-instancing layer reaches the rendered preview,
 * so a sanitizer that drops `<use>` can never ship invisible text again.
 */
test("preview paints glyphs — the <use> instancing layer survives sanitization", async ({
  page,
}) => {
  // The 1905 demo is a rich, deterministic document (thousands of glyph uses).
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.locator('[data-testid="preview"] svg').first()).toBeVisible();

  // The visible glyphs are `<use>` instances of `<defs>` outlines. If the
  // sanitizer strips them, this collapses to 0 and the page renders blank.
  const uses = page.locator('[data-testid="preview"] svg use');
  await expect.poll(() => uses.count(), { timeout: 30_000 }).toBeGreaterThan(100);

  // And the first instance must resolve to a real outline (a `<path d=…>` in defs)
  // — a `<use>` pointing at nothing would paint just as blank.
  const resolves = await page.evaluate(() => {
    const svg = document.querySelector('[data-testid="preview"] svg');
    const use = svg?.querySelector("use");
    const href = use?.getAttribute("href") || use?.getAttribute("xlink:href");
    if (!href || !href.startsWith("#")) return false;
    const target = svg?.querySelector(`[id="${href.slice(1)}"]`);
    return !!target && (target.getAttribute("d") || "").length > 0;
  });
  expect(resolves).toBe(true);
});

/**
 * Regression for the "tiny / mis-spaced body text" report (2026-06-17): typst.ts
 * emits a per-text-run SELECTION layer inside each `<foreignObject>` as a
 * namespaced `<h5:div class="tsel">` whose `.tsel { color: transparent }` keeps
 * it invisible — the VISIBLE text is the vector `<use>` glyph layer beneath it.
 * The XSS sanitizer strips that namespaced wrapper (keeping its bare text), so
 * the orphaned text lost its `.tsel` class, inherited the ink color, and painted
 * OPAQUE in the browser's fallback sans-serif (browser-justified, wrong leading)
 * ON TOP of the real glyphs — tiny, spread-out body text the correct PDF export
 * never shows. We re-assert the transparency on the `<foreignObject>` itself, so
 * the selection layer can never paint over the glyphs again.
 */
test("preview selection overlay stays transparent — no opaque text over the glyphs", async ({
  page,
}) => {
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.locator('[data-testid="preview"] svg').first()).toBeVisible();

  // Every foreignObject text run must compute to a fully transparent color, so
  // only the <use> glyph layer is visible. An opaque (alpha ≠ 0) run is the bug.
  const opaqueRuns = await page.evaluate(() => {
    const fos = Array.from(
      document.querySelectorAll('[data-testid="preview"] svg foreignObject'),
    );
    const isTransparent = (c: string) =>
      c === "transparent" || /rgba?\([^)]*,\s*0\s*\)$/.test(c.replace(/\s+/g, " "));
    return fos.filter((fo) => !isTransparent(getComputedStyle(fo).color)).length;
  });
  expect(opaqueRuns).toBe(0);
});
