import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * #H7 — the narrow pane TabBar is a real WAI-ARIA tablist: roving `tabIndex`
 * puts only the active tab in the tab order, Left/Right/Home/End move focus
 * across the tabs (manual activation — focus moves without switching the pane),
 * and each tab `aria-controls` the live `tab-panel` (a `role="tabpanel"`).
 *
 * Before H7 the tabs declared `role="tab"` + roving tabIndex but wired NO
 * arrow-key handler, so a keyboard user landed on the active tab and was stuck.
 */
test("narrow TabBar: arrow keys move focus across tabs; tabs control the tabpanel", async ({
  page,
}) => {
  await page.setViewportSize({ width: 600, height: 820 });
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.getByTestId("tab-bar")).toBeVisible();

  // The active pane tab owns tabIndex 0 (the others are -1 — roving tabindex).
  const editorTab = page.locator('[data-testid="tab"][data-tab="editor"]');
  await expect(editorTab).toHaveAttribute("aria-selected", "true");
  await expect(editorTab).toHaveAttribute("tabindex", "0");
  await expect(
    page.locator('[data-testid="tab"][data-tab="preview"]'),
  ).toHaveAttribute("tabindex", "-1");

  // Each tab controls the shared tabpanel, which is a real role="tabpanel".
  await expect(editorTab).toHaveAttribute("aria-controls", "tab-panel");
  const panel = page.getByTestId("tab-panel");
  await expect(panel).toHaveAttribute("role", "tabpanel");
  await expect(panel).toHaveAttribute("aria-labelledby", "tab-editor");

  // Focus the active tab, then walk with the arrow keys. Activation is manual:
  // focus moves but the selected pane (and the tabpanel content) does NOT change.
  await editorTab.focus();
  const focusedTab = () =>
    page.evaluate(() => document.activeElement?.getAttribute("data-tab") ?? null);

  await page.keyboard.press("ArrowRight");
  expect(await focusedTab()).toBe("preview");
  await expect(editorTab).toHaveAttribute("aria-selected", "true"); // unchanged

  await page.keyboard.press("End");
  expect(await focusedTab()).toBe("agent");

  await page.keyboard.press("ArrowRight"); // wraps past the end → first
  expect(await focusedTab()).toBe("files");

  await page.keyboard.press("Home");
  expect(await focusedTab()).toBe("files");

  await page.keyboard.press("ArrowLeft"); // wraps before the start → last
  expect(await focusedTab()).toBe("agent");
});

/**
 * #H7 — the docked Insert tablist is keyboard-navigable too: roving tabIndex +
 * arrow keys, and the three tabs `aria-controls` the single `insert-panel`
 * tabpanel host (only the open tab renders content, so the host's label tracks
 * the active tab).
 */
test("Insert tablist: arrow keys move focus; tabs control the insert-panel tabpanel", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Open the Insert dock via the command palette (rail icon is wide-only chrome).
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.getByTestId("command-palette-input").fill("Generate a figure");
  await page.locator('[data-command-id="generate-figure"]').click();

  const figureTab = page.locator('[data-testid="figure-button"]');
  await expect(figureTab).toBeVisible();
  await expect(figureTab).toHaveAttribute("aria-selected", "true");
  await expect(figureTab).toHaveAttribute("tabindex", "0");
  await expect(figureTab).toHaveAttribute("aria-controls", "insert-panel");

  const panel = page.locator("#insert-panel");
  await expect(panel).toHaveAttribute("role", "tabpanel");
  await expect(panel).toHaveAttribute("aria-labelledby", "insert-tab-figure");

  // Arrow across the tabs (figure → citation → import); manual activation, so
  // the open panel stays on figure while focus walks.
  await figureTab.focus();
  const focusedInsertTab = () =>
    page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);

  await page.keyboard.press("ArrowRight");
  expect(await focusedInsertTab()).toBe("add-citation");
  await expect(figureTab).toHaveAttribute("aria-selected", "true"); // unchanged

  await page.keyboard.press("End");
  expect(await focusedInsertTab()).toBe("import-button");

  await page.keyboard.press("ArrowRight"); // wraps → first
  expect(await focusedInsertTab()).toBe("figure-button");
});
