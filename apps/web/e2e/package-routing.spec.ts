import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * Package-aware compile routing — fail-closed path (roadmap #2 / Enabler E2, Lane
 * A + F). The in-browser worker is fail-closed for Typst Universe (`@preview/…`)
 * packages. In "auto" mode, a document that imports such a package is routed to
 * the server ONLY when a TRUSTED compile URL is configured; otherwise it FAILS
 * CLOSED — we do NOT attempt a doomed local compile and we do NOT silently egress.
 * Instead the shell surfaces a generic "can't be compiled here" notice.
 *
 * The preview/CI env has no trusted compile URL configured (no
 * VITE_GALLEY_COMPILE_URL; the legacy `?serverCompile=1` hatch is not used here),
 * so auto + an `@preview` import must render the fail-closed notice.
 *
 * The POSITIVE server-routing path (auto + a trusted URL → "compiled on the
 * server" egress badge) needs the legacy `?serverCompile=1`+`?compileUrl=` hatch
 * pointed at the :3001 compile fixture; it is asserted in a follow-up so this
 * spec stays focused on the security-critical fail-closed default.
 */
test("package routing: auto + @preview import with no server fails closed (NO egress, no local compile)", async ({
  page,
}) => {
  // ACTIVE egress sentinel (C3): record every request to a compile service. The
  // fail-closed path must NOT send the document anywhere — if ANY compile POST
  // fires (e.g. to the :3001 fixture), the test fails. We watch both a network
  // listener (records what actually left) AND a route interceptor (aborts +
  // flags, so a leak can never even reach the wire).
  const egressed: string[] = [];
  const isCompileEgress = (url: string) => /\/compile(\b|\?|$)/.test(url) || /:3001\b/.test(url);
  page.on("request", (req) => {
    if (req.method() === "POST" && isCompileEgress(req.url())) egressed.push(req.url());
  });
  await page.route("**/*", (route) => {
    const req = route.request();
    if (req.method() === "POST" && isCompileEgress(req.url())) {
      egressed.push(req.url());
      return route.abort();
    }
    return route.continue();
  });

  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // The fail-closed notice is absent for the package-free default document.
  await expect(page.getByTestId("packages-unavailable")).toHaveCount(0);

  // Switch the preview compiler to Auto (the only mode that promotes packages to
  // the server when one is configured — and fails closed when none is).
  await page.getByTestId("status-chip").click();
  await page.getByTestId("compiler-mode-auto").click();
  await page.keyboard.press("Escape");

  // Author a document that imports a Universe package.
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type('#import "@preview/cetz:0.2.2"\n= Needs a package');

  // The package-routing notice lives in the status-chip popover — reopen it to read.
  await page.getByTestId("status-chip").click();

  // No trusted server → the fail-closed notice renders. We never silently
  // compiled the package doc locally, and never silently sent it anywhere.
  await expect(page.getByTestId("packages-unavailable")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("packages-unavailable")).toContainText(/@preview/i);

  // And we did NOT show a "compiled on the server" egress badge (no egress).
  await expect(page.getByTestId("packages-on-server")).toHaveCount(0);

  // The blocked package doc produced NO local compile result: we never ran the
  // doomed worker compile, so no package/import-resolution diagnostic surfaces and
  // the status never flips to an error. (The prior sample's preview is left
  // untouched by design — we don't wipe it on the blocked path.) Give the debounce
  // + any stray compile time to fire before asserting the absence.
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("status")).not.toContainText(/error/i);
  await expect(page.getByTestId("diagnostics")).toHaveCount(0);

  // PROVE no document left the browser on the fail-closed path.
  expect(egressed).toEqual([]);
});

/**
 * Package routing — POSITIVE server path (#2 / Enabler E2, Lane A). The mirror of
 * the fail-closed test above: with a TRUSTED compile URL configured (the legacy
 * `?serverCompile=1` + `?compileUrl=` dev/e2e hatch, pointed at the package-aware
 * :3002 compile fixture), an `auto`-mode document that imports an `@preview`
 * package is PROMOTED to the server — which resolves the package from the hermetic
 * registry fixture — and compiles. The browser that fails CLOSED offline now
 * SUCCEEDS via the server, with the honest "compiled on the server" egress badge.
 *
 * The package is our crafted `@preview/galleytest:0.1.0` fixture (NOT real
 * Universe), resolved entirely offline through the local registry fixture.
 */
test("package routing: auto + @preview import WITH a trusted server resolves on the server (badge + render)", async ({
  page,
}) => {
  // The package-aware compile service (registry-backed) lives on :3002.
  await gotoEditor(page, { query: "serverCompile=1&compileUrl=http://localhost:3002/compile" });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Auto mode is the one that promotes a package doc to the server when trusted.
  await page.getByTestId("status-chip").click();
  await page.getByTestId("compiler-mode-auto").click();
  await page.keyboard.press("Escape");

  // Author a doc importing our fixture package and USING one of its symbols, so a
  // successful render proves the package actually resolved (not just parsed).
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(
    '#import "@preview/galleytest:0.1.0": greet, answer\n= Galley\n#greet("world") — #answer',
  );

  // The package-routing notice lives in the status-chip popover — reopen it to read.
  await page.getByTestId("status-chip").click();

  // The honest server-egress badge appears: this doc went to the configured
  // compile service to resolve its packages (the path we fail CLOSED on offline).
  await expect(page.getByTestId("packages-on-server")).toBeVisible({ timeout: 30_000 });
  // And we are NOT in the fail-closed state — the package WAS resolvable here.
  await expect(page.getByTestId("packages-unavailable")).toHaveCount(0);

  // Close the popover so the preview/render assertions below are unobstructed.
  await page.keyboard.press("Escape");

  // The server compile SUCCEEDED: the status shows a page count and the package
  // doc renders to an SVG. Offline this would have been the blocked notice.
  await expect(page.getByTestId("status")).toContainText(/page\(s\)/, { timeout: 30_000 });
  await expect(page.locator('[data-testid="preview"] svg').first()).toBeVisible();
  // No compile error surfaced — the `@preview/galleytest` import resolved clean.
  await expect(page.getByTestId("status")).not.toContainText(/error/i);
});
