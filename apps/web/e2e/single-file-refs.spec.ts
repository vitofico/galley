import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * Roadmap #13 follow-up — broken cross-reference surfacing in the active file.
 * Broken-ref detection is wired into the SAME `shownDiagnostics` that feeds the
 * editor underline and the list, alongside the compiler diagnostics.
 *
 * A `@missingref` with no matching `<missingref>` label → an "unknown reference"
 * warning surfaces. Defining the label clears it (the merged set recomputes on
 * source change). Mirrors the diagnostics.spec.ts structure.
 */
test("a broken @ref surfaces a warning that clears when the label is defined", async ({
  page,
}) => {
  await gotoEditor(page);

  // Wait for the WASM compiler to be ready.
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Replace the document with a single reference to an undefined label.
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("= Title\n\nSee @missingref for details.");

  // The broken-ref lint surfaces an "unknown reference" warning in the list
  // (a located warning — the line:col prefix proves a span flows through).
  await expect(page.getByTestId("diagnostics")).toContainText(/unknown reference @missingref/i, {
    timeout: 30_000,
  });
  await expect(page.getByTestId("diagnostics")).toContainText(/\d+:\d+/);

  // It also paints IN the editor (the same shownDiagnostics feeds the underline).
  await expect(
    page
      .locator(
        '[data-testid="editor"] .cm-diagnostic-warning, [data-testid="editor"] .cm-diagnostic-gutter-warning, [data-testid="editor"] .cm-diagnostic-error, [data-testid="editor"] .cm-diagnostic-gutter-error',
      )
      .first(),
  ).toBeVisible({ timeout: 30_000 });

  // Define the matching label → the warning clears (the lint recomputes on the
  // source change and the union now resolves the ref).
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("= Title <missingref>\n\nSee @missingref for details.");

  await expect(page.getByTestId("diagnostics")).not.toContainText(/unknown reference @missingref/i, {
    timeout: 30_000,
  });
});
