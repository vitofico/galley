import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * #15 agent-pane @-mention file context — typing `@` in the composer offers the
 * project's files; picking one inserts its canonical path so the run can attach
 * that file's content. The project shell (default `/`) wires the `mentionFiles`
 * seam; the single-file shell does not (so it stays byte-for-byte unchanged).
 *
 * We assert the picker UX here (appears, filters, inserts, closes); the request
 * augmentation itself is covered by the pure agent-mentions unit tests.
 */

test("@-mention: typing @ offers project files and picking one inserts its path", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  const composer = page.getByTestId("agent-request");
  const list = page.getByTestId("agent-mention-suggestions");

  // A plain prompt offers nothing.
  await composer.fill("just edit it");
  await expect(list).toBeHidden();

  // An open `@` token surfaces the project's files (the blank starter has main.typ).
  await composer.fill("summarize @");
  await expect(list).toBeVisible();
  const option = page.getByTestId("agent-mention-option-/main.typ");
  await expect(option).toBeVisible();

  // Picking a file inserts its canonical path + a trailing space, which closes the
  // mention (the list hides again). The composer keeps the user's raw prompt.
  await option.click();
  await expect(composer).toHaveValue("summarize @/main.typ ");
  await expect(list).toBeHidden();
});
