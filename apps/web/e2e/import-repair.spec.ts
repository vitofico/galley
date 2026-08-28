import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * Mount e2e for the ImportPanel "Repair with agent" step (#15.1) — Lane S passes
 * the optional `repair={{ model, compilerFactory }}` prop, which renders a
 * "Repair with agent" affordance on a converted result. With the offline Demo
 * model the repair core returns the draft unchanged DETERMINISTICALLY, so we
 * assert only that the affordance runs and a status surfaces (NOT ok=true).
 *
 * The default project shell, mirroring the existing #15 import test.
 */
test("#15.1 import-repair: convert → repair with agent surfaces a status", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  await page.getByTestId("insert-button").click();
  await page.getByTestId("import-button").click();
  await expect(page.getByTestId("import-panel")).toBeVisible();

  // Convert some Markdown/LaTeX-flavoured input to a Typst draft.
  await page.getByTestId("import-input").fill("# Imported Title\n\nSome \\textbf{bold} text.\n");
  await page.getByTestId("import-convert").click();
  await expect(page.getByTestId("diff-review")).toBeVisible();

  // The repair affordance is present (the prop is wired); run it.
  const run = page.getByTestId("import-repair-run");
  await expect(run).toBeVisible();
  await run.click();

  // A repair status renders. With the Demo model the draft is unchanged, so we
  // assert the status surfaces — NOT that the repair reports ok=true.
  await expect(page.getByTestId("import-repair-result")).toBeVisible({ timeout: 60_000 });
});
