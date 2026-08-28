import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";
import { openFilesDock } from "./files-dock.js";

/**
 * Activation e2e for the activation + authoring-depth cluster — the coordinator
 * sweep that wires the parallel-built, default-off slices into the shells:
 *   - #11.6 dark theme (topbar toggle; light is the default, byte-for-byte)
 *   - #11.7 keyboard/command surface (the discoverable cheat-sheet)
 *   - #6   bibliography → cite-key autocomplete (a project `.bib` now feeds `@`-cites)
 * Each is asserted USER-REACHABLE, not merely present in the bundle.
 */

test.use({ colorScheme: "light" });

test("dark theme toggle flips data-theme and is reversible (#11.6)", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  const html = page.locator("html");
  // Default is light: the absence of the attribute (byte-for-byte light theme).
  await expect(html).not.toHaveAttribute("data-theme", "dark");

  // Toggling sets the dark attribute that theme.css keys off of.
  await page.getByTestId("theme-toggle").click();
  await expect(html).toHaveAttribute("data-theme", "dark");

  // Toggling again removes it (back to the default light theme).
  await page.getByTestId("theme-toggle").click();
  await expect(html).not.toHaveAttribute("data-theme", "dark");
});

test("command sheet opens from the topbar and lists shortcuts, closes on Escape (#11.7)", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Hidden until invoked.
  await expect(page.getByTestId("command-sheet")).toHaveCount(0);

  await page.getByTestId("shortcuts-button").click();
  const sheet = page.getByTestId("command-sheet");
  await expect(sheet).toBeVisible();
  // It lists real bindings (Export PDF among them).
  await expect(sheet).toContainText("Export PDF");
  await expect(page.getByTestId("command-sheet-row").first()).toBeVisible();

  // Escape dismisses it.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-sheet")).toHaveCount(0);
});

test("project bibliography feeds cite-key autocomplete (#6)", async ({ page }) => {
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);

  // Add a SECOND bibliography file (the demo workspace already ships /refs.bib;
  // all .bib files feed the cite-key source). The new file becomes active.
  await page.getByTestId("new-file-path").fill("/extra.bib");
  await page.getByTestId("add-file").click();
  await expect(page.locator('[data-testid="project-file"][data-path="/extra.bib"]')).toBeVisible();

  // Type a BibTeX entry into it (braces are balanced → CodeMirror types over the
  // auto-closed ones). The `.bib` content is the cite-key source.
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.type("@article{smith2020, title={A Study}, year={2020}}");
  await expect(editor).toContainText("smith2020");

  // Switch to the main file and start a citation reference there.
  await page.locator('[data-testid="project-file"][data-path="/main.typ"]').click();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("See @smi");
  await page.keyboard.press("Control+Space");

  // The shared `@`-menu now offers the cite key parsed from the bibliography.
  const menu = page.locator(".cm-tooltip-autocomplete");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await expect(menu).toContainText("smith2020");
});
