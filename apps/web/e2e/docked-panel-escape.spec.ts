import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * M15 — the docked side panels (Files / Search / History / Outline) close on
 * Escape, not only via the ✕ (previously reachable only by tabbing). Non-modal:
 * Escape dismisses without trapping focus or closing on an outside-click, so a
 * docked panel still stays put while you work in the editor. They all share the
 * `DockedPanel` host, so proving one proves the contract.
 */
test("M15: a docked panel (History) closes on Escape", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  await page.getByTestId("history-button").click();
  await expect(page.getByTestId("history-overlay")).toBeVisible();

  // Escape closes it — no ✕ click or tabbing needed.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("history-overlay")).toHaveCount(0);
});

test("M15: the Outline dock also closes on Escape (shared DockedPanel host)", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  await page.getByTestId("rail-outline").click();
  await expect(page.getByTestId("doc-outline")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("doc-outline")).toHaveCount(0);
});
