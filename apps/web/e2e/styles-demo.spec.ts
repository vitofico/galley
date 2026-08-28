import { test, expect } from "@playwright/test";

/**
 * Styles feature (Phase 1.5) — the Einstein showcase is now STYLEABLE.
 *
 * Unlike the blank-doc spec (styles.spec.ts), the "Annus Mirabilis" demo ships
 * a conforming `/style.typ`, so the Style Library can swap it in place: no
 * blocking notice, Apply is enabled, and applying a different bundled style
 * keeps the editor alive and re-compiling. This is the user-facing proof that
 * the demo is conforming (the unit guard is einstein-styleability.test.ts).
 */
test("Style Library: the Einstein demo is conforming — pick + apply a new style", async ({
  page,
}) => {
  // The `?seed=einstein` showcase hatch is the editor entry for the demo.
  await page.goto("/?seed=einstein");
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

  // The demo conforms: NO blocking notice and Apply is enabled (contrast with
  // the blank starter, which is non-conforming).
  await expect(page.getByTestId("style-notice")).toHaveCount(0);
  await expect(page.getByTestId("style-apply")).toBeEnabled();

  // Pick the "Modern" style card and apply it.
  await page.getByTestId("style-card").filter({ hasText: "Modern" }).click();
  await page.getByTestId("style-apply").click();

  // The overlay closes and the editor stays alive / re-compiles — the restyled
  // demo still renders pages (proven offline-compilable by
  // einstein-restyle.compile.test.ts).
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
});
