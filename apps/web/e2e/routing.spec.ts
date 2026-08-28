import { test, expect, type Page } from "@playwright/test";
import { gotoEditor, skipDemoSeed } from "./app-helpers.js";

/**
 * #19.4 "Rail & Islands" routing + UX sweep (spec §§5–6) acceptance e2e:
 *  - real paths (`/`, `/library`, `/p/<id>`, `/join/<room>`) direct-load (the
 *    SPA fallback serves the shell) and navigate client-side (no full reload);
 *  - browser back/forward walks the history;
 *  - the one-time ⌘K nudge shows until the palette first opens, then never again.
 */

/** Wait for the project shell to be up (the persistent-project chrome). */
async function expectProjectShell(page: Page) {
  await expect(page.getByTestId("open-library")).toBeVisible({ timeout: 60_000 });
}

/** Tag the window so a later assertion can prove no full reload happened. */
async function tagWindow(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __galleyNavProbe?: number }).__galleyNavProbe = 1;
  });
}
async function windowTagSurvived(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as { __galleyNavProbe?: number }).__galleyNavProbe === 1,
  );
}

test("direct-load: /library and /p/<id> boot their routes (SPA fallback)", async ({ page }) => {
  await page.goto("/library");
  await expect(page.getByTestId("library")).toBeVisible({ timeout: 30_000 });

  await page.goto("/p/e2e-direct-load");
  await expectProjectShell(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  expect(new URL(page.url()).pathname).toBe("/p/e2e-direct-load");
});

test("client-side navigation: brand pill → /library → open project → /p/<id>, back/forward work, no reload", async ({
  page,
}) => {
  // Keep the library deterministic for the card-count flow below (no demo seed).
  await skipDemoSeed(page);
  await gotoEditor(page);
  await expectProjectShell(page);
  await tagWindow(page);

  // The brand-pill wordmark navigates to the library THROUGH the router.
  await page.getByTestId("open-library").click();
  await expect(page.getByTestId("library")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/library");
  expect(await windowTagSurvived(page), "library nav must not reload").toBe(true);

  // Create a project and open it → /p/<id>, still client-side. Scope to the
  // created card by name: the default boot project's library registration can
  // land at any moment on a slow machine, adding a second card.
  await page.getByTestId("new-project-tile").click();
  await page.getByTestId("new-project-name").fill("Routed Thesis");
  await page.getByTestId("create-project").click();
  const routedCard = page.getByTestId("project-card").filter({ hasText: "Routed Thesis" });
  await expect(routedCard).toHaveCount(1);
  await routedCard.getByTestId("open-project").click();
  await expectProjectShell(page);
  expect(new URL(page.url()).pathname).toMatch(/^\/p\//);
  expect(await windowTagSurvived(page), "project open must not reload").toBe(true);

  // Browser back walks the history: project → library → the editor we started on.
  await page.goBack();
  await expect(page.getByTestId("library")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/library");
  await page.goBack();
  await expectProjectShell(page);
  expect(new URL(page.url()).pathname).toBe("/p/e2e");

  // And forward returns to the library.
  await page.goForward();
  await expect(page.getByTestId("library")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/library");
  expect(await windowTagSurvived(page), "back/forward must not reload").toBe(true);
});

test("the ⌘K nudge shows once and never again after the palette first opens (#19.4 onboarding)", async ({
  page,
}) => {
  await gotoEditor(page);
  await expectProjectShell(page);

  // H5: the one-time first-run chooser takes the cue slot first; dismiss it to
  // reveal the ⌘K nudge (the two share the header slot, never stacking).
  await page.getByTestId("first-run-dismiss").click();

  // First run: the nudge pill is there; clicking it opens the palette.
  const nudge = page.getByTestId("palette-nudge");
  await expect(nudge).toBeVisible();
  await nudge.click();
  await expect(page.getByTestId("command-palette")).toBeVisible();

  // Opening the palette dismissed the nudge permanently.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
  await expect(nudge).toHaveCount(0);

  // …including across a reload (the localStorage flag persisted).
  await page.reload();
  await expectProjectShell(page);
  await expect(page.getByTestId("palette-nudge")).toHaveCount(0);
});
