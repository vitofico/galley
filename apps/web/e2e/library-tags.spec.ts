import { test, expect } from "@playwright/test";
import { skipDemoSeed } from "./app-helpers.js";

/**
 * #12.4 library organize: tags + search + archive (soft-delete). Drives the real
 * `/library` dashboard over the browser `IdbProjectStore`, proving the metadata
 * (#12.2) round-trips and the filter controls work end to end. Each test starts
 * from a fresh browser context (no projects) per Playwright's default isolation,
 * with the one-time Einstein demo seed skipped so the counts are deterministic.
 */
test("tags, search, and archive organize the library (#12.4)", async ({ page }) => {
  await skipDemoSeed(page);
  await page.goto("/library");
  await expect(page.getByTestId("library")).toBeVisible();
  await expect(page.getByTestId("library-empty")).toBeVisible();

  // Create two projects (each via the "+" tile).
  await page.getByTestId("new-project-tile").click();
  await page.getByTestId("new-project-name").fill("Relativity");
  await page.getByTestId("create-project").click();
  await expect(page.getByTestId("project-card")).toHaveCount(1);
  await page.getByTestId("new-project-tile").click();
  await page.getByTestId("new-project-name").fill("Chemistry");
  await page.getByTestId("create-project").click();
  await expect(page.getByTestId("project-card")).toHaveCount(2);

  // Tag the Relativity card with "physics".
  const relCard = page.locator('[data-testid="project-card"][data-project-id]', { hasText: "Relativity" });
  await relCard.getByTestId("add-tag-input").fill("physics");
  await relCard.getByTestId("add-tag-input").press("Enter");
  await expect(relCard.getByTestId("project-tag")).toHaveText(/physics/);

  // The tag-filter row now offers "physics"; clicking it narrows to Relativity.
  await expect(page.getByTestId("tag-filter-chip")).toHaveCount(1);
  await page.getByTestId("tag-filter-chip").click();
  await expect(page.getByTestId("project-card")).toHaveCount(1);
  await expect(page.getByTestId("project-card")).toContainText("Relativity");
  // Clear the tag filter.
  await page.getByTestId("tag-filter-chip").click();
  await expect(page.getByTestId("project-card")).toHaveCount(2);

  // Search by name (case-insensitive) → only Chemistry.
  await page.getByTestId("library-search").fill("chem");
  await expect(page.getByTestId("project-card")).toHaveCount(1);
  await expect(page.getByTestId("project-card")).toContainText("Chemistry");
  await page.getByTestId("library-search").fill("");
  await expect(page.getByTestId("project-card")).toHaveCount(2);

  // Archive Chemistry → it disappears from the default view (soft-delete, not destroy).
  const chemCard = page.locator('[data-testid="project-card"][data-project-id]', { hasText: "Chemistry" });
  await chemCard.getByTestId("archive-project").click();
  await expect(page.getByTestId("project-card")).toHaveCount(1);
  await expect(page.getByTestId("project-card")).toContainText("Relativity");

  // Show archived → Chemistry returns, marked archived, with an Unarchive action.
  await page.getByTestId("show-archived").check();
  await expect(page.getByTestId("project-card")).toHaveCount(2);
  const archived = page.locator('[data-testid="project-card"][data-archived="true"]');
  await expect(archived).toHaveCount(1);
  await expect(archived).toContainText("Chemistry");
  await archived.getByTestId("archive-project").click(); // Unarchive
  await expect(page.locator('[data-testid="project-card"][data-archived="true"]')).toHaveCount(0);
});
