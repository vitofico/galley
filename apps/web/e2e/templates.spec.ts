import { test, expect } from "@playwright/test";
import { openFilesDock } from "./files-dock.js";

/**
 * New-from-template (roadmap #2) — the TemplatePicker is now on the Projects
 * page (library), not the editor. Every pick creates a BRAND-NEW project and
 * navigates to it; the current project is never touched.
 *
 * Tests cover: opening the picker from /library, picking the multi-file
 * "report" template (its /chapters/* files appear in the new project), picking
 * the Einstein flagship (new project, 1905 history), picking problem-set
 * (offline compile), and the blank / "Empty project" entry.
 */

/**
 * Picks a template from the Projects-page TemplatePicker and lands in the new
 * project. Returns after the picker closes and the editor compiles.
 */
async function pickTemplateFromLibrary(
  page: import("@playwright/test").Page,
  templateId: string,
) {
  await page.goto("/library");
  await expect(page.getByTestId("library")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("library-new-from-template").click();
  await expect(page.getByTestId("template-picker")).toBeVisible();

  await page.locator(`[data-testid="template-card"][data-template-id="${templateId}"]`).click();
  await page.getByTestId("template-pick").click();
}

test("templates: pick the report template → new project with its files appears and compiles", async ({
  page,
}) => {
  await pickTemplateFromLibrary(page, "report");

  // Navigated to a new project at /p/<id>.
  await expect(page).toHaveURL(/\/p\//, { timeout: 30_000 });
  await openFilesDock(page);

  // The report template's distinctive chapter files should be present.
  await expect(
    page.locator('[data-testid="project-file"][data-path="/chapters/introduction.typ"]'),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator('[data-testid="project-file"][data-path="/chapters/methods.typ"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="project-file"][data-path="/style.typ"]'),
  ).toBeVisible();

  // The whole project still compiles (the template uses no @preview packages).
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.locator('[data-testid="preview"] svg').first()).toBeVisible();
});

/**
 * Flagship as "New project from template" (project-model redesign §5): the
 * "Annus Mirabilis" demo creates a BRAND-NEW project (its own `/p/<id>`) with
 * the eight-file desk and four pre-dated 1905 versions.
 */
test("templates: the Einstein 1905 flagship entry creates a new project with the eight-file desk and 1905 history", async ({
  page,
}) => {
  await page.goto("/library");
  await expect(page.getByTestId("library")).toBeVisible({ timeout: 30_000 });

  // The flagship card leads the catalog; pick it.
  await page.getByTestId("library-new-from-template").click();
  await expect(page.getByTestId("template-picker")).toBeVisible();
  const flagship = page.locator('[data-testid="template-card"][data-template-id="einstein-1905"]');
  await expect(flagship).toBeVisible();
  await expect(flagship).toContainText("Einstein 1905 — demo workspace");
  await expect(flagship).toContainText("8 files");
  await flagship.click();
  await page.getByTestId("template-pick").click();

  // It created + opened a NEW project at /p/<id> with the full Einstein desk.
  await expect(page).toHaveURL(/\/p\//, { timeout: 30_000 });
  await openFilesDock(page);
  await expect(page.getByTestId("project-file")).toHaveCount(8, { timeout: 30_000 });
  await expect(
    page.locator('[data-testid="project-file"][data-path="/relativity.typ"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="project-file"][data-path="/refs.bib"]'),
  ).toBeVisible();
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // The new Einstein project carries exactly its four pre-dated 1905 versions.
  await page.getByTestId("history-button").click();
  await expect(page.getByTestId("history-overlay")).toBeVisible();
  await expect(page.getByTestId("history-version")).toHaveCount(4, { timeout: 30_000 });
});

/**
 * Breadth (#2): the catalog ships more than the original three. Pick the
 * multi-file "problem-set" template — it brings its own `/style.typ` (with the
 * problem/solution helpers) and exercises real math mode. The new project
 * compiles offline.
 */
test("templates: pick the problem-set template → new project with its files compiles", async ({
  page,
}) => {
  await pickTemplateFromLibrary(page, "problem-set");

  // Navigated to a new project at /p/<id>.
  await expect(page).toHaveURL(/\/p\//, { timeout: 30_000 });
  await openFilesDock(page);

  // The problem-set template's shared style file is present.
  await expect(
    page.locator('[data-testid="project-file"][data-path="/style.typ"]'),
  ).toBeVisible({ timeout: 30_000 });

  // The catalog picker shows "Universe packages" badge for none of the bundled templates.
  await page.goto("/library");
  await expect(page.getByTestId("library")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("library-new-from-template").click();
  await expect(page.getByTestId("template-picker")).toBeVisible();
  await expect(page.getByTestId("template-requires-packages")).toHaveCount(0);
  await page.getByTestId("template-cancel").click();
});

/**
 * Blank / start-from-scratch (B8): the catalog ships an "Empty project" card.
 * Picking it creates a new project seeded with the canonical blank starter — a
 * single `/main.typ` ("= Untitled / Start writing…") — so the editor boots on a
 * clean page (the card itself carries no files; the blank starter is supplied by
 * `blankSeed()`, never a dangling main).
 */
test("templates: pick the blank template → new project on the blank starter", async ({
  page,
}) => {
  await page.goto("/library");
  await expect(page.getByTestId("library")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("library-new-from-template").click();
  await expect(page.getByTestId("template-picker")).toBeVisible();

  // The blank card is present and reads "Empty project" rather than "0 files".
  const blank = page.locator('[data-testid="template-card"][data-template-id="blank"]');
  await expect(blank).toBeVisible();
  await expect(blank).toContainText("Empty project");

  await blank.click();
  await page.getByTestId("template-pick").click();

  // Navigated to a new project at /p/<id> and the editor settles on the starter.
  await expect(page).toHaveURL(/\/p\//, { timeout: 30_000 });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);
  // The blank starter is exactly one file — `/main.typ` with the Untitled stub.
  await expect(page.getByTestId("project-file")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator('[data-testid="editor"] .cm-content')).toContainText("Untitled");
});
