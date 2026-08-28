import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";
import { openFilesDock } from "./files-dock.js";

/**
 * Mount e2e for Focus / Zen mode (#18.5) — the toggle (now on the rail foot,
 * #19.2) sets `data-focus="true"` on the shell root; CSS then hides the agent
 * panel and the docked file list for a distraction-free editor+preview view.
 * Default OFF → the current layout. Toggling off restores the panes.
 */
test("#18.5 focus mode: hides the agent panel, then restores it", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  // The Files dock auto-collapses on a laptop boot; open it so this test can
  // verify focus mode HIDES it (and restores it) from a visible baseline.
  await openFilesDock(page);

  // Default OFF: the agent panel and file list are visible (#19.2: the file
  // list lives in the rail's docked card now, not a grid column).
  const agentPanel = page.locator('.panes > .sidebar');
  const filesPane = page.locator('.project-files-pane');
  await expect(agentPanel).toBeVisible();
  await expect(filesPane).toBeVisible();

  // Toggle ON: both distraction panes are hidden.
  await page.getByTestId("focus-mode-toggle").click();
  await expect(agentPanel).toBeHidden();
  await expect(filesPane).toBeHidden();

  // Toggle OFF: the panes return.
  await page.getByTestId("focus-mode-toggle").click();
  await expect(agentPanel).toBeVisible();
  await expect(filesPane).toBeVisible();
});
