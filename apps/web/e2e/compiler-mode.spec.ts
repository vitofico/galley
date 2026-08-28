import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * Mount e2e for the compile-mode toggle (Enabler E2) — Lane S mounts
 * CompilerModeToggle into both shells' topbars, scoped to the PREVIEW compiler.
 * With no trusted compile URL configured (the default preview server), choosing
 * "Server" fails CLOSED to the local compiler and surfaces a visible
 * "Server unavailable" indicator — the downgrade is never silent (E2 review C2).
 *
 * The legacy `?serverCompile=1` path (server-compile.spec.ts) is unaffected: the
 * toggle only engages when a `mode` is passed, which it now is in both shells.
 */
test("E2 compile-mode: the toggle is reachable; Server fails closed and is visible", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // #19.3: the toggle lives in the unified status chip's popover now (it's
  // configuration, not status) — still ≤2 interactions: chip → mode.
  await page.getByTestId("status-chip").click();

  // The toggle is mounted in the popover with all three modes.
  await expect(page.getByTestId("compiler-mode-toggle")).toBeVisible();
  await expect(page.getByTestId("compiler-mode-local")).toBeVisible();
  await expect(page.getByTestId("compiler-mode-server")).toBeVisible();
  await expect(page.getByTestId("compiler-mode-auto")).toBeVisible();

  // Choosing Server with no trusted compile URL surfaces the fail-closed indicator
  // and the preview keeps working on the local compiler.
  await page.getByTestId("compiler-mode-server").click();
  await expect(page.getByTestId("compiler-mode-server-unavailable")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
});
