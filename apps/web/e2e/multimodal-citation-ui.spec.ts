import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * Wave-4 coordinator sweep — proving the newly-activated multimodal (#8/#10) and
 * citation (#17.1/#17.4) affordances are REACHABLE on the default `/` route
 * (which boots ProjectApp with the Demo model).
 *
 *   - Figure panel: the capability-gated vision section is wired and mounts.
 *     The Demo model's probe is local/instant and reports supportsImageInput:false,
 *     so the calm "connect a vision-capable model" hint (figure-vision-disabled)
 *     is shown — proving the probe-on-open + capability gate are wired end to end.
 *   - Citation panel: the new library-import and literature-search mode tabs are
 *     present and reachable; the library tab reveals its paste input.
 *
 * Robust waits throughout; no exact model output is asserted.
 */

async function waitReady(page: import("@playwright/test").Page) {
  // Default route boots ProjectApp: the file rail + compile status both settle.
  await expect(page.getByTestId("open-library")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
}

test("#8/#10 figure: the capability-gated vision section is reachable (Demo → disabled hint)", async ({
  page,
}) => {
  await gotoEditor(page);
  await waitReady(page);

  // Open the Figure panel via its existing control; this triggers the probe-on-open.
  // (#19.2: the control lives on a tab of the rail's docked Insert panel now.)
  await page.getByTestId("insert-button").click();
  await page.getByTestId("figure-button").click();
  await expect(page.getByTestId("figure-panel")).toBeVisible();

  // Demo model probes locally → supportsImageInput:false → the calm vision hint.
  // This proves the capabilities prop is wired (the section only mounts when
  // capabilities !== undefined) AND that it self-gates honestly.
  await expect(page.getByTestId("figure-vision-disabled")).toBeVisible({ timeout: 30_000 });
});

test("#17.1/#17.4 citation: library-import and literature-search modes are reachable", async ({
  page,
}) => {
  await gotoEditor(page);
  await waitReady(page);

  // #19.2: the citation control is a tab of the rail's docked Insert panel.
  await page.getByTestId("insert-button").click();
  await page.getByTestId("add-citation").click();
  await expect(page.getByTestId("citation-panel")).toBeVisible();

  // The new mode tabs are present alongside the original paste mode.
  await expect(page.getByTestId("citation-mode-library")).toBeVisible();
  await expect(page.getByTestId("citation-mode-search")).toBeVisible();

  // Clicking the library tab reveals its BibTeX/RIS paste input.
  await page.getByTestId("citation-mode-library").click();
  await expect(page.getByTestId("citation-library-input")).toBeVisible();
});
