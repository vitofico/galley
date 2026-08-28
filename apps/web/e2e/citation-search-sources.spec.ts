import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * Bibliography search sources — the Search tab carries a compact source selector
 * (Crossref / arXiv / OpenAlex / Semantic Scholar) in ONE strip, no extra tab.
 * This proves the selector actually routes the query to the chosen backend: we
 * stub ONLY api.openalex.org, switch the source to OpenAlex, and assert a result
 * row appears and inserts in one click. Crossref is intentionally left un-stubbed,
 * so a result can only come from the OpenAlex route firing. Offline + deterministic.
 */

const OPENALEX_ENVELOPE = {
  results: [
    {
      id: "https://openalex.org/W2741809807",
      doi: "https://doi.org/10.5555/attention",
      title: "Attention Is All You Need",
      publication_year: 2017,
      type: "article",
      authorships: [{ author: { display_name: "Ashish Vaswani" } }],
      primary_location: { source: { display_name: "NeurIPS" } },
    },
  ],
};

async function waitReady(page: import("@playwright/test").Page) {
  await expect(page.getByTestId("open-library")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
}

test("search source selector routes to OpenAlex and inserts a result", async ({ page }) => {
  await page.route(/api\.openalex\.org/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(OPENALEX_ENVELOPE),
    }),
  );

  await gotoEditor(page);
  await waitReady(page);

  await page.getByTestId("insert-button").click();
  await page.getByTestId("add-citation").click();
  await expect(page.getByTestId("citation-panel")).toBeVisible();

  await page.getByTestId("citation-mode-search").click();

  // The selector exposes every source; pick OpenAlex and confirm the button label
  // tracks the choice (so the user always knows what they're searching).
  await expect(page.getByTestId("citation-search-source")).toBeVisible();
  await page.getByTestId("citation-search-source-openalex").click();
  await expect(page.getByTestId("citation-search-run")).toHaveText("Search OpenAlex");

  await page.getByTestId("citation-search-input").fill("attention is all you need");
  await page.getByTestId("citation-search-run").click();

  // A result row can only appear if the OpenAlex route fired (Crossref is unstubbed).
  await expect(page.getByTestId("citation-search-list")).toBeVisible({ timeout: 30_000 });
  const insert = page.locator('[data-testid^="citation-search-insert-"]').first();
  await expect(insert).toBeVisible();
  await insert.click();

  // The panel closes only when the in-text cite was actually inserted.
  await expect(page.getByTestId("citation-panel")).toBeHidden({ timeout: 10_000 });
});

test("switching the search source clears the previous source's results", async ({ page }) => {
  await page.route(/api\.openalex\.org/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(OPENALEX_ENVELOPE),
    }),
  );

  await gotoEditor(page);
  await waitReady(page);
  await page.getByTestId("insert-button").click();
  await page.getByTestId("add-citation").click();
  await page.getByTestId("citation-mode-search").click();

  await page.getByTestId("citation-search-source-openalex").click();
  await page.getByTestId("citation-search-input").fill("attention");
  await page.getByTestId("citation-search-run").click();
  await expect(page.getByTestId("citation-search-list")).toBeVisible({ timeout: 30_000 });

  // Switching to another source must drop the stale list (so OpenAlex hits never
  // sit under a Crossref header) and reset the run button to the new source.
  await page.getByTestId("citation-search-source-crossref").click();
  await expect(page.getByTestId("citation-search-list")).toBeHidden();
  await expect(page.getByTestId("citation-search-run")).toHaveText("Search Crossref");
});

test("a failed search surfaces a source-aware error (OpenAlex rate limit)", async ({ page }) => {
  await page.route(/api\.openalex\.org/, (route) =>
    route.fulfill({ status: 429, contentType: "application/json", body: "{}" }),
  );

  await gotoEditor(page);
  await waitReady(page);
  await page.getByTestId("insert-button").click();
  await page.getByTestId("add-citation").click();
  await page.getByTestId("citation-mode-search").click();

  await page.getByTestId("citation-search-source-openalex").click();
  await page.getByTestId("citation-search-input").fill("attention");
  await page.getByTestId("citation-search-run").click();

  // The error names the SELECTED source (not a hardcoded "Crossref").
  const err = page.getByTestId("citation-search-error");
  await expect(err).toBeVisible({ timeout: 30_000 });
  await expect(err).toContainText("OpenAlex");
});
