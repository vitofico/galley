import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * Mount e2e for the citation-paste UI (#6) — the CitationPanel is wired into the
 * project shell's topbar (Lane S). A pasted BibTeX entry resolves OFFLINE (no
 * network) to a reviewable Hayagriva entry + a deterministic cite key, and
 * Accept inserts the in-text `@<key>` cite into the active file through the same
 * conflict-aware Accept path the Import/Figure panels use.
 *
 * Boots the default `/` route (the persistent project shell; each test's fresh
 * browser context seeds the demo workspace anew) so the test is hermetic.
 */

const BIBTEX = `@article{knuth1984,
  title = {Literate Programming},
  author = {Knuth, Donald E.},
  journal = {The Computer Journal},
  year = {1984},
}`;

test("#6 citation: paste BibTeX → resolve → insert the @cite", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Open the Add-citation panel from the rail's docked Insert panel (#19.2).
  await page.getByTestId("insert-button").click();
  await page.getByTestId("add-citation").click();
  await expect(page.getByTestId("citation-panel")).toBeVisible();

  // Paste a BibTeX entry and resolve it (offline — no network path is hit).
  await page.getByTestId("citation-input").fill(BIBTEX);
  await page.getByTestId("citation-resolve").click();

  // The resolved cite key + Hayagriva YAML render for review.
  await expect(page.getByTestId("citation-result")).toBeVisible();
  const key = await page.getByTestId("citation-key").textContent();
  expect(key && key.length).toBeTruthy();
  await expect(page.getByTestId("citation-yaml")).toContainText("Literate Programming");

  // Accept inserts the in-text `@<key>` cite into the active file and closes the
  // panel. The bibliography entry is routed to the project's .bib in parallel.
  // Click the visible shared Accept (DiffReview), scoped to the citation panel —
  // the `citation-insert` hook is intentionally aria-hidden, so it's not actuable.
  await page.getByTestId("citation-panel").getByTestId("accept").click();
  await expect(page.getByTestId("citation-panel")).toHaveCount(0);
  // The cite lands at the END of the active file. The demo main.typ (#20.2) is
  // taller than the editor viewport and CodeMirror only renders visible lines,
  // so scroll the cursor to the end before asserting on the rendered content.
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await expect(editor).toContainText(`@${key}`);
});
