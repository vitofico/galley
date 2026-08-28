import { test, expect } from "@playwright/test";

/**
 * Regression guard for the runtime web-server. The other e2es run against
 * `vite preview`, which sets NO Content-Security-Policy — so they cannot catch a
 * policy that breaks the typst compiler. This test drives the SAME built bundle
 * served by the real `@galley/web-server` (on :4178, under `DEFAULT_CSP`) and
 * asserts the compiler both initializes AND renders real glyphs:
 *
 *   - typst.ts 0.7's WASM init evaluates a JS string, so `DEFAULT_CSP` must grant
 *     `'unsafe-eval'`; without it init throws in the worker and the status hangs
 *     on "Loading compiler…".
 *   - typst.ts bundles no fonts, so the app must serve the text font set locally;
 *     without it the page lays out but renders zero glyphs (blank preview).
 *
 * Either regression turns this red (timeout on the status, or zero glyph paths).
 */
const WEB_SERVER = "http://localhost:4178";

test("compiler loads and renders glyphs under the runtime web-server CSP", async ({ page }) => {
  const cspErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /content security policy/i.test(m.text())) cspErrors.push(m.text());
  });

  const resp = await page.goto(`${WEB_SERVER}/?seed=einstein`);
  // Sanity: we really are under the production CSP (not an accidental no-CSP server).
  expect(resp?.headers()["content-security-policy"] ?? "").toContain("script-src");

  // Baseline <meta> CSP (SEC·medium: Preview SVG XSS) ships in index.html so a
  // static host with no CSP header is still protected. It coexists with the
  // header CSP here — if it broke the WASM compiler the glyph assertion below
  // would go red.
  const html = (await resp?.text()) ?? "";
  expect(html).toContain('http-equiv="Content-Security-Policy"');
  expect(html).toContain("script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'");

  // Status flips from "Loading compiler…" to a page count once WASM init succeeds.
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // The sample document renders to SVG, and that SVG contains real glyph geometry
  // (typst draws each glyph as a <path>). Zero paths ⇒ fonts didn't load.
  const preview = page.locator('[data-testid="preview"] svg').first();
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.locator("path").count(), { timeout: 30_000 }).toBeGreaterThan(0);

  expect(cspErrors, cspErrors.join("\n")).toEqual([]);
});
