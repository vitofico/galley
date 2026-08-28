import { test, expect } from "@playwright/test";

/**
 * Offline / standalone guard for the default single-user path.
 *
 * Galley's default mode (no `?sync`, no `?serverCompile`) compiles in-browser with
 * the bundled typst WASM running in a Web Worker, and serves its fonts locally — so
 * it must work with ZERO external network. This test drives the REAL runtime
 * web-server bundle on :4178 and aborts every request that crosses the app's own
 * origin. The app's bundle (HTML, JS, WASM, fonts, the worker) is same-origin, so it
 * still loads; anything reaching out to a sync/compile/CDN origin is killed. If the
 * default path secretly depended on the network, the compiler would never become
 * ready and/or the preview would render zero glyphs — turning this red.
 */
const WEB_SERVER = "http://localhost:4178";
const ORIGIN = new URL(WEB_SERVER).origin;

test("default single-user path compiles and renders glyphs with no external network", async ({ page }) => {
  const blocked: string[] = [];

  // Allow only same-origin (the app's own bundle); abort everything else. This
  // covers any cross-origin sync/compile/font/telemetry call the default path
  // must NOT need. `route('**')` matches every request the page makes.
  await page.route("**", (route) => {
    const url = route.request().url();
    // Same-origin app assets, plus the data:/blob: URLs the worker + WASM use.
    if (url.startsWith(ORIGIN + "/") || url === ORIGIN || url.startsWith("data:") || url.startsWith("blob:")) {
      return route.continue();
    }
    blocked.push(url);
    return route.abort();
  });

  const resp = await page.goto(`${WEB_SERVER}/?seed=einstein`);
  expect(resp?.status()).toBe(200);

  // Compiler initializes from the bundled WASM (status flips to a page count). If
  // any required byte had to come over the (blocked) network, this would time out.
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // The sample renders to SVG containing real glyph geometry (each glyph is a
  // <path>). Zero paths ⇒ fonts didn't load locally. Mirrors the CSP test.
  const preview = page.locator('[data-testid="preview"] svg').first();
  await expect(preview).toBeVisible();
  await expect
    .poll(() => preview.locator("path").count(), { timeout: 30_000 })
    .toBeGreaterThan(0);

  // No same-origin request was collateral-blocked (sanity: we didn't break the app
  // by over-aborting). Cross-origin aborts, if any, are fine — they prove isolation.
  expect(
    blocked.filter((u) => u.startsWith(ORIGIN)),
    `same-origin requests were blocked:\n${blocked.join("\n")}`,
  ).toEqual([]);
});
