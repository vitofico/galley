import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * L9 — the pane splitters were `role="separator"` but `tabIndex={-1}` and
 * pointer-only, so a keyboard user couldn't move them. They are now focusable
 * (`tabIndex={0}`), announce their position (`aria-valuenow/min/max`), and resize
 * on Left/Right through the SAME pipeline the pointer drag uses.
 */
test("L9: a splitter is keyboard-focusable and Arrow keys resize the panes", async ({ page }) => {
  // Wide viewport so the editor|center split sits well inside the MIN_FR clamp,
  // leaving room for the nudge to move aria-valuenow in both directions.
  await page.setViewportSize({ width: 2560, height: 1440 });
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  const splitter = page.locator('[data-testid="splitter"][data-left="editor"]');
  await expect(splitter).toBeVisible();
  await expect(splitter).toHaveAttribute("tabindex", "0");

  const valueNow = async () =>
    Number.parseInt((await splitter.getAttribute("aria-valuenow")) ?? "", 10);

  await splitter.focus();
  await expect(splitter).toBeFocused();
  const start = await valueNow();
  expect(Number.isNaN(start)).toBe(false);

  // ArrowRight grows the LEFT (editor) pane → its share (valuenow) increases.
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await expect.poll(valueNow).toBeGreaterThan(start);

  // ArrowLeft shrinks it back below where we grew to.
  const grew = await valueNow();
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowLeft");
  await expect.poll(valueNow).toBeLessThan(grew);
});
