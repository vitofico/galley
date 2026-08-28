import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * Roadmap #13 follow-up — the explicit "Insert reference…" affordance in the
 * PROJECT shell (beyond inline `@`-completion). ⌘K → "Insert reference…" opens a
 * picker of the project-wide `<label>` union; selecting one inserts `@<label>` at
 * the editor cursor via a direct EditorView dispatch (a plain edit, not an agent
 * run — no Accept gate).
 */
test("project: Insert reference… picks a label and inserts @label at the cursor", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Ensure a label exists: define one at the end of the active document, then
  // leave the cursor on its own fresh line so the insert is easy to assert.
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("= Heading <introlabel>\n\nBody text.\n");

  // Open the palette and run "Insert reference…".
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByTestId("command-palette-input");
  await expect(input).toBeFocused();
  await input.fill("Insert reference");
  await expect(page.getByTestId("command-palette-item").first()).toContainText(
    "Insert reference",
  );
  await page.keyboard.press("Enter");

  // The picker lists the project's labels; pick @introlabel.
  const picker = page.getByTestId("insert-reference-picker");
  await expect(picker).toBeVisible();
  const option = page
    .getByTestId("insert-reference-option")
    .filter({ hasText: "@introlabel" });
  await expect(option).toBeVisible();
  await option.click();

  // The picker closes and `@introlabel` was inserted into the document.
  await expect(picker).toHaveCount(0);
  await expect(editor).toContainText("@introlabel");
});
