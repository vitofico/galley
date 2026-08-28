import { test, expect } from "@playwright/test";
import { openFilesDock } from "./files-dock.js";

/**
 * Author-attributed versioning (#11) — each saved version records WHO contributed
 * to the project state it captures. v1 semantics: the distinct registered authors
 * at snapshot time, formatted with the shared `authorLabel`.
 *
 * Solo assertion only: in a fresh local project there is exactly one peer (the
 * local human author, with no display name → "Editor"), so a manual snapshot's
 * row must surface that single contributor. Multi-peer attribution is covered by
 * the collab specs; here we just prove the snapshot path captures and the panel
 * shows it.
 */

async function bootProject(page: import("@playwright/test").Page) {
  await page.goto("/?seed=einstein");
  await openFilesDock(page);
  await expect(page.getByTestId("project-file").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="editor"] .cm-content')).toContainText(
    "Annus Mirabilis",
    { timeout: 60_000 },
  );
}

test("#11 a manual snapshot in a solo project records the local author as a contributor", async ({
  page,
}) => {
  await bootProject(page);

  // Make at least one attributed edit so the local author is registered + present.
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.type(" attributed edit");

  // Open history and take a manual snapshot.
  await page.getByTestId("history-button").click();
  await expect(page.getByTestId("history-overlay")).toBeVisible();
  await page.getByTestId("save-version-name").fill("attributed v1");
  await page.getByTestId("save-version").click();

  // The new version row appears with a contributors line naming the local author.
  const row = page
    .getByTestId("history-version")
    .filter({ hasText: "attributed v1" })
    .first();
  await expect(row).toBeVisible();
  const contributors = row.getByTestId("version-contributors");
  await expect(contributors).toBeVisible();
  // The solo local human author has no display name → "Editor".
  await expect(contributors).toContainText("by");
  await expect(contributors).toContainText("Editor");
});
