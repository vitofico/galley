import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";
import { openFilesDock } from "./files-dock.js";

/**
 * Mount e2e for Agent mode (#14) — the MIRROR of focus mode. The rail toggle
 * sets `data-agent="true"` on the shell root; CSS then hides the EDITOR and the
 * docked file list, leaving an agent (sidebar) + preview (center) view. Default
 * OFF → the current layout. Toggling off restores the panes.
 *
 * It is mutually exclusive with focus mode: turning agent mode ON clears focus
 * mode (otherwise both the editor and the agent could hide, leaving only the
 * preview), which the final assertion pins.
 */
test("#14 agent mode: hides the editor, leaving agent + preview, then restores", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  // The Files dock auto-collapses on a laptop boot; open it so this test can
  // verify agent mode HIDES it (and restores it) from a visible baseline.
  await openFilesDock(page);

  const editor = page.locator(".panes > .editor");
  const filesPane = page.locator(".project-files-pane");
  const agentPanel = page.locator(".panes > .sidebar");
  const preview = page.locator(".panes > .center");

  // Default OFF: the editor and file list are visible.
  await expect(editor).toBeVisible();
  await expect(filesPane).toBeVisible();

  // Toggle ON: the editor and file list are hidden; agent + preview remain.
  await page.getByTestId("agent-mode-toggle").click();
  await expect(editor).toBeHidden();
  await expect(filesPane).toBeHidden();
  await expect(agentPanel).toBeVisible();
  await expect(preview).toBeVisible();

  // Side-by-side layout: the agent panel is to the RIGHT of the preview.
  const previewBox = await preview.boundingBox();
  const agentBox = await agentPanel.boundingBox();
  expect(previewBox).not.toBeNull();
  expect(agentBox).not.toBeNull();
  if (previewBox && agentBox) {
    expect(agentBox.x).toBeGreaterThan(previewBox.x);
  }

  // Toggle OFF: the editor and file list return.
  await page.getByTestId("agent-mode-toggle").click();
  await expect(editor).toBeVisible();
  await expect(filesPane).toBeVisible();
});

/**
 * Drive the toggles via the ⌘K palette rather than the rail buttons: focus mode
 * intentionally hides every rail control except its own exit toggle (the B17
 * chrome rule), so the palette is the layout-independent path to flip the other
 * mode — exactly what we need to pin mutual exclusivity from either state.
 */
async function runCommand(page: import("@playwright/test").Page, title: string) {
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByTestId("command-palette-input");
  await expect(input).toBeFocused();
  await input.fill(title);
  await expect(page.getByTestId("command-palette-item").first()).toContainText(title);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
}

test("#14 agent mode is mutually exclusive with focus mode", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  const root = page.locator(".app.shell-rail");

  // Turn focus mode ON first.
  await runCommand(page, "Toggle focus mode");
  await expect(root).toHaveAttribute("data-focus", "true");
  await expect(root).not.toHaveAttribute("data-agent", "true");

  // Turning agent mode ON must CLEAR focus mode: only data-agent remains.
  await runCommand(page, "Toggle agent mode");
  await expect(root).toHaveAttribute("data-agent", "true");
  await expect(root).not.toHaveAttribute("data-focus", "true");

  // And the symmetric direction: turning focus mode ON clears agent mode.
  await runCommand(page, "Toggle focus mode");
  await expect(root).toHaveAttribute("data-focus", "true");
  await expect(root).not.toHaveAttribute("data-agent", "true");
});
