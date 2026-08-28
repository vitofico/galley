import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * Roadmap #13 — agent-based contribution reconstruction (UI slice). ⌘K → "Draft
 * contribution statement" reconstructs a CRediT-style author-contribution
 * statement from the project's REAL attributed history (version contributors +
 * per-file authorship) and opens it for REVIEW. The modal is the explicit human
 * confirm: nothing is written until the author clicks "Insert into document",
 * which appends the draft through ProjectApp's conflict-aware accept path (the
 * same `onInsertSnippet` used by figure/import/citation). Cancel/Escape close
 * without mutating — the statement is never auto-applied.
 */
test("project: Draft contribution statement → review → explicit gated insert (not auto-applied)", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Author some content so the local editor holds attributed spans (evidence).
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("= Introduction\n\nSome body text by this author.\n");

  // Open the palette and run "Draft contribution statement".
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByTestId("command-palette-input");
  await expect(input).toBeFocused();
  await input.fill("contribution statement");
  await expect(page.getByTestId("command-palette-item").first()).toContainText(
    "Draft contribution statement",
  );
  await page.keyboard.press("Enter");

  // The review modal opens with a non-empty drafted statement (read-only).
  const modal = page.getByTestId("contribution-statement-modal");
  await expect(modal).toBeVisible();
  const preview = page.getByTestId("contribution-statement-preview");
  await expect(preview).toContainText("Author Contributions");

  // Nothing has been written to the document yet — review is read-only.
  await expect(editor).not.toContainText("Author Contributions");

  // The explicit "Insert into document" confirm appends the reviewed draft via
  // the conflict-aware accept path and closes the modal.
  await page.getByTestId("contribution-statement-insert").click();
  await expect(modal).toHaveCount(0);
  await expect(editor).toContainText("Author Contributions");
});

test("#13: the review modal closes on Cancel without mutating the document", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("= Draft\n\nBody.\n");

  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByTestId("command-palette-input");
  await input.fill("contribution statement");
  await page.keyboard.press("Enter");

  const modal = page.getByTestId("contribution-statement-modal");
  await expect(modal).toBeVisible();

  // Cancel closes with no insert: no diff, no Accept ever appeared.
  await page.getByTestId("contribution-statement-cancel").click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId("diff-review")).toHaveCount(0);
  await expect(page.getByTestId("accept")).toHaveCount(0);
  await expect(editor).not.toContainText("Author Contributions");
});
