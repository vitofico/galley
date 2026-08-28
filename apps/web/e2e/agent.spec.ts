import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * M2 + M3 acceptance e2e: the full human-in-the-loop agent loop, offline and
 * deterministic via the built-in Demo model. A request runs the agent (which
 * self-corrects a broken edit to a clean compile), produces a reviewable diff,
 * and Accept applies it to the live document and re-renders.
 */
test("runs the agent, reviews the diff, accepts, and re-renders", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Kick off the agent (the request is prefilled). The agent loads its own
  // compiler (a second worker) on first run, so allow generous time.
  await page.getByTestId("agent-send").click();

  // The run finishes with a reviewable diff (the agent self-corrected to clean).
  const diff = page.getByTestId("diff-review");
  await expect(diff).toBeVisible({ timeout: 90_000 });
  await expect(diff).toContainText(/compiled_clean/);
  await expect(diff).toContainText(/Demo Section/);
  // The trace shows the self-correction: it hit an error before converging.
  await expect(page.getByTestId("agent-trace")).toContainText(/error/i);

  // Accept applies the edits to the live document and re-renders cleanly.
  await page.getByTestId("accept").click();
  await expect(diff).toHaveCount(0);
  await expect(page.locator('[data-testid="editor"] .cm-content')).toContainText(
    "Inserted by the Galley demo agent.",
  );
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 30_000 });
});

test("rejecting the diff discards it and leaves the document unchanged", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  await page.getByTestId("agent-send").click();
  const diff = page.getByTestId("diff-review");
  await expect(diff).toBeVisible({ timeout: 90_000 });

  await page.getByTestId("reject").click();
  await expect(diff).toHaveCount(0);
  // Reject discards the scratch — the live document is untouched.
  await expect(page.locator('[data-testid="editor"] .cm-content')).not.toContainText(
    "Inserted by the Galley demo agent.",
  );
});

