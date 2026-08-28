import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * #18.4 explain-error: a second one-click action on a located diagnostic
 * (beside the #11.4b quick-fix lightbulb) that asks the agent to EXPLAIN the
 * Typst error in plain language. It rides the same scoped-request substrate,
 * but the output is advice, not a diff:
 *   - the explanation streams into the agent panel as text;
 *   - NO diff and NO Accept/Reject gate ever appears for an explain run;
 *   - the document is byte-for-byte untouched.
 * Driven offline by the deterministic Demo model; the advice-only model
 * wrapper strips its scripted propose_edit, so the run finishes as no_edits.
 */

async function waitReady(page: import("@playwright/test").Page) {
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
}

/** Replace the editor content with a document containing a LOCATED error. */
async function typeBrokenDoc(page: import("@playwright/test").Page) {
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("= Title\n\n#undefined_var");
  await expect(page.getByTestId("status")).toContainText(/error/i, { timeout: 30_000 });
}

test("#18.4 single-file: Explain on a diagnostic streams advice — no diff, no Accept, doc untouched", async ({
  page,
}) => {
  await gotoEditor(page);
  await waitReady(page);
  await typeBrokenDoc(page);

  // The Explain action appears on the located diagnostic, beside the quick-fix.
  const explain = page.getByTestId("explain-error").first();
  await expect(explain).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("quick-fix").first()).toBeVisible();
  await explain.click();

  // The request is the scoped explanation instruction and a run starts.
  await expect(page.getByTestId("agent-request")).toHaveValue(/Explain the Typst error/i);
  await expect(page.getByTestId("agent-trace")).toBeVisible({ timeout: 30_000 });

  // The response streams into the panel as text and the run finishes with NO
  // edits (the advice-only guard strips the Demo model's scripted propose_edit).
  await expect(page.getByTestId("agent-stream").first()).not.toBeEmpty({ timeout: 90_000 });
  // The run-outcome line lives among the tool steps, which the redesigned pane
  // collapses by default — expand them to assert the clean no-edits finish.
  const steps = page.getByTestId("agent-steps-toggle");
  await expect(steps).toBeVisible({ timeout: 90_000 });
  await steps.click();
  await expect(page.getByTestId("agent-trace")).toContainText("finished: no_edits", {
    timeout: 90_000,
  });

  // Advice only: no diff review, no Accept/Reject gate.
  await expect(page.getByTestId("diff-review")).toHaveCount(0);
  await expect(page.getByTestId("accept")).toHaveCount(0);
  await expect(page.getByTestId("reject")).toHaveCount(0);

  // The document is byte-for-byte untouched — the broken line is still there.
  await expect(page.locator('[data-testid="editor"] .cm-content')).toContainText(
    "#undefined_var",
  );
});

test("#18.4 project shell: Explain is offered on a located diagnostic and runs advice-only", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("open-library")).toBeVisible({ timeout: 60_000 });
  await waitReady(page);
  await typeBrokenDoc(page);

  const explain = page.getByTestId("explain-error").first();
  await expect(explain).toBeVisible({ timeout: 30_000 });
  await explain.click();

  await expect(page.getByTestId("agent-request")).toHaveValue(/Explain the Typst error/i);
  await expect(page.getByTestId("agent-trace")).toBeVisible({ timeout: 30_000 });
  // The run-outcome line lives among the collapsed-by-default tool steps — expand.
  const steps = page.getByTestId("agent-steps-toggle");
  await expect(steps).toBeVisible({ timeout: 90_000 });
  await steps.click();
  await expect(page.getByTestId("agent-trace")).toContainText("finished: no_edits", {
    timeout: 90_000,
  });
  await expect(page.getByTestId("diff-review")).toHaveCount(0);
  await expect(page.getByTestId("accept")).toHaveCount(0);
});
