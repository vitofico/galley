import { test, expect } from "@playwright/test";
import { openFilesDock } from "./files-dock.js";

/**
 * ProjectApp cohesion cluster — bringing the project shell to parity with the
 * single-file shell and wiring version compare:
 *   - #15 import wedge + #8 figure: the ImportPanel/FigurePanel are reachable in
 *     the project shell and Accept into the ACTIVE file (conflict-aware, never
 *     auto-apply).
 *   - #11.9 responsive: below the breakpoint the 4-pane project grid collapses to
 *     a tabbed files/editor/preview/agent stack.
 *   - #12.6 compare: selecting two saved versions renders a read-only per-file
 *     diff (no restore, no Accept).
 */

test("#15/#8 project shell: import inserts into the active file; figure panel reachable", async ({
  page,
}) => {
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("open-library")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Import a Markdown snippet → reviewable diff → Accept into the active file.
  // (#19.2: Import is a tab of the rail's docked Insert panel.)
  await page.getByTestId("insert-button").click();
  await page.getByTestId("import-button").click();
  await expect(page.getByTestId("import-panel")).toBeVisible();
  await page.getByTestId("import-input").fill("# Imported Heading\n\n- alpha\n- beta\n");
  await page.getByTestId("import-convert").click();
  await expect(page.getByTestId("diff-review")).toContainText("= Imported Heading");
  await page.getByTestId("accept").click();
  await expect(page.getByTestId("import-panel")).toHaveCount(0);
  // The import appends at the END of the demo main.typ (#20.2), past the editor
  // viewport (CodeMirror renders only visible lines) — scroll to it first.
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await expect(editor).toContainText("Imported Heading");

  // The figure generator is also reachable in the project shell (Accept closed
  // the Insert dock, so reopen it at the Figure tab).
  await page.getByTestId("insert-button").click();
  await page.getByTestId("figure-button").click();
  await expect(page.getByTestId("figure-panel")).toBeVisible();
});

test("#11.9 project shell: narrow viewport collapses the 4-pane grid into tabs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 600, height: 820 });
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("open-library")).toBeVisible({ timeout: 60_000 });

  // The tab bar replaces the side-by-side grid; the project shell adds a Files tab.
  await expect(page.getByTestId("tab-bar")).toBeVisible();
  await expect(page.locator('[data-testid="tab"][data-tab="files"]')).toBeVisible();

  // Files tab → the project file list is shown.
  await page.locator('[data-testid="tab"][data-tab="files"]').click();
  await expect(page.getByTestId("tab-panel")).toHaveAttribute("data-active-tab", "files");
  await expect(page.getByTestId("project-files")).toBeVisible();

  // Preview tab → the editor is unmounted, the preview pane shows.
  await page.locator('[data-testid="tab"][data-tab="preview"]').click();
  await expect(page.getByTestId("tab-panel")).toHaveAttribute("data-active-tab", "preview");
  await expect(page.locator('[data-testid="editor"]')).toHaveCount(0);

  // Agent tab → the agent panel shows.
  await page.locator('[data-testid="tab"][data-tab="agent"]').click();
  await expect(page.getByTestId("tab-panel")).toHaveAttribute("data-active-tab", "agent");
  await expect(page.getByTestId("agent-panel")).toBeVisible();
});

test("#12.6 project shell: comparing two saved versions shows a read-only diff", async ({
  page,
}) => {
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("open-library")).toBeVisible({ timeout: 60_000 });
  await openFilesDock(page);
  await expect(page.getByTestId("project-file").first()).toBeVisible({ timeout: 60_000 });
  // The seed is async (IndexedDB); wait for the active file to mount so the import
  // appends to a real file (not a not-yet-active empty one).
  await expect(page.locator('[data-testid="editor"] .cm-content')).toContainText(
    "Annus Mirabilis",
    { timeout: 60_000 },
  );

  const openHistory = async () => {
    await page.getByTestId("history-button").click();
    await expect(page.getByTestId("history-overlay")).toBeVisible();
  };
  const closeHistory = async () => {
    await page.getByTestId("history-overlay").getByRole("button", { name: "Close" }).click();
    await expect(page.getByTestId("history-overlay")).toHaveCount(0);
  };

  await openHistory();

  // Save a first named version (the seeded content). A fresh boot already has
  // the four pre-seeded 1905 demo versions (#20.2), so the save is the fifth.
  await page.getByTestId("save-version-name").fill("draft one");
  await page.getByTestId("save-version").click();
  await expect(page.getByTestId("history-version")).toHaveCount(5);
  await closeHistory();

  // Change the active file via the import wedge so the next version differs
  // (#19.2: Import is a tab of the rail's docked Insert panel).
  await page.getByTestId("insert-button").click();
  await page.getByTestId("import-button").click();
  await page.getByTestId("import-input").fill("# A New Section\n\nadded for compare\n");
  await page.getByTestId("import-convert").click();
  await page.getByTestId("accept").click();
  // Appended at the END, past the virtualized editor viewport — scroll to it.
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await expect(editor).toContainText("A New Section");

  // Save a second named version (now with the appended section).
  await openHistory();
  await page.getByTestId("save-version-name").fill("draft two");
  await page.getByTestId("save-version").click();
  await expect(page.getByTestId("history-version")).toHaveCount(6);

  // Select both drafts — the list is newest-first, so nth(0) is "draft two" and
  // nth(1) is "draft one" (the 1905 demo versions sit below them). The compare
  // must still order older → newer (draft one → draft two), not by click order.
  const checks = page.getByTestId("select-version");
  await checks.nth(0).check();
  await checks.nth(1).check();
  await page.getByTestId("compare-versions").click();

  await expect(page.getByTestId("compare-overlay")).toBeVisible();
  // Header is older → newer (base → other), regardless of checkbox click order.
  await expect(page.getByTestId("version-compare")).toContainText("draft one");
  await expect(page.getByTestId("version-compare")).toContainText("draft two");
  // The appended text must render as an ADDITION (older→newer). An inverted
  // base/other would have shown it as a deletion — this pins the ordering fix.
  await expect(page.locator(".vcompare-line-add").filter({ hasText: "added for compare" })).toBeVisible();
});
