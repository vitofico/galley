import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";
import { openFilesDock } from "./files-dock.js";

/**
 * Group D wirings of the wave-2 cluster:
 *   - #12.6 History UX: the HistoryPanel is reachable from the project shell;
 *     saving a named version materializes the CRDT snapshot into the VersionStore
 *     and it appears in the timeline (restore closes the panel).
 *     Since #20.2 a fresh boot seeds the "Annus Mirabilis" workspace, so the
 *     panel already lists the four pre-seeded 1905 versions (newest-first).
 *   - #11.9 responsive: below the breakpoint the single-file grid collapses to a
 *     tabbed editor/preview/agent stack.
 */

test("#12.6/#20.2 version history lists the four 1905 entries, saves, and restores", async ({
  page,
}) => {
  // The persistent unified project (a stable id, IndexedDB-backed).
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("open-library")).toBeVisible({ timeout: 60_000 });
  // Wait for the demo to seed (files present) so the saved snapshot has content,
  // and for the first compile — by which point the fresh-seed history write
  // (a handful of IndexedDB puts, started before the compile) has settled.
  await openFilesDock(page);
  await expect(page.getByTestId("project-file").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  await page.getByTestId("history-button").click();
  await expect(page.getByTestId("history-overlay")).toBeVisible();
  await expect(page.getByTestId("history-panel")).toBeVisible();

  // A TRUE first seed pre-seeds the 1905 timeline (#20.2): four named versions,
  // newest-first in the panel — September at the top, March at the bottom.
  const versions = page.getByTestId("history-version");
  await expect(versions).toHaveCount(4);
  await expect(versions.nth(0)).toContainText("27 September 1905");
  await expect(versions.nth(1)).toContainText("30 June 1905");
  await expect(versions.nth(2)).toContainText("11 May 1905");
  await expect(versions.nth(3)).toContainText("17 March 1905");

  // Save a named version → materialize → it appears newest-first in the timeline.
  await page.getByTestId("save-version-name").fill("submitted to NeurIPS");
  await page.getByTestId("save-version").click();
  await expect(versions).toHaveCount(5);
  await expect(versions.first()).toContainText("submitted to NeurIPS");

  // Restore the newest save as a CRDT transaction; the panel closes (no crash).
  await page.getByTestId("restore-version").first().click();
  await expect(page.getByTestId("history-overlay")).toHaveCount(0);
});

test("#11.9 narrow viewport collapses the single-file grid into tabs", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 820 });
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // The tab bar replaces the side-by-side grid; the editor tab is active first.
  await expect(page.getByTestId("tab-bar")).toBeVisible();
  await expect(page.getByTestId("tab-panel")).toHaveAttribute("data-active-tab", "editor");
  await expect(page.locator('[data-testid="editor"]')).toBeVisible();

  // Switch to Preview → the editor is no longer mounted, the preview pane shows.
  await page.locator('[data-testid="tab"][data-tab="preview"]').click();
  await expect(page.getByTestId("tab-panel")).toHaveAttribute("data-active-tab", "preview");
  await expect(page.locator('[data-testid="editor"]')).toHaveCount(0);

  // Switch to Agent → the agent panel shows.
  await page.locator('[data-testid="tab"][data-tab="agent"]').click();
  await expect(page.getByTestId("tab-panel")).toHaveAttribute("data-active-tab", "agent");
  await expect(page.getByTestId("agent-panel")).toBeVisible();
});
