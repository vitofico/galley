import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";
import { openFilesDock } from "./files-dock.js";

/**
 * Roadmap #11.1 — resizable & collapsible panes. Drives the real shell in a
 * browser: a splitter drag resizes adjacent panes, double-click resets, the
 * agent sidebar collapses/expands, and the layout (sizes + collapsed flags)
 * survives a reload via localStorage. The project shell (the default `/`) gets a
 * cheap collapse + persistence check too.
 */

const PANES_KEY = "galley.panes.v1";

/** The computed pixel width of a pane, read from the live grid. */
async function paneWidth(page: import("@playwright/test").Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
}

test("single-file: drag resizes panes, double-click resets, and it persists", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Three panes, two splitters between them.
  const splitters = page.getByTestId("splitter");
  await expect(splitters).toHaveCount(2);

  const editorBefore = await paneWidth(page, ".editor");
  const centerBefore = await paneWidth(page, ".center");

  // Drag the editor|center splitter ~160px to the right: editor grows, center shrinks.
  const joint = page.locator('[data-testid="splitter"][data-left="editor"]');
  const box = await joint.boundingBox();
  if (!box) throw new Error("splitter has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  const editorAfter = await paneWidth(page, ".editor");
  const centerAfter = await paneWidth(page, ".center");
  expect(editorAfter).toBeGreaterThan(editorBefore + 60);
  expect(centerAfter).toBeLessThan(centerBefore - 60);

  // It persisted to localStorage.
  const stored = await page.evaluate((k) => localStorage.getItem(k), PANES_KEY);
  expect(stored).toContain("editor");

  // Reload: the dragged width is restored (within a few px of the pre-reload value).
  await page.reload();
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  const editorRestored = await paneWidth(page, ".editor");
  expect(Math.abs(editorRestored - editorAfter)).toBeLessThan(8);

  // Double-click a splitter resets to defaults (editor back near its original width).
  await page.locator('[data-testid="splitter"][data-left="editor"]').dblclick();
  const editorReset = await paneWidth(page, ".editor");
  expect(Math.abs(editorReset - editorBefore)).toBeLessThan(8);
});

test("project shell: the agent sidebar collapses and re-expands from the rail", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  const sidebar = page.locator(".sidebar");
  await expect(page.getByTestId("agent-panel")).toBeVisible();
  await expect(sidebar).not.toHaveAttribute("aria-hidden", "true");

  // Collapse from the agent pane's own control → the pane is hidden.
  await page.getByTestId("collapse-sidebar").click();
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");

  // Re-expand from the rail's agent toggle (sidebar collapse is ephemeral view
  // state in the project shell, so there is no persisted-across-reload step).
  await page.getByTestId("rail-agent").click();
  await expect(sidebar).not.toHaveAttribute("aria-hidden", "true");
  await expect(page.getByTestId("agent-panel")).toBeVisible();
});

test("project shell: file dock closes + persists, with all panes present", async ({ page }) => {
  // #19.2 Rail & Islands: the file list is the rail's docked card; editor/
  // preview/agent stay SplitPanes tiles (3 panes → 2 splitters). The rail's
  // Files icon toggles the dock and an explicit choice persists across reload.
  await gotoEditor(page);
  await expect(page.getByTestId("open-library")).toBeVisible();
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Three tiled panes => two splitters. On a laptop boot the dock auto-collapses
  // for preview legibility, so open it explicitly to verify the open baseline.
  await expect(page.getByTestId("splitter")).toHaveCount(2);
  await openFilesDock(page);
  await expect(page.getByTestId("project-files")).toBeVisible();

  // Close the file dock from the rail.
  await page.getByTestId("rail-files").click();
  await expect(page.getByTestId("project-files")).toHaveCount(0);

  // The explicit close persists across reload (overriding any width default).
  await page.reload();
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.getByTestId("project-files")).toHaveCount(0);

  // Reopening from the rail restores it.
  await page.getByTestId("rail-files").click();
  await expect(page.getByTestId("project-files")).toBeVisible();
  expect(await paneWidth(page, ".project-files-pane")).toBeGreaterThan(20);
});
