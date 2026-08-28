import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * Authoring activations (Group C of the wave-2 cluster):
 *   - #15 import wedge: paste Markdown/LaTeX → convert → reviewable diff → insert.
 *   - #11.4b quick-fix: a diagnostic offers a one-click scoped agent run (the diff
 *     is still reviewed; Accept stays mandatory).
 *   - #8 figure: describe a figure → generate a CeTZ draft → reviewable diff.
 * All surface through the EXISTING Accept/diff flow on the default single-file path.
 */

async function waitReady(page: import("@playwright/test").Page) {
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
}

test("#15 import: Markdown → Typst → reviewable diff → insert", async ({ page }) => {
  await gotoEditor(page);
  await waitReady(page);

  await page.getByTestId("insert-button").click();
  await page.getByTestId("import-button").click();
  await expect(page.getByTestId("import-panel")).toBeVisible();

  await page.getByTestId("import-input").fill("# Imported Title\n\n- one\n- two\n");
  await page.getByTestId("import-convert").click();

  // The conversion is shown as a reviewable diff (the existing Accept flow).
  await expect(page.getByTestId("diff-review")).toBeVisible();
  await expect(page.getByTestId("diff-review")).toContainText("= Imported Title");

  // Accept inserts it into the document and closes the panel.
  await page.getByTestId("accept").click();
  await expect(page.getByTestId("import-panel")).toHaveCount(0);
  await expect(page.locator('[data-testid="editor"] .cm-content')).toContainText("Imported Title");
});

test("#11.4b quick-fix: a diagnostic launches a scoped, reviewable agent run", async ({ page }) => {
  await gotoEditor(page);
  await waitReady(page);

  // Introduce a LOCATED error so a quick-fix (which needs a span) is offered.
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("= Title\n\n#undefined_var");
  await expect(page.getByTestId("status")).toContainText(/error/i, { timeout: 30_000 });

  // The lightbulb appears on the located diagnostic; clicking it scopes the agent.
  const fix = page.getByTestId("quick-fix").first();
  await expect(fix).toBeVisible({ timeout: 30_000 });
  await fix.click();

  // The agent request is filled with the scoped quick-fix instruction and a run
  // starts (a trace appears) — the human still reviews the resulting diff.
  await expect(page.getByTestId("agent-request")).toHaveValue(/Fix the Typst/i);
  await expect(page.getByTestId("agent-trace")).toBeVisible({ timeout: 30_000 });
});

test("#8 figure: describe → generate a CeTZ draft → reviewable diff", async ({ page }) => {
  await gotoEditor(page);
  await waitReady(page);

  await page.getByTestId("insert-button").click();
  await page.getByTestId("figure-button").click();
  await expect(page.getByTestId("figure-panel")).toBeVisible();

  await page.getByTestId("figure-description").fill("a box labelled Model with an arrow to Output");
  await page.getByTestId("figure-generate").click();

  // A generated CeTZ draft is surfaced as a reviewable diff with an honest status.
  await expect(page.getByTestId("figure-status")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("diff-review")).toBeVisible();
  await expect(page.getByTestId("diff-review")).toContainText("cetz");

  // Accept inserts the draft (reviewed) and closes the panel.
  await page.getByTestId("accept").click();
  await expect(page.getByTestId("figure-panel")).toHaveCount(0);
  await expect(page.locator('[data-testid="editor"] .cm-content')).toContainText("cetz");
});
