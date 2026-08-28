import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * H5 — a fresh local boot must not strand a novice on a near-blank page. A
 * one-time, NON-BLOCKING chooser banner surfaces the templates + the 1905 demo
 * (otherwise buried behind the unlabeled ⊞ glyph), and dismissal is permanent.
 * Non-blocking by design — it never overlays the editor (every other `/`-booting
 * spec runs with it present and stays green).
 */
test("first boot surfaces a demo chooser; dismissal is permanent", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // The chooser greets the fresh local boot with the 1905 demo entry.
  const chooser = page.getByTestId("first-run-chooser");
  await expect(chooser).toBeVisible();
  // Templates are now on the Projects page — the chooser only has the demo + dismiss.
  await expect(page.getByTestId("first-run-templates")).toHaveCount(0);
  await expect(page.getByTestId("first-run-demo")).toBeVisible();

  // Dismiss and reload: the one-time chooser does NOT return.
  await page.getByTestId("first-run-dismiss").click();
  await page.reload();
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.getByTestId("first-run-chooser")).toHaveCount(0);
});
