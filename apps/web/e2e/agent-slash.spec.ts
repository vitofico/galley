import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * Agent-pane `/` quick-actions — typing `/` at the start of the composer offers a
 * catalog of canned prompts; picking one expands it into the composer text.
 *
 * We assert the picker UX here (appears, start-anchored, expands, closes) and the
 * discipline fence (choosing NEVER sends); the text transform itself is covered
 * by the pure agent-slash unit tests.
 */

test("slash: typing / offers quick-actions and picking one expands it in place", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  const composer = page.getByTestId("agent-request");
  const list = page.getByTestId("agent-slash-suggestions");

  // A bare `/` opens the catalog.
  await composer.fill("/");
  await expect(list).toBeVisible();
  await expect(page.getByTestId("agent-slash-option-fix")).toBeVisible();

  // Typing filters it down to the matching action.
  await composer.fill("/fi");
  await expect(page.getByTestId("agent-slash-option-fix")).toBeVisible();
  await expect(page.getByTestId("agent-slash-option-shorten")).toBeHidden();

  // Picking one expands the template into the composer; the prompt no longer
  // starts with `/`, which closes the picker.
  await page.getByTestId("agent-slash-option-fix").click();
  await expect(composer).toHaveValue(/^Fix the Typst compile errors/);
  await expect(composer).toHaveValue(/smallest change that compiles/);
  await expect(list).toBeHidden();
});

test("slash: expanding a quick-action never sends a run", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  await page.getByTestId("agent-request").fill("/proofread");
  await page.getByTestId("agent-slash-option-proofread").click();

  // THE FENCE: expansion is a pure text transform on the composer buffer. The
  // author still reads, edits and sends the prompt themselves — so no run starts,
  // and the human Accept gate is never bypassed.
  await expect(page.getByTestId("agent-send")).toHaveText("Send");
  await expect(page.getByTestId("agent-stop")).toHaveCount(0);
  await expect(page.getByTestId("agent-stream")).toHaveCount(0);
  await expect(page.getByTestId("agent-toast-finished")).toHaveCount(0);
});

test("slash: the picker is start-anchored and leaves ordinary prose alone", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  const composer = page.getByTestId("agent-request");
  const list = page.getByTestId("agent-slash-suggestions");

  // Plain prose offers nothing…
  await composer.fill("just edit it");
  await expect(list).toBeHidden();

  // …and a `/` after prose is an ordinary character (a path, a URL, "and/or"),
  // not an action.
  await composer.fill("see /main.typ");
  await expect(list).toBeHidden();

  // A space closes the token too.
  await composer.fill("/fix ");
  await expect(list).toBeHidden();
});
