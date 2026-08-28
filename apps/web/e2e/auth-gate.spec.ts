import { test, expect, type Page } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * 14-E auth activation — the SPA boot gate, end-to-end in a real browser.
 *
 * `addInitScript` stands in for the web-server-injected /config.js (`vite
 * preview` has no web-server — exactly the runtime-config.spec.ts pattern), and
 * /auth/me is answered by route interception, so the spec drives the REAL gate
 * against both session outcomes without an IdP:
 *   (a) no session  → the full-screen sign-in card, and Sign in navigates to
 *       /auth/login carrying the current location as returnTo;
 *   (b) a session   → the app renders normally with the account chip; Sign out
 *       POSTs /auth/logout and the reload lands back on the sign-in card;
 *   (c) no flag     → the gate never mounts: a default run shows neither the
 *       checking surface nor the sign-in card (byte-for-byte today's boot).
 */

const ME = { authenticated: true, userId: "oidc:e2e-user", display: "Ada Lovelace" };

async function enableAuth(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __GALLEY_CONFIG__?: { auth: boolean } }).__GALLEY_CONFIG__ = {
      auth: true,
    };
  });
}

test("auth on, no session: the sign-in screen renders and routes to /auth/login", async ({
  page,
}) => {
  await enableAuth(page);
  await page.route("**/auth/me", (route) =>
    route.fulfill({ status: 401, json: { authenticated: false } }),
  );
  // Capture the login navigation instead of letting it 200 into the SPA shell.
  const loginRequests: string[] = [];
  await page.route("**/auth/login**", (route) => {
    loginRequests.push(route.request().url());
    return route.fulfill({ status: 200, body: "idp stand-in" });
  });

  await gotoEditor(page);
  await expect(page.getByTestId("auth-signin")).toBeVisible();
  // The app shell never mounted behind the gate.
  await expect(page.getByTestId("editor")).toHaveCount(0);

  await page.getByTestId("auth-signin-button").click();
  await expect.poll(() => loginRequests.length).toBeGreaterThan(0);
  expect(loginRequests[0]).toContain(`/auth/login?returnTo=${encodeURIComponent("/")}`);
});

test("auth on, session present: the app renders with the account chip; sign-out returns to the gate", async ({
  page,
}) => {
  await enableAuth(page);
  let loggedOut = false;
  await page.route("**/auth/me", (route) =>
    loggedOut
      ? route.fulfill({ status: 401, json: { authenticated: false } })
      : route.fulfill({ status: 200, json: ME }),
  );
  await page.route("**/auth/logout", (route) => {
    loggedOut = true;
    return route.fulfill({ status: 204 });
  });

  await gotoEditor(page);
  // The gate let the real app through.
  await expect(page.getByTestId("editor")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("auth-signin")).toHaveCount(0);

  // The account chip shows the display name from /auth/me.
  const chip = page.getByTestId("account-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Ada Lovelace");

  // Sign out: popover → POST /auth/logout → reload lands on the sign-in card.
  await chip.click();
  await expect(page.getByTestId("account-popover")).toBeVisible();
  await page.getByTestId("auth-signout").click();
  await expect(page.getByTestId("auth-signin")).toBeVisible({ timeout: 30_000 });
});

test("auth on: the /settings page carries the same account chip + popover (no self-referential Settings entry)", async ({
  page,
}) => {
  await enableAuth(page);
  await page.route("**/auth/me", (route) => route.fulfill({ status: 200, json: ME }));

  await page.goto("/settings");
  await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 60_000 });

  // The same chip as the editor / Projects header, showing the display name.
  const chip = page.getByTestId("account-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Ada Lovelace");

  // The popover opens with identity + Sign out — but NOT the "Settings" entry,
  // since you are already on the settings page.
  await chip.click();
  await expect(page.getByTestId("account-popover")).toBeVisible();
  await expect(page.getByTestId("auth-signout")).toBeVisible();
  await expect(page.getByTestId("account-settings")).toHaveCount(0);
});

test("no flag: a default run never shows the gate", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("editor")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("auth-checking")).toHaveCount(0);
  await expect(page.getByTestId("auth-signin")).toHaveCount(0);
  await expect(page.getByTestId("account-chip")).toHaveCount(0);
});
