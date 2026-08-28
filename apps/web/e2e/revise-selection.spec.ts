import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * 11.8b selection-scoped revise: select a region in the editor → "Revise
 * selection…" → the agent revises THAT region, producing a reviewable diff
 * through the EXISTING scratch→diff→Accept loop. The Accept gate stays
 * mandatory — the edit only lands on explicit Accept, never inline.
 *
 * Driven offline by the deterministic Demo model (the same harness as
 * agent.spec / explain-error.spec): a run yields a self-corrected, reviewable
 * diff. This spec proves the WIRING — a selection routes a scoped request into
 * the agent and the human still gates the result.
 */

async function waitReady(page: import("@playwright/test").Page) {
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
}

/** Put a non-empty multi-line selection in the editor (select-all). */
async function selectRegion(page: import("@playwright/test").Page) {
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
}

test("11.8b project shell: revise a selection → reviewable diff, Accept-gated (not auto-applied)", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("open-library")).toBeVisible({ timeout: 60_000 });
  await waitReady(page);

  await selectRegion(page);

  // The command is offered in the palette only while a selection exists.
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByTestId("command-palette-input");
  await expect(input).toBeFocused();
  await input.fill("revise selection");
  await expect(page.getByTestId("command-palette-item").first()).toContainText(
    "Revise selection",
  );
  await page.keyboard.press("Enter");

  // The focused prompt opens with a summary of the selected region.
  const prompt = page.getByTestId("revise-selection-prompt");
  await expect(prompt).toBeVisible();
  await expect(page.getByTestId("revise-selection-summary")).toContainText(/Revise the selected/);

  // Type an instruction and submit — the prompt closes and a run starts.
  const reviseInput = page.getByTestId("revise-selection-input");
  await expect(reviseInput).toBeFocused();
  await reviseInput.fill("make this shorter");
  await page.getByTestId("revise-selection-submit").click();
  await expect(prompt).toHaveCount(0);

  // The run flows through the NORMAL agent loop and produces a reviewable diff.
  const diff = page.getByTestId("diff-review");
  await expect(diff).toBeVisible({ timeout: 90_000 });
  // Accept is present — the edit is NOT auto-applied (the gate is mandatory).
  await expect(page.getByTestId("accept")).toBeVisible();
  await expect(page.getByTestId("reject")).toBeVisible();

  // Accepting applies the agent's edit and clears the diff (loop unchanged).
  await page.getByTestId("accept").click();
  await expect(diff).toHaveCount(0);
});

test("11.8b: the Mod-Shift-e shortcut also opens the prompt; Escape cancels with no run", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("open-library")).toBeVisible({ timeout: 60_000 });
  await waitReady(page);

  await selectRegion(page);

  // The raw chord opens the prompt (global binding, fires from the editor).
  await page.keyboard.press("ControlOrMeta+Shift+e");
  await expect(page.getByTestId("revise-selection-prompt")).toBeVisible();

  // Escape cancels: no prompt, and crucially no diff/Accept ever appeared.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("revise-selection-prompt")).toHaveCount(0);
  await expect(page.getByTestId("diff-review")).toHaveCount(0);
  await expect(page.getByTestId("accept")).toHaveCount(0);
});
