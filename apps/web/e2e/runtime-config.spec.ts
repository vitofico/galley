import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * Roadmap #5 slice 5: runtime-config consumption. In a composed deploy the
 * runtime web-server injects a same-origin /config.js declaring
 * `window.__GALLEY_CONFIG__ = { compileUrl }` (covered by the web-server unit
 * suite). This spec proves the CONSUMER side end-to-end in a real browser: with
 * the global present (addInitScript stands in for the injected script — vite
 * preview has no web-server), the Server toggle resolves the RUNTIME URL —
 * server mode engages (no fail-closed "Server unavailable" badge, which is
 * exactly what compiler-mode.spec.ts pins for the unconfigured default) and the
 * remote compile request actually egresses to the runtime-config URL.
 */

// An origin nothing listens on: every hit is intercepted by page.route below,
// so the assertion is on RESOLUTION (which URL the client chose), not on a
// working compile service.
const RUNTIME_ORIGIN = "http://127.0.0.1:39990";
const RUNTIME_URL = `${RUNTIME_ORIGIN}/compile`;

test("slice 5: the Server toggle resolves the runtime-config compile URL", async ({ page }) => {
  // Stand-in for the web-server-injected /config.js: define the global BEFORE
  // any app code runs (exactly the ordering the real injection guarantees —
  // the tag is injected in <head> before the bundle script).
  await page.addInitScript((url) => {
    (window as unknown as { __GALLEY_CONFIG__?: { compileUrl: string } }).__GALLEY_CONFIG__ = {
      compileUrl: url,
    };
  }, RUNTIME_URL);

  // Capture every request to the runtime URL; answer 500 so the compile fails
  // fast (we assert resolution + egress target, not a successful remote compile).
  const compileRequests: string[] = [];
  await page.route(`${RUNTIME_ORIGIN}/**`, async (route) => {
    compileRequests.push(route.request().url());
    await route.fulfill({ status: 500, body: "runtime-config e2e stub" });
  });

  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // The toggle lives in the status chip's popover (#19.3).
  await page.getByTestId("status-chip").click();
  await expect(page.getByTestId("compiler-mode-toggle")).toBeVisible();

  await page.getByTestId("compiler-mode-server").click();

  // Configured via runtime config → server mode ENGAGES: the active indicator
  // shows and the fail-closed "Server unavailable" badge (the unconfigured
  // behavior pinned by compiler-mode.spec.ts) must NOT appear.
  await expect(page.getByTestId("compiler-mode-server-active")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("compiler-mode-server-unavailable")).not.toBeVisible();

  // Trigger a compile in server mode: close the popover and edit the document.
  await page.keyboard.press("Escape");
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("= Runtime config egress probe");

  // The remote compile attempt egressed to the RUNTIME-config URL.
  await expect.poll(() => compileRequests.length, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(compileRequests[0]).toContain("127.0.0.1:39990/compile");
});
