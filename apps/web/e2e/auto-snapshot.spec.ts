import { test, expect } from "@playwright/test";
import { openFilesDock } from "./files-dock.js";

/**
 * Automatic versioning (#10) — opt-in, default-OFF, coalesced auto-snapshots
 * that reuse the EXISTING snapshot path.
 *
 * The enabled policy's edit-count cadence (30 doc updates) is the e2e-friendly
 * trigger; the 5-minute interval is too slow for a test. Typing past the
 * threshold and letting the ~1s debounce settle must produce exactly the kinds
 * of versions a user expects: an "Auto-snapshot …" entry that is visibly
 * distinct from manual ones, and no auto entries at all while the toggle is off.
 */

async function bootProject(page: import("@playwright/test").Page) {
  await page.goto("/?seed=einstein");
  await openFilesDock(page);
  await expect(page.getByTestId("project-file").first()).toBeVisible({ timeout: 60_000 });
  // The seed is async (IndexedDB); wait for the editor to mount real content.
  await expect(page.locator('[data-testid="editor"] .cm-content')).toContainText(
    "Annus Mirabilis",
    { timeout: 60_000 },
  );
}

async function openHistory(page: import("@playwright/test").Page) {
  await page.getByTestId("history-button").click();
  await expect(page.getByTestId("history-overlay")).toBeVisible();
}

async function closeHistory(page: import("@playwright/test").Page) {
  await page.getByTestId("history-overlay").getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("history-overlay")).toHaveCount(0);
}

test("#10 default-OFF: the toggle is unchecked and no auto-snapshot is taken on edits", async ({
  page,
}) => {
  await bootProject(page);
  await openHistory(page);

  // Default-OFF proof: the opt-in control renders unchecked.
  await expect(page.getByTestId("auto-snapshot-toggle")).not.toBeChecked();
  await closeHistory(page);

  // Type well past the edit threshold WITHOUT enabling — nothing should snapshot.
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.type("disabled typing should never auto-snapshot anything at all here");
  // Give any (non-existent) debounce a generous chance to fire.
  await page.waitForTimeout(1_500);

  await openHistory(page);
  await expect(
    page.getByTestId("history-version").filter({ hasText: "Auto-snapshot" }),
  ).toHaveCount(0);
});

test("#10 enabled: crossing the edit threshold creates an Auto-snapshot; manual still works", async ({
  page,
}) => {
  await bootProject(page);
  await openHistory(page);

  // Manual save still works unchanged (also gives us a known baseline entry).
  await page.getByTestId("save-version-name").fill("manual baseline");
  await page.getByTestId("save-version").click();
  await expect(
    page.getByTestId("history-version").filter({ hasText: "manual baseline" }),
  ).toHaveCount(1);

  // Opt in.
  await page.getByTestId("auto-snapshot-toggle").check();
  await expect(page.getByTestId("auto-snapshot-toggle")).toBeChecked();
  await closeHistory(page);

  // Type past the 30-edit threshold (each keystroke is one doc update), then let
  // the ~1s debounce settle so the coalesced check fires once.
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.type("auto snapshot should trigger after this many edits land in the doc");
  await page.waitForTimeout(1_500);

  await openHistory(page);
  // An auto-snapshot appeared, clearly labeled and distinct from the manual one.
  await expect(
    page.getByTestId("history-version").filter({ hasText: "Auto-snapshot" }).first(),
  ).toBeVisible();
  await expect(
    page.getByTestId("history-version").filter({ hasText: "manual baseline" }),
  ).toHaveCount(1);

  // Coalescing/honesty: the toggle persists across the panel reopen.
  await expect(page.getByTestId("auto-snapshot-toggle")).toBeChecked();
});
