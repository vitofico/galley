import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * R1 — the rendered document page is paper-white in EVERY theme. Regression guard
 * for the dark-mode bug where the page background was a theme-tinted charcoal and
 * the black Typst text became invisible.
 *
 * Verified empirically: Typst's emitted SVG paints no page-fill rect — the CSS
 * background on the <svg> IS the page color (this assertion went 31→249 across the fix),
 * so --doc-paper is the real mechanism, not a fallback.
 */
test("dark mode: the document page renders on light paper", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Force the dark theme directly on the DOM (source of truth for the CSS).
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));

  // The page background must be light (near-white), not a dark charcoal.
  const svg = page.locator(".preview-page svg").first();
  await expect(svg).toBeVisible();
  const bg = await svg.evaluate((el) => getComputedStyle(el).backgroundColor);
  const channels = bg.match(/\d+/g)?.map(Number) ?? [];
  expect(channels.length).toBeGreaterThanOrEqual(3);
  // Every RGB channel is high → the page is paper, not press-charcoal.
  expect(Math.min(channels[0], channels[1], channels[2])).toBeGreaterThan(200);
});
