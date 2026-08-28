import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * Figure → server-side "Verify compile" (#8), proven end-to-end and HERMETIC.
 *
 * The FigurePanel generate loop uses the browser's fail-closed compiler, which
 * CANNOT resolve the `@preview/cetz` package the generated CeTZ scaffold imports —
 * so offline it can only ever say "could not verify". When a TRUSTED compile URL
 * is configured, the panel exposes a "Verify compile" affordance that re-compiles
 * the draft on a SERVER-capable compiler (which CAN resolve packages) for a real
 * clean-or-diagnostics verdict (`figure-verify.ts` / FigurePanel).
 *
 * Here the trusted URL is the package-aware :3002 compile fixture, backed by the
 * hermetic @preview registry fixture which serves a tiny CeTZ-compatible STUB
 * (`@preview/cetz:0.2.2`, crafted — not real CeTZ) exposing exactly the surface
 * `cetzScaffold` touches (`cetz.canvas`, `cetz.draw.{rect,content}`). So the
 * generated scaffold resolves + type-checks clean on the server →
 * `figure-verify-result[data-ok="true"]`. No real internet, no real CeTZ.
 *
 * We drive the REAL generate flow (offline Demo model → deterministic CeTZ
 * scaffold), then click Verify and assert the server returned ok=true — the exact
 * "could not verify offline → verified on the server" transition the feature adds.
 */
test('#8 figure verify: generated CeTZ scaffold verifies ok=true on the server', async ({ page }) => {
  // Default route = the project shell; the server flag makes a trusted compile URL
  // reachable (serverCompileReachable → FigurePanel gets a verifyCompilerFactory).
  await gotoEditor(page, { query: "serverCompile=1&compileUrl=http://localhost:3002/compile" });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // #19.2: the figure control is a tab of the rail's docked Insert panel.
  await page.getByTestId("insert-button").click();
  await page.getByTestId("figure-button").click();
  await expect(page.getByTestId("figure-panel")).toBeVisible();

  // Generate a draft (offline Demo model → deterministic cetzScaffold).
  await page.getByTestId("figure-description").fill("a box labelled Model with an arrow to Output");
  await page.getByTestId("figure-generate").click();

  // The draft is surfaced and (because a trusted server is configured) the
  // server-verify affordance is offered — NOT available on the offline path.
  await expect(page.getByTestId("figure-status")).toBeVisible({ timeout: 60_000 });
  const verifyRun = page.getByTestId("figure-verify-run");
  await expect(verifyRun).toBeVisible();

  // Run the server verify: the draft's `@preview/cetz` import resolves on the
  // server (from the hermetic registry stub), so it compiles cleanly → ok=true.
  await verifyRun.click();
  const result = page.getByTestId("figure-verify-result");
  await expect(result).toBeVisible({ timeout: 60_000 });
  await expect(result).toHaveAttribute("data-ok", "true");
});
