import { expect, type Page } from "@playwright/test";

/**
 * Open the Files dock if it is not already showing.
 *
 * On a laptop-width viewport (the e2e suite runs at 1280px) the Files dock
 * auto-collapses on a FIRST run so the preview can render its page near physical
 * size (see `shouldBootFilesClosed`). Specs that exercise the file tree boot
 * fresh (no persisted choice), so they must open the dock first. Idempotent:
 * a no-op when the tree is already visible, and it waits for the tree to render.
 *
 * Call AFTER the workspace has booted (e.g. once `status` shows page count).
 */
export async function openFilesDock(page: Page): Promise<void> {
  const anyFile = page.getByTestId("project-file").first();
  if (await anyFile.isVisible().catch(() => false)) return;
  await page.getByTestId("rail-files").click();
  await expect(anyFile).toBeVisible();
}
