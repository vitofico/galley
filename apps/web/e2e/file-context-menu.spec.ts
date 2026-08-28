import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { openFilesDock } from "./files-dock.js";

/**
 * The file tree re-renders when a recompile or save tick lands, which can
 * detach/move a row mid-action ("element is not stable" / "detached from the
 * DOM"). Re-resolve and retry the whole interaction until the menu is
 * actually open instead of trusting one click attempt.
 */
async function openContextMenu(page: Page, target: Locator): Promise<void> {
  await expect(async () => {
    await target.click({ button: "right", timeout: 5_000 });
    await expect(page.getByTestId("file-tree-menu")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * File-tree right-click context menu — a small `role="menu"` popover over the
 * SAME operations the tree rows already expose as buttons (set-main / rename /
 * delete for files; new-file / rename for folders). These exercise the real
 * browser flows: right-click → rename re-paths the file through the existing
 * inline-rename affordance; keyboard invocation (Shift+F10) with arrow
 * navigation, Escape close and focus return to the row; and the folder menu's
 * delete-free item set.
 */

test("right-click a file row → context menu → Rename drives the existing rename flow", async ({
  page,
}) => {
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);

  // Right-click the marginalia row: the menu opens anchored on it.
  const row = page.locator('[data-testid="project-file"][data-path="/marginalia.typ"]');
  await openContextMenu(page, row);
  const menu = page.getByTestId("file-tree-menu");
  // A non-main file offers all three row operations.
  await expect(menu.getByTestId("menu-set-main")).toBeVisible();
  await expect(menu.getByTestId("menu-rename-file")).toBeVisible();
  await expect(menu.getByTestId("menu-delete-file")).toBeVisible();

  // Rename reuses the row's EXISTING inline-rename input (same testid).
  await menu.getByTestId("menu-rename-file").click();
  await expect(menu).toHaveCount(0);
  const input = page.getByTestId("rename-input");
  await expect(input).toBeVisible();
  await input.fill("/notes/marginalia.typ");
  await input.press("Enter");

  // The file re-pathed into a derived folder — exactly the rename-button flow.
  await expect(
    page.locator('[data-testid="project-file"][data-path="/notes/marginalia.typ"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="project-file"][data-path="/marginalia.typ"]'),
  ).toHaveCount(0);
});

test("keyboard: Shift+F10 opens the menu, arrows navigate, Escape closes and returns focus", async ({
  page,
}) => {
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);

  // Focus a file row button, then invoke the menu from the keyboard.
  const row = page.locator('[data-testid="project-file"][data-path="/marginalia.typ"]');
  const menu = page.getByTestId("file-tree-menu");
  await expect(async () => {
    await row.click({ timeout: 5_000 });
    await expect(row).toBeFocused({ timeout: 2_000 });
    await page.keyboard.press("Shift+F10");
    await expect(menu).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  // Roving focus lands on the first item; ArrowDown moves, wrapping over items.
  await expect(menu.getByTestId("menu-set-main")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByTestId("menu-rename-file")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(menu.getByTestId("menu-set-main")).toBeFocused();

  // Escape closes the menu and returns focus to the row that opened it.
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(row).toBeFocused();
});

test("folder rows get their own menu (new file / rename), and outside click closes it", async ({
  page,
}) => {
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);

  // Derive a folder, let the recompile settle, then right-click it.
  await page.getByTestId("new-file-path").fill("/chapters/intro.typ");
  await page.getByTestId("add-file").click();
  const folder = page.locator('[data-testid="project-folder"][data-path="/chapters"]');
  await expect(folder).toBeVisible();
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 30_000 });
  await openContextMenu(page, folder);

  const menu = page.getByTestId("file-tree-menu");
  await expect(menu.getByTestId("menu-new-file-in-folder")).toBeVisible();
  await expect(menu.getByTestId("menu-rename-folder")).toBeVisible();
  // Folder menus never offer file ops.
  await expect(menu.getByTestId("menu-delete-file")).toHaveCount(0);

  // Rename-folder reuses the EXISTING inline folder-rename input.
  await menu.getByTestId("menu-rename-folder").click();
  await expect(page.getByTestId("rename-folder-input")).toBeVisible();
  await page.getByTestId("rename-folder-input").press("Escape");

  // Re-open, then an outside click dismisses without acting.
  await openContextMenu(page, folder);
  await page.getByTestId("status").click();
  await expect(menu).toHaveCount(0);
});
