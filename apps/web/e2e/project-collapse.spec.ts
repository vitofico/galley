import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";
import { openFilesDock } from "./files-dock.js";

/**
 * R3 — closing the file list must NOT make the editor disappear. Originally a
 * guard for a SplitPanes track/child off-by-one; under the Rail & Islands
 * shell (#19.2) the file list is the rail's docked card, so the guard now
 * proves closing/reopening the dock leaves the editor tile intact.
 */
async function widthOf(page: import("@playwright/test").Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
}

test("project: closing the files dock keeps the editor visible", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  // The dock auto-collapses on a laptop boot; open it to establish the baseline
  // this guard closes from.
  await openFilesDock(page);

  const editorBefore = await widthOf(page, ".editor");
  expect(editorBefore).toBeGreaterThan(50);
  const filesBefore = await widthOf(page, ".project-files-pane");
  expect(filesBefore).toBeGreaterThan(50); // baseline: the files dock is open

  // Close the file dock from the rail.
  await page.getByTestId("rail-files").click();
  await expect(page.getByTestId("project-files")).toHaveCount(0);

  // The files card is gone, but the editor still occupies a real column.
  const editorAfter = await widthOf(page, ".editor");
  expect(editorAfter).toBeGreaterThan(50);

  // Reopening restores the file list.
  await page.getByTestId("rail-files").click();
  await expect(page.getByTestId("project-files")).toBeVisible();
});
