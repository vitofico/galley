import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * Roadmap #3 slice 7: with `?serverCompile=1`, the browser compiles against the
 * `apps/compile` HTTP service (a `RemoteCompilerClient`) instead of the Web
 * Worker — proving the remote seam end-to-end through a real browser, real service,
 * and real WASM (in Node). Same preview/diagnostic behavior as the worker path.
 */
test("compiles the sample and locates an error via the remote compile service", async ({
  page,
}) => {
  await gotoEditor(page, {
    query: "serverCompile=1&compileUrl=http://localhost:3001/compile",
  });

  await page.getByTestId("status-chip").click();
  await page.getByTestId("compiler-mode-server").click();
  await page.getByTestId("status-chip").click();

  // The remote service compiles the sample → the status shows a page count.
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, {
    timeout: 60_000,
  });

  // The sample renders to an SVG returned by the service.
  await expect(
    page.locator('[data-testid="preview"] svg').first(),
  ).toBeVisible();

  // A syntax error round-trips through the service into a located diagnostic.
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("= Title\n#let x =");

  await expect(page.getByTestId("status")).toContainText(/error/i, {
    timeout: 30_000,
  });
  await expect(page.getByTestId("diagnostics")).toContainText(/error/i);
});

test("a failed remote preview surfaces an error instead of cached success", async ({
  page,
}) => {
  let fail = false;
  await page.route("http://localhost:3001/compile", async (route) => {
    if (fail)
      await route.fulfill({
        status: 413,
        contentType: "application/json",
        body: '{"error":"request too large"}',
      });
    else await route.continue();
  });
  await gotoEditor(page, {
    query: "serverCompile=1&compileUrl=http://localhost:3001/compile",
  });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, {
    timeout: 60_000,
  });
  await page.getByTestId("status-chip").click();
  const remoteRequest = page.waitForResponse(
    (response) =>
      response.url() === "http://localhost:3001/compile" &&
      response.request().method() === "POST",
  );
  await page.getByTestId("compiler-mode-server").click();
  expect((await remoteRequest).status()).toBe(200);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/);
  await page.getByTestId("status-chip").click();
  fail = true;
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("= Changed CV");
  await expect(page.getByTestId("status")).toContainText(/error/i, {
    timeout: 30_000,
  });
  await expect(page.getByTestId("diagnostics")).toContainText("413");
});
