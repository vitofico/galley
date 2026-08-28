import { test, expect, type Page } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * ADR-0025 §1/§5 (Task 8) — the unified AGENT ACCESS PANEL drives the in-app
 * agent's Ask/Auto choice end-to-end against the deterministic Demo model
 * (offline), retiring the old AutoAcceptBar two-step arm/confirm.
 *
 * What this proves, all THROUGH the panel's own controls (no MCP grant needed —
 * the panel is gated on `canMutate` alone, so the in-app Auto control is reachable
 * with no pairing):
 *   - selecting `agent-mode-auto` then finishing a run AUTO-APPLIES it (no manual
 *     Accept gate), and the merged `agent-access-audit` records the applied run;
 *   - the `agent-auto-killswitch` returns the panel to Ask INSTANTLY (no confirm),
 *     so the NEXT run shows the mandatory Accept gate again;
 *   - the panel itself (controls + audit) is visible for an editor.
 */

const AGENT_EDIT_MARKER = "Inserted by the Galley demo agent.";

/** The editor's live document text locator. */
function editorText(page: Page) {
  return page.locator('[data-testid="editor"] .cm-content');
}

test("the panel's Auto control auto-applies a run; the kill-switch restores the Ask gate", async ({
  page,
}) => {
  const projectId = "e2e-agent-access-panel";
  await gotoEditor(page, { id: projectId });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // The unified panel is visible for an editor (no MCP pairing required).
  const panel = page.getByTestId("agent-access-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  // Default is Ask.
  await expect(panel.getByTestId("agent-auto-killswitch")).toHaveCount(0);

  // Choose Auto through the panel — the kill-switch now appears.
  await panel.getByTestId("agent-mode-auto").click();
  await expect(panel.getByTestId("agent-auto-killswitch")).toBeVisible();

  // Finish a run: with Auto selected it auto-applies (no manual Accept gate).
  await page.getByTestId("agent-send").click();
  const applied = page.getByTestId("agent-auto-applied");
  await expect(applied).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("diff-review")).toHaveCount(0);
  await expect(page.getByTestId("accept")).toHaveCount(0);
  await expect(editorText(page)).toContainText(AGENT_EDIT_MARKER);

  // The merged audit now lists the auto-applied run.
  const audit = panel.getByTestId("agent-access-audit");
  await expect(audit).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByTestId("agent-access-audit-row").first()).toBeVisible();

  // The INSTANT kill-switch returns to Ask with no confirm step.
  await panel.getByTestId("agent-auto-killswitch").click();
  await expect(panel.getByTestId("agent-auto-killswitch")).toHaveCount(0);
  // The Ask control reflects the active mode.
  await expect(panel.getByTestId("agent-mode-ask")).toHaveAttribute("aria-checked", "true");

  // The NEXT run now shows the mandatory Accept gate again (Ask mode).
  await page.getByTestId("agent-send").click();
  const diff = page.getByTestId("diff-review");
  await expect(diff).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("accept")).toBeVisible();
});
