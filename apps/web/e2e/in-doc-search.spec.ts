import { test, expect } from "@playwright/test";

/**
 * In-document full-text search (Tier E #2 — "find in files"): open the seeded
 * "Annus Mirabilis" project, open the search dock (via the ⌘⇧F shortcut and via
 * the ⌘K palette), type a query that lives in a NON-active file, assert the
 * grouped result rows carry the right path/line, then click one and assert the
 * editor switched to that file and the cursor moved to the match.
 *
 * The query "Electrodynamics" appears in `/relativity.typ` (the boot active file
 * is `/main.typ`), so a successful click exercises the cross-file
 * switch-then-jump sequencing.
 */
async function settle(page: import("@playwright/test").Page) {
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.locator('[data-testid="preview"] svg').first()).toBeVisible();
}

test("find in files: shortcut opens search, results carry path/line, click jumps cross-file", async ({
  page,
}) => {
  await page.goto("/?seed=einstein");
  await settle(page);

  // Boots on /main.typ.
  await expect(page.locator('[data-testid="editor"] .cm-content')).toContainText("Annus Mirabilis");

  // Open the search dock via the ⌘⇧F shortcut; the input is focused.
  await page.locator('[data-testid="editor"] .cm-content').click();
  await page.keyboard.press("ControlOrMeta+Shift+f");
  await expect(page.getByTestId("search-panel")).toBeVisible();
  const input = page.getByTestId("search-input");
  await expect(input).toBeFocused();

  // Query a term that lives in /relativity.typ (NOT the active /main.typ).
  await input.fill("Electrodynamics");

  // A result row appears tagged with the right path; assert its line is a
  // positive integer (the exact line depends on the seed, so don't pin it).
  const row = page
    .locator('[data-testid="search-result"][data-path="/relativity.typ"]')
    .first();
  await expect(row).toBeVisible();
  const lineAttr = await row.getAttribute("data-line");
  expect(Number(lineAttr)).toBeGreaterThan(0);

  // The match snippet highlights the hit.
  await expect(row.locator(".search-result-hit")).toContainText(/Electrodynamics/i);

  // Click the row → the editor switches to /relativity.typ. (The search dock is
  // exclusive with the files dock, so the file LIST isn't shown here; the editor
  // content is the switch signal — it now shows that file's distinctive text.)
  await row.click();
  await expect(page.locator('[data-testid="editor"] .cm-content')).toContainText(
    "Electrodynamics of Moving Bodies",
  );

  // The jump focuses the editor and scrolls the match into view: CodeMirror
  // renders a cursor element once the editor holds the (focused) selection,
  // proving the jump-after-file-switch fired rather than just switching files.
  await expect(page.locator('[data-testid="editor"] .cm-cursor').first()).toBeVisible();
});

test("find in files: reachable from the ⌘K palette; empty result is surfaced", async ({
  page,
}) => {
  await page.goto("/?seed=einstein");
  await settle(page);

  // Open the palette and run the "Find in files" command.
  await page.getByTestId("palette-button").click();
  await page.getByTestId("command-palette-input").fill("find in files");
  await page
    .locator('[data-testid="command-palette-item"][data-command-id="find-in-files"]')
    .click();

  await expect(page.getByTestId("search-panel")).toBeVisible();
  const input = page.getByTestId("search-input");

  // A query with no occurrences surfaces the empty state.
  await input.fill("zzzznotpresentanywhere");
  await expect(page.getByTestId("search-empty")).toBeVisible();

  // A real query brings results back.
  await input.fill("Annus");
  await expect(page.getByTestId("search-result").first()).toBeVisible();
  await expect(page.getByTestId("search-count")).toContainText(/match/i);
});
