import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * R4 — from inside a project the library is reachable in one click, and a project
 * can be opened from it. Round-trip: default editor → open library → open a project.
 */
test("nav: editor → library → open a project", async ({ page }) => {
  // The default route boots the persistent project AND registers it in the library.
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // One persistent header control reaches the library.
  await page.getByTestId("open-library").click();
  await expect(page.getByTestId("library")).toBeVisible({ timeout: 30_000 });

  // The persistent project is listed; opening it returns to the editor.
  await expect(page.getByTestId("project-card").first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("open-project").first().click();
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
});
