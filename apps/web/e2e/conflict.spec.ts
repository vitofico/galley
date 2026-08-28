import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * M3 conflict-aware Accept (docs/editing-and-diff.md): if the user edits the
 * document during a run, Accept must re-match the edit blocks against the
 * CURRENT source and surface a conflict instead of clobbering. Deterministic:
 * the demo agent's first block targets the whole original document, so replacing
 * the document guarantees the re-match fails.
 */
test("conflict-aware Accept surfaces a conflict instead of clobbering", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  await page.getByTestId("agent-send").click();
  await expect(page.getByTestId("diff-review")).toBeVisible({ timeout: 90_000 });

  // The user replaces the document after the run started — the proposed edits no
  // longer match the live source.
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Completely different document now.");

  await page.getByTestId("accept").click();
  // Never clobbers: a conflict notice, and the diff stays for the user to re-run.
  await expect(page.getByTestId("accept-notice")).toContainText(/could not apply/i);
  await expect(page.getByTestId("diff-review")).toBeVisible();

  // C3: the failure banner lives at the shell root, NOT inside the agent sidebar
  // (where it was clipped/unmounted when collapsed). A failure interrupts.
  await expect(page.locator('.sidebar [data-testid="accept-notice"]')).toHaveCount(0);
  await expect(page.getByTestId("accept-notice")).toHaveAttribute("role", "alert");

  // Collapsing the agent sidebar must not hide the failure.
  await page.getByTestId("collapse-sidebar").click();
  await expect(page.getByTestId("accept-notice")).toBeVisible();

  // And it is dismissable.
  await page.getByTestId("notice-dismiss").click();
  await expect(page.getByTestId("accept-notice")).toHaveCount(0);
});
