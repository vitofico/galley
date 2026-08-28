import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * #19.2 Rail & Islands — floating-chrome layout guard (rubric R7).
 *
 * The shell's floating chrome (brand pill, actions pill, icon rail) must never
 * overlap the rendered page content, and the islands must not overlap each
 * other. Same class of guard as the zoom-toolbar check in authoring.spec.ts,
 * extended to the new chrome. Checked at the default width and at a tighter
 * mid width; the narrow morph's bottom tab pill is checked against the preview
 * page too.
 */

type Box = { x: number; y: number; width: number; height: number };

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * Clip `box` to `clip` (a scroll container's viewport): a bounding box reports
 * LAYOUT geometry, so a page taller than its scrolling pane would otherwise
 * "overlap" chrome it is visually clipped away from. Returns null when nothing
 * of the box is visible inside the clip.
 */
function clipBox(box: Box, clip: Box): Box | null {
  const x = Math.max(box.x, clip.x);
  const y = Math.max(box.y, clip.y);
  const right = Math.min(box.x + box.width, clip.x + clip.width);
  const bottom = Math.min(box.y + box.height, clip.y + clip.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

async function boxOf(
  page: import("@playwright/test").Page,
  selector: string,
): Promise<Box> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no bounding box for ${selector}`);
  return box;
}

async function settle(page: import("@playwright/test").Page) {
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.locator('[data-testid="preview"] svg').first()).toBeVisible();
}

test("R7: pills and rail never occlude the rendered page (wide + mid widths)", async ({
  page,
}) => {
  await gotoEditor(page);
  await settle(page);

  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 720 });
    // Re-measure after the viewport change settles.
    await expect(page.locator('[data-testid="preview"] svg').first()).toBeVisible();

    const rawPage = await boxOf(page, '[data-testid="preview"] svg');
    const previewBox = await boxOf(page, '[data-testid="preview"]');
    const pageBox = clipBox(rawPage, previewBox);
    if (!pageBox) throw new Error(`no visible page region at ${width}px`);
    const rail = await boxOf(page, ".icon-rail");
    const brand = await boxOf(page, ".brand-pill");
    const actions = await boxOf(page, ".actions-pill");

    // Floating chrome never overlaps the rendered page…
    expect(overlaps(rail, pageBox), `rail occludes the page at ${width}px`).toBe(false);
    expect(overlaps(brand, pageBox), `brand pill occludes the page at ${width}px`).toBe(false);
    expect(overlaps(actions, pageBox), `actions pill occludes the page at ${width}px`).toBe(false);

    // …and the islands never overlap each other.
    expect(overlaps(brand, actions), `pills overlap each other at ${width}px`).toBe(false);
    expect(overlaps(rail, brand), `rail overlaps the brand pill at ${width}px`).toBe(false);
    expect(overlaps(rail, actions), `rail overlaps the actions pill at ${width}px`).toBe(false);
  }
});

test("R7 narrow: the bottom tab pill never occludes the preview page", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 820 });
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // The narrow morph replaces the rail with the floating bottom tab pill.
  await expect(page.getByTestId("tab-bar")).toBeVisible();
  await expect(page.locator(".icon-rail")).toBeHidden();

  // Show the preview tab, then assert the tab pill sits clear of the page.
  await page.locator('[data-testid="tab"][data-tab="preview"]').click();
  await expect(page.locator('[data-testid="preview"] svg').first()).toBeVisible();

  // The page can be taller than its scrolling pane; only the VISIBLE region
  // (clipped to the .preview scroll viewport) can be occluded.
  const pageBox = await boxOf(page, '[data-testid="preview"] svg');
  const previewBox = await boxOf(page, '[data-testid="preview"]');
  const visiblePage = clipBox(pageBox, previewBox);
  if (!visiblePage) throw new Error("no visible page region to check");
  const tabBar = await boxOf(page, '[data-testid="tab-bar"]');
  expect(overlaps(tabBar, visiblePage), "bottom tab pill occludes the page").toBe(false);
});
