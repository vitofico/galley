import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * #6 search-your-library — an imported reference library can be FILTERED in place
 * and a row inserted (cite + bibliography) in one click, the same affordance the
 * literature-search rows offer. Fully offline (a pasted BibTeX library), so no
 * network stub is needed.
 */

const LIBRARY = [
  "@article{vaswani2017, title={Attention Is All You Need}, author={Vaswani, Ashish}, year={2017}}",
  "@book{doe2020, title={A Study of Things}, author={Doe, Jane}, year={2020}}",
].join("\n");

async function openLibraryWithEntries(page: import("@playwright/test").Page) {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  await page.getByTestId("insert-button").click();
  await page.getByTestId("add-citation").click();
  await expect(page.getByTestId("citation-panel")).toBeVisible();

  await page.getByTestId("citation-mode-library").click();
  await page.getByTestId("citation-library-input").fill(LIBRARY);
  await page.getByTestId("citation-library-parse").click();
  await expect(page.getByTestId("citation-library-list")).toBeVisible();
}

test("#6 library: filter narrows the rows, and a non-match shows an empty note", async ({
  page,
}) => {
  await openLibraryWithEntries(page);

  // Both parsed entries are listed.
  await expect(page.locator('[data-testid^="citation-library-row-"]')).toHaveCount(2);

  // Filtering by a title term narrows to the one matching row.
  await page.getByTestId("citation-library-filter").fill("attention");
  await expect(page.locator('[data-testid^="citation-library-row-"]')).toHaveCount(1);

  // A term that matches nothing surfaces the empty note (and no rows).
  await page.getByTestId("citation-library-filter").fill("zzz-nothing");
  await expect(page.getByTestId("citation-library-no-matches")).toBeVisible();
  await expect(page.locator('[data-testid^="citation-library-row-"]')).toHaveCount(0);
});

test("#6 library: Insert cites a row in one click and closes the panel", async ({ page }) => {
  await openLibraryWithEntries(page);

  await page.getByTestId("citation-library-filter").fill("attention");
  const insert = page.locator('[data-testid^="citation-library-insert-"]').first();
  await expect(insert).toBeVisible();
  await insert.click();

  // The panel closes only when the in-text cite was actually inserted.
  await expect(page.getByTestId("citation-panel")).toBeHidden({ timeout: 10_000 });
});
