import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";
import { openFilesDock } from "./files-dock.js";

/**
 * Mount e2e for the ⌘K command palette (#19.1, Rail & Islands stage 1).
 *
 * The palette is a NEW, parallel surface in the project shell: Mod-K opens a
 * fuzzy-search overlay over the registered commands (existing actions only)
 * plus "Open <path>" entries for the project's files. Closed → nothing in the
 * DOM (additive: the shipped chrome is untouched). Keyboard-first: type to
 * filter, ↑/↓ + Enter to run, Escape to close.
 */

test("#19.1 ⌘K palette: opens with the keyboard, filters, Enter runs a command", async ({ page }) => {
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Closed by default: not in the DOM at all (the shipped DOM is unchanged).
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
  // Light is the absence of the data-theme attribute (see theme.ts).
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", "dark");

  // Mod-K opens it with the search input focused.
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  const input = page.getByTestId("command-palette-input");
  await expect(input).toBeFocused();

  // With no query, results are grouped and include the registered commands.
  await expect(page.getByTestId("command-palette-item").first()).toBeVisible();

  // Type to fuzzy-filter down to the theme toggle; its ⌘J hint shows inline.
  await input.fill("dark");
  const top = page.getByTestId("command-palette-item").first();
  await expect(top).toContainText("Toggle dark mode");
  await expect(top.locator("kbd")).toBeVisible();

  // Enter runs it: the palette closes and the theme actually flips.
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // Escape closes without running anything (theme stays dark).
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("palette: New file… reveals + focuses the new-file input (wide)", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByTestId("command-palette-input");
  await expect(input).toBeFocused();
  await input.fill("New file");
  await page
    .getByTestId("command-palette-item")
    .filter({ hasText: "New file" })
    .first()
    .click();
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
  // The Files dock's create input is focused, ready to type a path.
  await expect(page.getByTestId("new-file-path")).toBeFocused();
});

test("C4 narrow: TAPPING ⌘K reaches Outline (the rail is hidden, so touch users need the palette)", async ({
  page,
}) => {
  // Below 820px the icon rail is display:none, so a touch user (no keyboard)
  // reaches the rail's panels only by TAPPING the ⌘K pill — which must list every
  // rail command. Outline was the one missing entry, so it was unreachable on
  // mobile. Drive the touch path: tap the button (no keyboard), pick Outline.
  await page.setViewportSize({ width: 600, height: 820 });
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // The rail is gone on narrow; the ⌘K pill is the touch route in.
  await expect(page.getByTestId("icon-rail")).toBeHidden();
  await page.getByTestId("palette-button").click();
  const input = page.getByTestId("command-palette-input");
  await expect(input).toBeVisible();
  await input.fill("Outline");
  await page
    .getByTestId("command-palette-item")
    .filter({ hasText: "Outline" })
    .first()
    .click();
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
  // The Outline panel opens (as the narrow overlay sheet) — no longer stranded.
  await expect(page.getByTestId("doc-outline")).toBeVisible();
});

test("CX-1 narrow: the palette pill reads as a ☰ 'Menu', not ⌘K jargon, and still opens", async ({
  page,
}) => {
  // On a touch viewport the ⌘K keycap is jargon a tap-only user won't recognize
  // as "the menu" — so narrow swaps it for a universal hamburger labelled "Menu".
  await page.setViewportSize({ width: 600, height: 820 });
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  const pill = page.getByTestId("palette-button");
  // No ⌘ keycap; the accessible name + tooltip read as "Menu".
  await expect(pill).toHaveText("☰");
  await expect(pill).toHaveAttribute("aria-label", "Menu");
  await expect(pill).toHaveAttribute("title", "Menu");

  // It still opens the same palette.
  await pill.click();
  await expect(page.getByTestId("command-palette-input")).toBeVisible();
});

test("CX-1 wide: the palette pill keeps the ⌘K keycap + shortcut tooltip", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  const pill = page.getByTestId("palette-button");
  await expect(pill).toHaveText("⌘K");
  await expect(pill).toHaveAttribute("aria-label", "Command palette");
  await expect(pill).toHaveAttribute("title", "Command palette (⌘K)");
});

test("palette: New file… switches to the Files tab + focuses the input (narrow)", async ({
  page,
}) => {
  // The narrow morph puts the Files pane in the bottom tab stack, NOT the dock,
  // so the command must switch the tab — this guards the wide-only regression.
  await page.setViewportSize({ width: 600, height: 820 });
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Default tab is the editor: the new-file input is not in the DOM yet.
  await expect(page.getByTestId("new-file-path")).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByTestId("command-palette-input");
  await expect(input).toBeFocused();
  await input.fill("New file");
  await page
    .getByTestId("command-palette-item")
    .filter({ hasText: "New file" })
    .first()
    .click();
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
  // The Files tab is now active and its create input is focused.
  await expect(page.getByTestId("tab-panel")).toHaveAttribute("data-active-tab", "files");
  await expect(page.getByTestId("new-file-path")).toBeFocused();
});

test("#19.1 palette: lists the project's files and opens one", async ({ page }) => {
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);

  // The demo workspace boots with /main.typ active.
  await expect(
    page.locator('[data-testid="project-file"][data-path="/main.typ"]'),
  ).toHaveAttribute("aria-current", "true");

  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByTestId("command-palette-input");
  await expect(input).toBeFocused();

  // Project files are listed as "Open <path>" entries under Files.
  await input.fill("typ");
  await expect(
    page.locator('[data-testid="command-palette-item"]', { hasText: "Open /main.typ" }),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="command-palette-item"]', { hasText: "Open /relativity.typ" }),
  ).toBeVisible();

  // Narrow to /relativity.typ and run it: the active editor file switches.
  await input.fill("relativ");
  await expect(page.getByTestId("command-palette-item").first()).toContainText(
    "Open /relativity.typ",
  );
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
  await expect(
    page.locator('[data-testid="project-file"][data-path="/relativity.typ"]'),
  ).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("editor")).toContainText("Electrodynamics", { timeout: 10_000 });
});
