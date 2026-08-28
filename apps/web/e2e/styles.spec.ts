import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * Styles feature (Phase 1) — the style-switcher wiring is USER-REACHABLE.
 *
 * This asserts the integration surface deterministically (no compile-text
 * dependency, no flaky editor typing): the "Change style…" palette command opens
 * the StyleLibrary overlay, the four bundled styles render as cards, and the
 * styleability classifier drives the UI — a blank starter doc (no /style.typ
 * import) is `non-conforming`, so a blocking notice shows and Apply is disabled.
 *
 * The apply path itself — trial-compile then a single-file /style.typ swap — is
 * covered by the `apply-style` unit tests, and every bundled style is proven to
 * compile offline by `styles-library/styles.compile.test.ts`.
 */
test("Style Library: the palette command opens the picker with the bundled styles", async ({
  page,
}) => {
  await gotoEditor(page);
  // Wait for the first compile so the editor shell is fully live.
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Open via the command palette (the registered "Change style…" command).
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("command-palette-input").fill("Change style");
  await page.getByTestId("command-palette-item").first().click();

  // The overlay is up with the four bundled styles.
  const dialog = page.getByTestId("style-library");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("style-card")).toHaveCount(4);
  await expect(dialog).toContainText("Academic");
  await expect(dialog).toContainText("Modern");
  await expect(dialog).toContainText("Minimal");
  await expect(dialog).toContainText("Journal");

  // The blank starter (`= Untitled …`) imports no /style.typ, so it's
  // non-conforming: a blocking notice shows and Apply is disabled.
  await expect(page.getByTestId("style-notice")).toBeVisible();
  await expect(page.getByTestId("style-apply")).toBeDisabled();

  // Escape closes the overlay.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
