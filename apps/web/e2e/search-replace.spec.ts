import { test, expect } from "@playwright/test";

/**
 * Search replace + replace-all (feature #4), layered on the find-in-files
 * panel. The seeded "Annus Mirabilis" project carries the phrase
 * "patent office" exactly ONCE in `/main.typ` and ONCE in `/marginalia.typ`,
 * so it exercises a true multi-file replace with a pinned count of 2.
 *
 * Covered here: replace-all across two files in one action (counts + both
 * files' content asserted), the one-level undo restoring exactly, a single
 * per-result replace touching just that match, undo invalidation after a
 * manual edit, and the viewer role's replace affordances being inert.
 */
const QUERY = "patent office";
const REPLACEMENT = "patent bureau";

async function settle(page: import("@playwright/test").Page) {
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.locator('[data-testid="preview"] svg').first()).toBeVisible();
}

async function openSearch(page: import("@playwright/test").Page) {
  await page.locator('[data-testid="editor"] .cm-content').click();
  await page.keyboard.press("ControlOrMeta+Shift+f");
  await expect(page.getByTestId("search-panel")).toBeVisible();
}

test("replace-all spans two files in one action; undo restores exactly", async ({ page }) => {
  await page.goto("/?seed=einstein");
  await settle(page);
  await openSearch(page);

  await page.getByTestId("search-input").fill(QUERY);
  await expect(page.getByTestId("search-count")).toContainText("2 matches in 2 files");

  // Before any replacement text is typed, the button is explicit that an empty
  // replacement DELETES the matches (no modal — the label is the confirmation).
  const replaceAll = page.getByTestId("search-replace-all");
  await expect(replaceAll).toHaveText("Replace all (2) with ''");

  // Type a replacement → the label carries the live count.
  await page.getByTestId("search-replace-input").fill(REPLACEMENT);
  await expect(replaceAll).toHaveText("Replace all (2)");
  await replaceAll.click();

  // The live search re-runs over the changed text: the old phrase is gone…
  await expect(page.getByTestId("search-empty")).toBeVisible();

  // …and the NEW phrase sits in BOTH files (the search results' data-path
  // attributes are the per-file proof).
  await page.getByTestId("search-input").fill(REPLACEMENT);
  await expect(page.getByTestId("search-count")).toContainText("2 matches in 2 files");
  await expect(
    page.locator(`[data-testid="search-result"][data-path="/main.typ"]`),
  ).toHaveCount(1);
  const marginaliaRow = page.locator(
    `[data-testid="search-result"][data-path="/marginalia.typ"]`,
  );
  await expect(marginaliaRow).toHaveCount(1);

  // Jump into /marginalia.typ and assert the replaced text in the editor
  // itself (content-level proof for the file that was NOT active).
  await marginaliaRow.click();
  await expect(page.locator('[data-testid="editor"] .cm-content')).toContainText(REPLACEMENT);

  // Undo (one level): the affordance names the blast radius…
  const undo = page.getByTestId("search-replace-undo");
  await expect(undo).toContainText("Undo replace (2 changes across 2 files)");
  await expect(undo).toBeEnabled();
  await undo.click();

  // …and restores the prior texts exactly: the new phrase is gone everywhere,
  // the old phrase is back in both files, and the editor (still on
  // /marginalia.typ) shows the original wording. The snapshot is one-shot —
  // the button unmounts after use.
  await expect(page.getByTestId("search-empty")).toBeVisible();
  await expect(undo).toHaveCount(0);
  await page.getByTestId("search-input").fill(QUERY);
  await expect(page.getByTestId("search-count")).toContainText("2 matches in 2 files");
  await expect(page.locator('[data-testid="editor"] .cm-content')).toContainText(QUERY);
});

test("a per-result Replace changes just that match", async ({ page }) => {
  await page.goto("/?seed=einstein");
  await settle(page);
  await openSearch(page);

  await page.getByTestId("search-input").fill(QUERY);
  await expect(page.getByTestId("search-count")).toContainText("2 matches in 2 files");
  await page.getByTestId("search-replace-input").fill(REPLACEMENT);

  // Replace ONLY the /marginalia.typ match via its row button.
  await page
    .locator(`[data-testid="search-replace-one"][data-path="/marginalia.typ"]`)
    .click();

  // The other match is untouched: 1 match left, and it is /main.typ's.
  await expect(page.getByTestId("search-count")).toContainText("1 match in 1 file");
  await expect(
    page.locator(`[data-testid="search-result"][data-path="/main.typ"]`),
  ).toHaveCount(1);
  await expect(
    page.locator(`[data-testid="search-result"][data-path="/marginalia.typ"]`),
  ).toHaveCount(0);

  // The undo affordance reflects the single-match blast radius.
  await expect(page.getByTestId("search-replace-undo")).toContainText(
    "Undo replace (1 change across 1 file)",
  );
});

test("undo invalidates once an affected file changes", async ({ page }) => {
  await page.goto("/?seed=einstein");
  await settle(page);
  await openSearch(page);

  await page.getByTestId("search-input").fill(QUERY);
  await expect(page.getByTestId("search-count")).toContainText("2 matches in 2 files");
  await page.getByTestId("search-replace-input").fill(REPLACEMENT);
  await page.getByTestId("search-replace-all").click();

  const undo = page.getByTestId("search-replace-undo");
  await expect(undo).toBeEnabled();

  // Manually edit /main.typ (an affected file): the held inverse is no longer
  // safe to apply, so the button disables and says why.
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("X");
  await expect(undo).toBeDisabled();
  await expect(page.getByTestId("search-panel")).toContainText(
    "A file changed since this replace",
  );
});

test("a read-only viewer gets no replace affordances", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxV = await browser.newContext();
  try {
    // Host boots the seeded project and mints a VIEWER link (share.spec's
    // role technique).
    const a = await ctxA.newPage();
    await a.goto("/?seed=einstein");
    await expect(a.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
    await a.getByTestId("share-button").click();
    await expect(a.getByTestId("share-link")).toBeVisible({ timeout: 30_000 });
    await a.getByTestId("share-role-viewer").check();
    const viewerUrl = await a.getByTestId("share-link").inputValue();
    expect(new URL(viewerUrl).searchParams.get("role")).toBe("viewer");

    const v = await ctxV.newPage();
    await v.goto(viewerUrl);
    // A fresh context always shows the one-time name prompt; await it rather than
    // snapshot `isVisible()` (the snapshot races React's post-load mount, and a
    // miss leaves the modal up so `open-library` never renders — flaky timeout).
    await expect(v.getByTestId("join-name-prompt")).toBeVisible({ timeout: 30_000 });
    await v.getByTestId("join-name-submit").click();
    await expect(v.getByTestId("open-library")).toBeVisible({ timeout: 30_000 });
    // Wait for the shared content to arrive before searching it.
    await expect(v.locator('[data-testid="editor"] .cm-content')).toContainText(
      "Annus Mirabilis",
      { timeout: 30_000 },
    );

    // Search itself still works for a viewer (read-only navigation)…
    await openSearch(v);
    await v.getByTestId("search-input").fill(QUERY);
    await expect(v.getByTestId("search-count")).toContainText("2 matches in 2 files", {
      timeout: 30_000,
    });

    // …but every replace affordance is inert: the inputs are disabled with the
    // read-only tooltip, and per-result Replace buttons are not rendered.
    await expect(v.getByTestId("search-replace-input")).toBeDisabled();
    const replaceAll = v.getByTestId("search-replace-all");
    await expect(replaceAll).toBeDisabled();
    await expect(replaceAll).toHaveAttribute("title", /read-only/i);
    await expect(v.getByTestId("search-replace-one")).toHaveCount(0);
  } finally {
    await ctxA.close();
    await ctxV.close();
  }
});
