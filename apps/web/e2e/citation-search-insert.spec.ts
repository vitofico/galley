import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * #6 search-insert — a literature-search result can be inserted into the document
 * (cite + bibliography) in one click, or stocked into the bibliography without
 * citing, straight from the result row (no "Review → paste" detour).
 *
 * Crossref is stubbed via page.route so the search is deterministic and offline.
 * This also guards the once-latent unbound-`fetch` bug: the app must hand the
 * search helper a bound fetch, or the request never fires (phantom "network"
 * error) — exercised here by actually running a search end to end (wave-12's
 * e2e only checked the tab was reachable). We don't assert an exact cite-key —
 * rows are targeted by their testid PREFIX so the test survives keying changes.
 */

const CROSSREF_ENVELOPE = {
  message: {
    items: [
      {
        title: ["Attention Is All You Need"],
        author: [{ family: "Vaswani", given: "Ashish" }],
        issued: { "date-parts": [[2017]] },
        DOI: "10.5555/attention",
      },
    ],
  },
};

async function waitReady(page: import("@playwright/test").Page) {
  await expect(page.getByTestId("open-library")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
}

async function openSearchWithStubbedResult(page: import("@playwright/test").Page) {
  await page.route(/api\.crossref\.org/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(CROSSREF_ENVELOPE),
    }),
  );

  await gotoEditor(page);
  await waitReady(page);

  await page.getByTestId("insert-button").click();
  await page.getByTestId("add-citation").click();
  await expect(page.getByTestId("citation-panel")).toBeVisible();

  await page.getByTestId("citation-mode-search").click();
  await page.getByTestId("citation-search-input").fill("attention is all you need");
  await page.getByTestId("citation-search-run").click();

  await expect(page.getByTestId("citation-search-list")).toBeVisible({ timeout: 30_000 });
}

test("#6 search-insert: a result inserts in one click and closes the panel", async ({ page }) => {
  await openSearchWithStubbedResult(page);

  // The headline affordance: an "Insert" button directly on the result row.
  const insert = page.locator('[data-testid^="citation-search-insert-"]').first();
  await expect(insert).toBeVisible();
  await insert.click();

  // The panel only closes when the in-text cite was actually inserted (onInsert
  // returned true), so a closed panel proves the search → cite path ran.
  await expect(page.getByTestId("citation-panel")).toBeHidden({ timeout: 10_000 });
});

test("#6 search-insert: 'Add to bib' stocks the bibliography and shows a done-state", async ({
  page,
}) => {
  await openSearchWithStubbedResult(page);

  const add = page.locator('[data-testid^="citation-search-add-"]').first();
  await expect(add).toHaveText("Add to bib");
  await add.click();

  // After adding, the row's button is the calm done-state and disabled (no
  // duplicate add). The panel stays open — adding to the bib doesn't cite.
  await expect(add).toHaveText("In bibliography");
  await expect(add).toBeDisabled();
  await expect(page.getByTestId("citation-panel")).toBeVisible();
});
