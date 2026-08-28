import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * Roadmap #11.4 acceptance e2e: compiler diagnostics are surfaced IN the editor
 * (gutter marker + squiggly underline) and the diagnostics list is click-to-jump.
 * Wires the WS-2 mechanism that the shells activate (the coordinator sweep).
 */
test("in-editor diagnostics: a marker appears and a list item jumps to source", async ({
  page,
}) => {
  await gotoEditor(page);

  // Wait for the WASM compiler to be ready.
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Reference an undefined variable in markup — Typst reports a LOCATED (non-empty
  // span) "unknown variable" error on the identifier, so it paints in the editor.
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("= Title\n\n#undefined_var");

  // The status + list reflect a LOCATED error (the line:col prefix proves a span).
  await expect(page.getByTestId("status")).toContainText(/error/i, { timeout: 30_000 });
  await expect(page.getByTestId("diagnostics")).toContainText(/\d+:\d+/, { timeout: 30_000 });

  // The error is painted IN the editor: a squiggly underline and/or a gutter
  // marker (either proves the in-editor mechanism is live).
  await expect(
    page
      .locator(
        '[data-testid="editor"] .cm-diagnostic-error, [data-testid="editor"] .cm-diagnostic-gutter-error',
      )
      .first(),
  ).toBeVisible({ timeout: 30_000 });

  // Clicking a located diagnostic row jumps into the editor (focuses it) — the
  // list is no longer the only way to find an error's position.
  await page.getByTestId("diagnostic").first().click();
  await expect(page.locator('[data-testid="editor"] .cm-editor.cm-focused')).toBeVisible();
});
