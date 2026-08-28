import { test, expect } from "@playwright/test";
import { openFilesDock } from "./files-dock.js";

/**
 * #12 folders — the file list renders as a NESTED folder tree DERIVED from the
 * `/`-delimited file paths (ADR-0013: folders are not a stored entity). This
 * exercises the real browser flow end-to-end: create files under a `/chapters`
 * prefix, see the derived folder appear, collapse/expand it (ephemeral view
 * state), then RENAME the folder — which re-paths every file under it through the
 * existing `project.rename` primitive in one transaction. The set-main pointer
 * and compile survive the re-path because files are keyed by fileId, never
 * deleted+recreated.
 */
test("project mode: folders derive from paths, collapse/expand, and rename re-paths files", async ({
  page,
}) => {
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);
  await expect(page.getByTestId("project-file")).toHaveCount(8);

  // Create two files under /chapters and one at root.
  await page.getByTestId("new-file-path").fill("/chapters/intro.typ");
  await page.getByTestId("add-file").click();
  await page.getByTestId("new-file-path").fill("/chapters/method.typ");
  await page.getByTestId("add-file").click();
  await page.getByTestId("new-file-path").fill("/appendix.typ");
  await page.getByTestId("add-file").click();
  await expect(page.getByTestId("project-file")).toHaveCount(11);

  // A derived /chapters folder appears, containing both chapter files.
  const folder = page.locator('[data-testid="project-folder"][data-path="/chapters"]');
  await expect(folder).toBeVisible();
  await expect(
    page.locator('[data-testid="project-file"][data-path="/chapters/intro.typ"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="project-file"][data-path="/chapters/method.typ"]'),
  ).toBeVisible();

  // Collapse the folder — its files hide (the toggle is the folder button).
  await folder.getByRole("button", { name: /collapse folder chapters/i }).click();
  await expect(
    page.locator('[data-testid="project-file"][data-path="/chapters/intro.typ"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-testid="project-file"][data-path="/chapters/method.typ"]'),
  ).toHaveCount(0);
  // The root file stays visible — only the folder's subtree collapsed.
  await expect(
    page.locator('[data-testid="project-file"][data-path="/appendix.typ"]'),
  ).toBeVisible();

  // Expand — the files reappear.
  await folder.getByRole("button", { name: /expand folder chapters/i }).click();
  await expect(
    page.locator('[data-testid="project-file"][data-path="/chapters/intro.typ"]'),
  ).toBeVisible();

  // Make a file inside the folder the main file, so we can prove the pointer
  // survives the folder rename (keyed by fileId, not path).
  await page.locator('[data-testid="set-main"][data-path="/chapters/intro.typ"]').click();
  await expect(
    page.locator(
      '[data-testid="project-file"][data-path="/chapters/intro.typ"] .project-file-main',
    ),
  ).toBeVisible();

  // Rename the folder /chapters -> /parts via its inline rename control.
  await page.locator('[data-testid="rename-folder"][data-path="/chapters"]').click();
  const folderInput = page.getByTestId("rename-folder-input");
  await folderInput.fill("/parts");
  await folderInput.press("Enter");

  // Both files re-path under the new prefix; the old paths are gone.
  await expect(
    page.locator('[data-testid="project-file"][data-path="/parts/intro.typ"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="project-file"][data-path="/parts/method.typ"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="project-file"][data-path="/chapters/intro.typ"]'),
  ).toHaveCount(0);

  // The set-main pointer followed the file across the re-path (★ still on it).
  await expect(
    page.locator('[data-testid="project-file"][data-path="/parts/intro.typ"] .project-file-main'),
  ).toBeVisible();

  // The renamed folder still exists under its new prefix, and the doc still
  // compiles (status shows a page count, not an error).
  await expect(
    page.locator('[data-testid="project-folder"][data-path="/parts"]'),
  ).toBeVisible();
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 30_000 });
});

/**
 * Move a file BY RENAME: the per-file rename already accepts a full path, so
 * typing a folder prefix moves the file into (a derived) folder. Drag-and-drop
 * is intentionally deferred — move-by-rename is the supported affordance.
 */
test("project mode: move a file into a folder via per-file rename", async ({ page }) => {
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);

  // marginalia.typ lives at root; rename it under a /notes prefix to move it.
  await page.locator('[data-testid="rename-file"][data-path="/marginalia.typ"]').click();
  await page.getByTestId("rename-input").fill("/notes/marginalia.typ");
  await page.getByTestId("rename-input").press("Enter");

  // It now lives under a derived /notes folder.
  await expect(
    page.locator('[data-testid="project-folder"][data-path="/notes"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="project-file"][data-path="/notes/marginalia.typ"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="project-file"][data-path="/marginalia.typ"]'),
  ).toHaveCount(0);
});

/**
 * Escape must CANCEL an inline rename — not apply it. Escape clears the renaming
 * state, which unmounts the input and fires its trailing onBlur; without a guard
 * that blur re-commits the edited draft, applying the rename the user cancelled.
 */
test("project mode: Escape cancels a file rename (the trailing blur must not apply it)", async ({
  page,
}) => {
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);

  await page.locator('[data-testid="rename-file"][data-path="/marginalia.typ"]').click();
  await page.getByTestId("rename-input").fill("/renamed.typ");
  await page.getByTestId("rename-input").press("Escape");

  // Input closes and the file KEEPS its original path; the cancelled draft never lands.
  await expect(page.getByTestId("rename-input")).toHaveCount(0);
  await expect(
    page.locator('[data-testid="project-file"][data-path="/marginalia.typ"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="project-file"][data-path="/renamed.typ"]'),
  ).toHaveCount(0);
});

test("project mode: Escape cancels a folder rename (no re-path of files under the prefix)", async ({
  page,
}) => {
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);

  // Derive a /chapters folder by adding a file under that prefix.
  await page.getByTestId("new-file-path").fill("/chapters/intro.typ");
  await page.getByTestId("add-file").click();
  await expect(
    page.locator('[data-testid="project-folder"][data-path="/chapters"]'),
  ).toBeVisible();

  // Begin renaming the folder, type a new prefix, then cancel with Escape.
  await page.locator('[data-testid="rename-folder"][data-path="/chapters"]').click();
  const folderInput = page.getByTestId("rename-folder-input");
  await folderInput.fill("/parts");
  await folderInput.press("Escape");

  // The folder keeps its original prefix; the cancelled rename re-paths nothing,
  // so the file under it stays put (the trailing blur must not commit).
  await expect(page.getByTestId("rename-folder-input")).toHaveCount(0);
  await expect(
    page.locator('[data-testid="project-folder"][data-path="/chapters"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="project-folder"][data-path="/parts"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-testid="project-file"][data-path="/chapters/intro.typ"]'),
  ).toBeVisible();
});
