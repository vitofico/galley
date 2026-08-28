import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * Accessibility (a11y) e2e for the Rail & Islands project shell (#23.5).
 *
 * These are KEYBOARD-ONLY flows driven with real key events — the things that
 * actually break keyboard / screen-reader users if they regress:
 *   - the skip-to-content link is reachable from the very top and jumps focus
 *     past the chrome into the editor;
 *   - opening a modal (the ⌘K palette / the shortcuts sheet) moves focus INTO it;
 *   - the command palette is arrow-key navigable and Enter runs the selection;
 *   - Escape closes a modal AND focus RETURNS to the trigger that opened it
 *     (the focus-trap/restore contract);
 *   - landmark roles (main / nav) are present.
 *
 * Additive-only: every assertion is over a11y attributes / focus, never a visual
 * change. The existing suite's testids are reused, never altered.
 */

const ready = async (page: import("@playwright/test").Page) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
};

test("#23.5 skip link: first Tab reaches it and it jumps focus to the editor", async ({ page }) => {
  await ready(page);

  // The skip link is the first focusable element — one Tab from the document top
  // lands on it (it's visually hidden until focused; focus reveals it via CSS).
  await page.keyboard.press("Tab");
  const skip = page.getByTestId("skip-link");
  await expect(skip).toBeFocused();

  // Activating it moves focus into the editor (CodeMirror's contenteditable),
  // past the rail/topbar — exactly what a keyboard user needs.
  await page.keyboard.press("Enter");
  const editorFocused = await page.evaluate(() => {
    const el = document.activeElement;
    return !!el?.closest(".cm-editor");
  });
  expect(editorFocused).toBe(true);
});

test("#23.5 landmarks: the shell exposes main + nav regions", async ({ page }) => {
  await ready(page);
  // The rail is a labelled nav; the editor/preview area is the main landmark.
  await expect(page.locator('nav[aria-label="Workspace panels"]')).toBeVisible();
  await expect(page.locator('[role="main"]')).toBeVisible();
});

test("#23.5 ⌘K palette: focus moves in, arrows navigate, Escape restores focus to the trigger", async ({
  page,
}) => {
  await ready(page);

  // Focus the palette BUTTON (the trigger) so we can assert focus returns to it.
  const trigger = page.getByTestId("palette-button");
  await trigger.focus();
  await expect(trigger).toBeFocused();

  // Open with the keyboard; focus moves INTO the palette's search input.
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByTestId("command-palette-input");
  await expect(input).toBeFocused();

  // Arrow-key navigation moves the active option (aria-selected follows).
  const firstItem = page.getByTestId("command-palette-item").first();
  await expect(firstItem).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  // After ArrowDown the first item is no longer the selected one.
  await expect(firstItem).toHaveAttribute("aria-selected", "false");
  // The input still drives selection via aria-activedescendant.
  await expect(input).toHaveAttribute("aria-activedescendant", /cmd-palette-opt-\d+/);

  // Escape closes the palette AND restores focus to the ⌘K trigger button.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("#23.5 shortcuts sheet: opening moves focus in; Escape restores it to the trigger", async ({
  page,
}) => {
  await ready(page);

  // Open the shortcuts sheet from its rail button (the trigger).
  const trigger = page.getByTestId("shortcuts-button");
  await trigger.click();
  const sheet = page.getByTestId("command-sheet");
  await expect(sheet).toBeVisible();

  // Focus moved INTO the dialog (its Close button), not left on the page behind.
  const focusInside = await page.evaluate(() => {
    const el = document.activeElement;
    return !!el?.closest('[data-testid="command-sheet"]');
  });
  expect(focusInside).toBe(true);

  // Escape closes it and returns focus to the rail trigger.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-sheet")).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("#23.5 template picker: focus is trapped inside the dialog (Tab cycles, never escapes)", async ({
  page,
}) => {
  await page.goto("/library");
  await expect(page.getByTestId("library")).toBeVisible({ timeout: 30_000 });

  // Open the template picker from its Projects-page trigger.
  const trigger = page.getByTestId("library-new-from-template");
  await trigger.click();
  const dialog = page.getByTestId("template-picker");
  await expect(dialog).toBeVisible();

  // Focus landed inside the dialog on open.
  const insideOnOpen = await page.evaluate(
    () => !!document.activeElement?.closest('[data-testid="template-picker"]'),
  );
  expect(insideOnOpen).toBe(true);

  // Tab a generous number of times — the trap must keep focus inside the dialog
  // on every step (it never escapes to the chrome behind the modal).
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const stillInside = await page.evaluate(
      () => !!document.activeElement?.closest('[data-testid="template-picker"]'),
    );
    expect(stillInside).toBe(true);
  }

  // Shift-Tab also stays inside (wrap the other way).
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Shift+Tab");
    const stillInside = await page.evaluate(
      () => !!document.activeElement?.closest('[data-testid="template-picker"]'),
    );
    expect(stillInside).toBe(true);
  }

  // Escape closes it and restores focus to the trigger.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("template-picker")).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
