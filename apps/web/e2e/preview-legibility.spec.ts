import { test, expect } from "@playwright/test";
import { openFilesDock } from "./files-dock.js";

/**
 * Preview legibility on a laptop (#preview-legibility).
 *
 * The compiled page is an SVG sized to physical CSS px (A5 = 560px wide). With
 * `max-width: 100%` it is shrunk to fit its pane, so when the pane is narrower
 * than 560px the page — and all its text — renders BELOW physical size. On a
 * laptop (the e2e viewport is 1280px) the Files dock (a 304px tile) plus the
 * agent panel once squeezed the preview to ~320px → text rendered at ~57% (≈8px),
 * the reported "preview text is small".
 *
 * Two guards, matching the shipped fix:
 *  1. The Files dock auto-collapses on a fresh laptop boot, so the preview boots
 *     wide enough to render its page at (near) physical size.
 *  2. That choice is overridable and sticky: opening Files is remembered across
 *     a reload, and the rebalanced default weights keep the agent panel intact.
 */

/** Effective render scale of the page = on-screen width ÷ physical (viewBox) px. */
async function pageScale(page: import("@playwright/test").Page): Promise<number> {
  return page.locator('[data-testid="preview"] svg').first().evaluate((el) => {
    const svg = el as unknown as SVGSVGElement;
    const onScreen = svg.getBoundingClientRect().width;
    const physical = svg.viewBox.baseVal.width * (96 / 72);
    return physical > 0 ? onScreen / physical : 0;
  });
}

test("laptop fresh boot: Files dock auto-collapses so the page renders near physical size", async ({
  page,
}) => {
  // The chromium project is Desktop Chrome (1280px) — the laptop band.
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await page.waitForSelector('[data-testid="preview"] svg');

  // The file tree is NOT shown on a fresh laptop boot (auto-collapsed).
  await expect(page.getByTestId("project-file").first()).toBeHidden();

  // The page renders at (near) physical size — the bug shrank it to ~0.57.
  expect(await pageScale(page)).toBeGreaterThan(0.9);

  // The agent panel is still present (its share was not stolen for the preview).
  await expect(page.getByTestId("agent-send")).toBeVisible();
});

test("Files stays reachable and an explicit open is remembered across a reload", async ({
  page,
}) => {
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // One rail click opens the dock; the file tree is one click away.
  await openFilesDock(page);
  await expect(page.getByTestId("project-file").first()).toBeVisible();

  // The explicit choice survives a reload (overrides the laptop auto-collapse).
  await page.reload();
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.getByTestId("project-file").first()).toBeVisible();
});
