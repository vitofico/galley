import { test, expect, type Page } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * M1 settings surface: configure a provider, see the honest privacy copy, and
 * "Test connection". Offline-deterministic: probing an unreachable endpoint
 * fails fast (maxRetries: 0) and surfaces an error.
 */
test("provider settings show privacy copy and probe failures", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("provider-settings")).toBeVisible();

  // Honest privacy copy is shown for the configured posture.
  await expect(page.getByTestId("provider-privacy")).toContainText(/document/i);

  // Point at an unreachable endpoint and test the connection.
  await page.getByTestId("provider-baseurl").fill("http://localhost:9/v1");
  await page.getByTestId("provider-model").fill("nope");
  await page.getByTestId("provider-test").click();
  await expect(page.getByTestId("provider-probe-result")).toContainText("✗", { timeout: 30_000 });
});

/**
 * #19.7 — the unified /settings surface: a lazy-loaded route on the 19.4
 * router holding every device-scoped preference (Appearance / Editor /
 * Compile / AI provider / Identity). Reachability invariant (R8): Mod-, and
 * ⌘K entries put every relocated control ≤2 interactions away; the rail-foot
 * "Aa" prefs dock is retired (its gear successor opens this page).
 */

/** Wait for the default project shell (the persistent-project chrome). */
async function expectProjectShell(page: Page) {
  await expect(page.getByTestId("open-library")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
}

test("direct-load /settings renders every section; Back returns home (Projects)", async ({
  page,
}) => {
  await page.goto("/settings");
  await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe("/settings");

  for (const section of ["appearance", "editor", "compile", "ai", "identity"]) {
    await expect(page.getByTestId(`settings-section-${section}`)).toBeVisible();
  }

  // Compile: the resolved server URL is shown read-only — this deployment
  // configures none, so the honest fail-closed copy shows.
  await expect(page.getByTestId("settings-compile-url")).toContainText("Not configured");
  await expect(page.getByTestId("compiler-mode-toggle")).toBeVisible();

  // Settings is generic (not document-scoped), so a direct-load with no origin
  // route Backs out to the home surface — the Projects page.
  await page.getByTestId("settings-back").click();
  await expect(page.getByTestId("library")).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe("/");
});

test("Compile: the not-configured branch gives a self-hoster an actionable enable hint (BUG-1)", async ({
  page,
}) => {
  await page.goto("/settings");
  await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 30_000 });

  // This deployment configures no compile URL, so the honest fail-closed copy shows…
  await expect(page.getByTestId("settings-compile-url")).toContainText("Not configured");

  // …alongside an ACTIONABLE hint naming the exact compose overlay + the URL.
  const hint = page.getByTestId("settings-compile-hint");
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("docker-compose.compile.yml");
  await expect(hint).toContainText("--profile");
  await expect(hint).toContainText("http://127.0.0.1:3001/compile");
});

test("Mod-, opens /settings from the editor; browser back returns", async ({ page }) => {
  await gotoEditor(page);
  await expectProjectShell(page);

  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/settings");

  await page.goBack();
  await expectProjectShell(page);
  expect(new URL(page.url()).pathname).toBe("/p/e2e");
});

test("Settings opened from a project returns to THAT project, not home (H6)", async ({
  page,
}) => {
  // Boot a specific project route (not the default home shell).
  await page.goto("/p/e2e-h6-return");
  await expectProjectShell(page);
  expect(new URL(page.url()).pathname).toBe("/p/e2e-h6-return");

  // Open settings — the origin route is threaded as `?from=`.
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  const settingsUrl = new URL(page.url());
  expect(settingsUrl.pathname).toBe("/settings");
  expect(settingsUrl.searchParams.get("from")).toBe("/p/e2e-h6-return");

  // Back lands on the project we left, not on `/`.
  await page.getByTestId("settings-back").click();
  await expectProjectShell(page);
  expect(new URL(page.url()).pathname).toBe("/p/e2e-h6-return");
});

test("Appearance flips the theme from /settings and the choice persists into the editor", async ({
  page,
}) => {
  // Open settings FROM the editor (⌘,) so Back returns to that editor.
  await gotoEditor(page);
  await expectProjectShell(page);
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 30_000 });

  // Light is the default (absence of the attribute); choose dark.
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", "dark");
  await page.getByTestId("settings-theme-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByTestId("settings-theme-dark")).toHaveAttribute("aria-pressed", "true");

  // The persisted choice survives into the editor shell.
  await page.getByTestId("settings-back").click();
  await expectProjectShell(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("editor prefs reachable in ≤2 interactions (⌘K → Editor settings…) and apply on return", async ({
  page,
}) => {
  await gotoEditor(page);
  await expectProjectShell(page);

  // Interaction 1: ⌘K. Interaction 2: the per-section palette entry.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.getByTestId("command-palette-input").fill("editor settings");
  await page.locator('[data-command-id="settings-editor"]').click();

  // Deep-linked to the Editor section; the relocated prefs controls are here.
  await expect(page.getByTestId("settings-page")).toBeVisible();
  expect(new URL(page.url()).hash).toBe("#editor");
  await expect(page.getByTestId("editor-prefs")).toBeVisible();

  // Change the font size; it persists (same storage the editors read at mount).
  await page.getByTestId("editor-prefs-font-size").fill("20");
  await expect
    .poll(async () => page.evaluate(() => localStorage.getItem("galley.editor.prefs.v1") ?? ""))
    .toContain("20");

  // Returning to the editor applies it (the editor reads prefs at mount).
  await page.goBack();
  await expectProjectShell(page);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const el = document.querySelector(".cm-editor");
        return el ? getComputedStyle(el).fontSize : null;
      }),
    )
    .toBe("20px");
});

test("a provider saved on /settings reaches the editor's agent panel (the headline gap)", async ({
  page,
}) => {
  // Open settings FROM the editor (⌘,) so Back returns to that editor's agent panel.
  await gotoEditor(page);
  await expectProjectShell(page);
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 30_000 });

  // The relocated ProviderSettings form, with its honest privacy copy.
  await expect(page.getByTestId("settings-provider-current")).toContainText("Demo");
  await expect(page.getByTestId("provider-settings")).toBeVisible();
  await expect(page.getByTestId("provider-privacy")).toContainText(/document/i);

  await page.getByTestId("provider-baseurl").fill("http://localhost:9/v1");
  await page.getByTestId("provider-model").fill("test-model");
  await page.getByTestId("provider-save").click();
  await expect(page.getByTestId("settings-provider-saved")).toBeVisible();
  await expect(page.getByTestId("settings-provider-current")).toContainText(
    "openai-compatible",
  );

  // The default boot's agent panel now runs on the configured provider — no
  // ?single=1 detour required anymore.
  await page.getByTestId("settings-back").click();
  await expectProjectShell(page);
  await expect(page.getByTestId("model-indicator")).toContainText("openai-compatible");
  await expect(page.getByTestId("agent-provider-hint")).toHaveCount(0);

  // "Use Demo" clears it again, shared the same way.
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await page.getByTestId("provider-use-demo").click();
  await expect(page.getByTestId("settings-provider-current")).toContainText("Demo");
});

test("AI provider: Ollama offers BOTH direct (local) and proxy (server/cluster) transports", async ({
  page,
}) => {
  await page.goto("/settings");
  await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("provider-settings")).toBeVisible();

  // Choose the Ollama provider.
  await page.getByTestId("provider-kind").selectOption("ollama");

  // It gets the SAME transport selector as every provider, defaulting to direct
  // (the zero-config local-machine path) with the on-your-machine privacy copy.
  const mode = page.getByTestId("provider-mode");
  await expect(mode).toBeVisible();
  await expect(mode).toHaveValue("direct");
  await expect(page.getByTestId("provider-mode-hint")).toContainText(/OLLAMA_ORIGINS/);
  await expect(page.getByTestId("provider-privacy")).toContainText(/stays on your machine/i);
  await expect(page.getByTestId("provider-proxyurl")).toHaveCount(0);

  // Switch to proxy → the proxy URL + upstream fields appear, and the privacy
  // copy is honest that the document leaves the browser to your own infra.
  await mode.selectOption("proxy");
  await page.getByTestId("provider-proxyurl").fill("https://galley.example/llm-token");
  await page.getByTestId("provider-upstream").fill("ollama");
  await expect(page.getByTestId("provider-privacy")).not.toContainText(/stays on your machine/i);
  await expect(page.getByTestId("provider-privacy")).toContainText(/infrastructure you control/i);

  // Save it; the proxy transport persists on the Ollama (still local) provider.
  await page.getByTestId("provider-model").fill("gpt-oss:120b-cloud");
  await page.getByTestId("provider-save").click();
  await expect(page.getByTestId("settings-provider-saved")).toBeVisible();

  const persisted = await page.evaluate(() => localStorage.getItem("galley.provider") ?? "");
  const config = JSON.parse(persisted) as {
    kind: string;
    isLocal: boolean;
    transport: { mode: string; proxyUrl?: string; upstreamId?: string };
  };
  expect(config.kind).toBe("ollama");
  expect(config.isLocal).toBe(true);
  expect(config.transport.mode).toBe("proxy");
  expect(config.transport.upstreamId).toBe("ollama");
});

test("Identity: the display name persists and is honest about when it applies", async ({
  page,
}) => {
  await page.goto("/settings");
  await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("settings-display-name").fill("Ada Lovelace");
  await page.getByTestId("settings-display-name-save").click();
  await expect(page.getByTestId("settings-display-name-saved")).toContainText(
    /next time you join or share/i,
  );

  // Persisted into the local profile (the same record presence/attribution read).
  const profile = await page.evaluate(() => localStorage.getItem("galley.localProfile") ?? "");
  expect(profile).toContain("Ada Lovelace");

  // And the field reflects the stored value on a fresh load.
  await page.reload();
  await expect(page.getByTestId("settings-display-name")).toHaveValue("Ada Lovelace");
});

/**
 * B12 — Identity prefill from login. When auth is enabled and a session is
 * present, the boot AuthGate publishes the signed-in user before any shell
 * mounts, so the Identity field starts from the IdP display name (no local
 * profile yet). The user can still override it, and the override persists.
 *
 * Auth is driven through the REAL gate exactly like auth-gate.spec.ts:
 * `addInitScript` stands in for the web-server-injected runtime config and
 * `/auth/me` is answered by route interception (no IdP).
 */
test("Identity: prefills from the signed-in account when auth is on, and the override persists (B12)", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as unknown as { __GALLEY_CONFIG__?: { auth: boolean } }).__GALLEY_CONFIG__ = {
      auth: true,
    };
  });
  await page.route("**/auth/me", (route) =>
    route.fulfill({
      status: 200,
      json: { authenticated: true, userId: "oidc:e2e-user", display: "Test User" },
    }),
  );

  await page.goto("/settings");
  await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 30_000 });

  // No local profile yet → the field starts from the auth-provided display name…
  await expect(page.getByTestId("settings-display-name")).toHaveValue("Test User");
  // …and the honest copy explains the name can be overridden.
  await expect(page.getByTestId("settings-section-identity")).toContainText(/override/i);

  // The user overrides it; the override is saved to the local profile.
  await page.getByTestId("settings-display-name").fill("Grace Hopper");
  await page.getByTestId("settings-display-name-save").click();
  await expect(page.getByTestId("settings-display-name-saved")).toBeVisible();
  const profile = await page.evaluate(() => localStorage.getItem("galley.localProfile") ?? "");
  expect(profile).toContain("Grace Hopper");

  // The override (the locally saved name) wins over the auth display on reload.
  await page.reload();
  await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("settings-display-name")).toHaveValue("Grace Hopper");
});

test("settings is off the editor chrome: no rail gear/prefs dock; ⌘, opens it; the status popover deep-links #compile", async ({
  page,
}) => {
  await gotoEditor(page);
  await expectProjectShell(page);

  // The old prefs dock affordance is gone from the shell…
  await expect(page.getByTestId("editor-prefs-button")).toHaveCount(0);
  await expect(page.getByTestId("editor-prefs")).toHaveCount(0);

  // …and so is the rail settings gear — settings is not document-scoped. It is
  // reached via ⌘, (and the Projects page / account menu), never editor chrome.
  await expect(page.getByTestId("rail-settings")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/settings");
  await page.goBack();
  await expectProjectShell(page);

  // The status chip keeps the LIVE toggle and gains the deep link to #compile.
  await page.getByTestId("status-chip").click();
  await expect(page.getByTestId("compiler-mode-toggle")).toBeVisible();
  await page.getByTestId("settings-compile-link").click();
  await expect(page.getByTestId("settings-page")).toBeVisible();
  expect(new URL(page.url()).hash).toBe("#compile");
  await expect(page.getByTestId("settings-section-compile")).toBeVisible();
});
