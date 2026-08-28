import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";
import { openFilesDock } from "./files-dock.js";

/**
 * Activation e2e for #13.3 broken-ref *surfacing* — the cross-file label index
 * (`crossFileRefDiagnostics`) wired into the project diagnostics. The headline:
 * a `@ref` to a `<label>` defined in a SIBLING file is NOT falsely flagged, while
 * a genuinely-missing ref IS — both path-qualified to the active file.
 */
test("project broken-ref lint is cross-file aware (#13.3)", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);

  // Add a sibling file that DEFINES a label.
  await page.getByTestId("new-file-path").fill("/refs.typ");
  await page.getByTestId("add-file").click();
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.type("A theorem. <thm-main>");

  // Back to main: reference the sibling-file label (valid) AND a missing one.
  await page.locator('[data-testid="project-file"][data-path="/main.typ"]').click();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Refs: @thm-main and @nope here");
  await page.keyboard.press("Escape"); // dismiss any @-autocomplete popup

  const diags = page.getByTestId("diagnostics");
  // The lint flags the truly-missing ref…
  await expect(diags).toContainText("unknown reference @nope", { timeout: 30_000 });
  // …but NOT the one defined in the sibling file (cross-file aware — no false positive).
  await expect(diags).not.toContainText("unknown reference @thm-main");
});
