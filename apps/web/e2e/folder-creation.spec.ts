import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";
import { openFilesDock } from "./files-dock.js";

/**
 * Folder-creation UX. Folders are NOT a stored entity (ADR-0013): they are
 * DERIVED from the `/`-delimited file paths, so an EMPTY folder cannot exist.
 * "Create a folder" therefore materializes the folder's FIRST file — a starter
 * file under the new prefix — so the folder derives and renders in one step, with
 * that starter file selected and dropped straight into rename mode.
 *
 * This drives the real browser flow: type a folder name in the new-folder form,
 * submit, and assert the derived `project-folder` row renders with a starter file
 * inside it that is active and renamable. Then a per-folder "New subfolder…"
 * button nests a folder under the existing prefix. Finally a read-only viewer
 * gets NO new-folder affordance.
 */
test("project mode: create a folder via the new-folder form → derived folder + active renamable starter file", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);

  // Type a folder name and submit the new-folder form.
  await page.getByTestId("new-folder-path").fill("chapters");
  await page.getByTestId("add-folder").click();

  // The derived /chapters folder row appears…
  await expect(
    page.locator('[data-testid="project-folder"][data-path="/chapters"]'),
  ).toBeVisible();

  // …and its starter file is dropped straight into rename mode (active + the
  // inline rename input prefilled with the starter path).
  const renameInput = page.getByTestId("rename-input");
  await expect(renameInput).toBeVisible();
  await expect(renameInput).toHaveValue("/chapters/untitled.typ");

  // Commit the rename to a real name; the starter file lives under /chapters.
  await renameInput.fill("/chapters/intro.typ");
  await renameInput.press("Enter");
  await expect(
    page.locator('[data-testid="project-file"][data-path="/chapters/intro.typ"]'),
  ).toBeVisible();

  // The doc still compiles after the create (the starter is an empty file).
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 30_000 });
});

test("project mode: New subfolder button reveals an inline input that nests a folder under the existing prefix", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);

  // First create a /book folder via the form.
  await page.getByTestId("new-folder-path").fill("book");
  await page.getByTestId("add-folder").click();
  const bookFolder = page.locator('[data-testid="project-folder"][data-path="/book"]');
  await expect(bookFolder).toBeVisible();
  // Dismiss the auto-opened rename on the starter (Escape leaves it as-is).
  await page.getByTestId("rename-input").press("Escape");

  // The folder row's "New subfolder…" button reveals an INLINE input (no
  // window.prompt dialog) — auto-focused, prefilled empty.
  await bookFolder.getByTestId("new-subfolder").click();
  const subInput = page.getByTestId("new-subfolder-input");
  await expect(subInput).toBeVisible();
  await expect(subInput).toHaveValue("");

  // Type a name + Enter → a nested /book/part1 folder derives with its own
  // starter file, dropped straight into rename mode.
  await subInput.fill("part1");
  await subInput.press("Enter");
  await expect(
    page.locator('[data-testid="project-folder"][data-path="/book/part1"]'),
  ).toBeVisible();
  await expect(page.getByTestId("rename-input")).toHaveValue("/book/part1/untitled.typ");
  // The inline input is gone once committed.
  await expect(page.getByTestId("new-subfolder-input")).toHaveCount(0);
});

test("project mode: Escape cancels the inline New subfolder input with no change", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);

  // Create a /vol folder, then dismiss the auto-opened starter rename.
  await page.getByTestId("new-folder-path").fill("vol");
  await page.getByTestId("add-folder").click();
  const volFolder = page.locator('[data-testid="project-folder"][data-path="/vol"]');
  await expect(volFolder).toBeVisible();
  await page.getByTestId("rename-input").press("Escape");

  // Open the inline subfolder input, type a name, then press Escape to cancel.
  await volFolder.getByTestId("new-subfolder").click();
  const subInput = page.getByTestId("new-subfolder-input");
  await expect(subInput).toBeVisible();
  await subInput.fill("scrapped");
  await subInput.press("Escape");

  // The input closes and NO nested folder was created.
  await expect(page.getByTestId("new-subfolder-input")).toHaveCount(0);
  await expect(
    page.locator('[data-testid="project-folder"][data-path="/vol/scrapped"]'),
  ).toHaveCount(0);
});

test("a read-only viewer gets no new-folder affordance", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxV = await browser.newContext();
  try {
    // Host boots the seeded project and mints a VIEWER link (share.spec technique).
    const a = await ctxA.newPage();
    await gotoEditor(a);
    await expect(a.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
    await a.getByTestId("share-button").click();
    await expect(a.getByTestId("share-link")).toBeVisible({ timeout: 30_000 });
    await a.getByTestId("share-role-viewer").check();
    const viewerUrl = await a.getByTestId("share-link").inputValue();
    expect(new URL(viewerUrl).searchParams.get("role")).toBe("viewer");

    const v = await ctxV.newPage();
    await v.goto(viewerUrl);
    await expect(v.getByTestId("join-name-prompt")).toBeVisible({ timeout: 30_000 });
    await v.getByTestId("join-name-submit").click();
    await expect(v.getByTestId("open-library")).toBeVisible({ timeout: 30_000 });
    await openFilesDock(v);
    // Wait for the shared file tree to arrive.
    await expect(v.getByTestId("project-file").first()).toBeVisible({ timeout: 30_000 });

    // The viewer sees the structure but gets NO new-folder form (and no new-file
    // form either — both are viewer-gated).
    await expect(v.getByTestId("new-folder-path")).toHaveCount(0);
    await expect(v.getByTestId("add-folder")).toHaveCount(0);
    await expect(v.getByTestId("new-file-path")).toHaveCount(0);
  } finally {
    await ctxA.close();
    await ctxV.close();
  }
});
