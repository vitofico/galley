import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * L4 — when a previously-good document is edited into a compile error, the
 * compiler keeps the last good page on screen (`useCompiler` only re-renders the
 * SVG on a successful compile). The preview then looks clean while the only error
 * cue is the status chip / the diagnostics list. A subtle edge banner now surfaces
 * the staleness ON the preview itself ("Showing last good render · N errors").
 */
test("L4: a compile error surfaces a stale-render banner over the retained good page", async ({
  page,
}) => {
  await gotoEditor(page);

  // Wait for the first good render (status flips to a page count, SVG visible).
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.locator('[data-testid="preview"] svg').first()).toBeVisible();

  // OLD-PATH PIN: a clean, current render shows NO stale banner.
  await expect(page.getByTestId("preview-stale-notice")).toHaveCount(0);

  // Edit the document into a compile error (`#let` with no value).
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("= Title\n#let x =");

  // The compile fails: status + diagnostics report the error.
  await expect(page.getByTestId("status")).toContainText(/error/i, { timeout: 30_000 });
  await expect(page.getByTestId("diagnostics")).toContainText(/error/i);

  // L4: the stale-render banner now appears, naming the error count, while the
  // last good page is STILL on screen (the failed compile left it untouched).
  const banner = page.getByTestId("preview-stale-notice");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/last good render/i);
  await expect(banner).toContainText(/error/i);
  await expect(page.locator('[data-testid="preview"] svg').first()).toBeVisible();
});
