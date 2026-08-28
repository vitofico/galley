import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * ADR-0025 §4 — IN-APP Auto acceptance, end-to-end against the deterministic Demo
 * model (offline). With the project's in-app acceptance mode set to Auto, a
 * finished run auto-applies the change through the manual-Accept-EQUIVALENT path
 * (checkpoint → conflict re-check → local audit → applied summary + Undo) — WITHOUT
 * a manual Accept. In the default Ask mode the mandatory Accept gate still renders.
 *
 * The in-app acceptance mode is a plain per-project localStorage value
 * (`galley.agentAcceptanceMode.<projectId>`); the `/p/<id>` route uses `<id>` as
 * the projectId, so an init script can pre-set Auto before the editor boots.
 */

/** Pre-set the project's in-app acceptance mode to Auto BEFORE the editor boots. */
async function setAutoMode(page: import("@playwright/test").Page, projectId: string): Promise<void> {
  await page.addInitScript(
    ([id]) => {
      try {
        localStorage.setItem(`galley.agentAcceptanceMode.${id}`, "auto");
      } catch {
        /* storage unavailable — the test will fall back to Ask and fail loudly */
      }
    },
    [projectId],
  );
}

test("Auto mode auto-applies a finished run without a manual Accept, with Undo", async ({
  page,
}) => {
  const projectId = "e2e-inapp-auto";
  await setAutoMode(page, projectId);
  await gotoEditor(page, { id: projectId });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Kick off the agent (request prefilled). On finish, Auto applies the run.
  await page.getByTestId("agent-send").click();

  // No manual Accept gate appears — the run auto-applies. The applied summary +
  // Undo affordance shows instead of Accept/Reject.
  const applied = page.getByTestId("agent-auto-applied");
  await expect(applied).toBeVisible({ timeout: 90_000 });
  await expect(applied).toContainText(/Applied automatically/i);
  await expect(page.getByTestId("agent-auto-undo")).toBeVisible();
  // The Accept gate never rendered.
  await expect(page.getByTestId("diff-review")).toHaveCount(0);
  await expect(page.getByTestId("accept")).toHaveCount(0);

  // The change landed in the live document (the same edit the manual path applies).
  await expect(page.locator('[data-testid="editor"] .cm-content')).toContainText(
    "Inserted by the Galley demo agent.",
  );

  // Undo restores the pre-apply checkpoint — the auto-applied span is reverted.
  await page.getByTestId("agent-auto-undo").click();
  await expect(applied).toContainText(/Reverted/i, { timeout: 30_000 });
  await expect(page.locator('[data-testid="editor"] .cm-content')).not.toContainText(
    "Inserted by the Galley demo agent.",
  );
});

test("Ask mode (default) still shows the mandatory Accept gate", async ({ page }) => {
  const projectId = "e2e-inapp-ask";
  // No setAutoMode → default Ask.
  await gotoEditor(page, { id: projectId });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  await page.getByTestId("agent-send").click();

  // The Accept gate renders — Ask mode keeps the mandatory human review.
  const diff = page.getByTestId("diff-review");
  await expect(diff).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("accept")).toBeVisible();
  // Nothing auto-applied.
  await expect(page.getByTestId("agent-auto-applied")).toHaveCount(0);
  await expect(page.locator('[data-testid="editor"] .cm-content')).not.toContainText(
    "Inserted by the Galley demo agent.",
  );
});
