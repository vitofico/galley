import { test, expect, type Page, type Route } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * Connect GitHub — device-scoped PAT + PER-PROJECT repo target, fully offline:
 * every `api.github.com` call is route-intercepted (plus its CORS preflights),
 * no real network. Unified-git-sync (2026-06-18) makes the panel
 * destination-first; this spec pins:
 *   - Settings holds the DEVICE credential only: paste PAT → Validate → the
 *     resolved login shows; Disconnect clears it; there is NO repo selection here.
 *   - the project Git panel's destination chooser ALWAYS offers GitHub; with no
 *     connection, picking it shows the INLINE connect (no Settings bounce);
 *   - after connecting, the repo picker persists this project's target and lands
 *     on the configured destination card (with Push / Fetch / Change);
 *   - a bad token surfaces the typed error and the PAT NEVER appears in the DOM
 *     (the redaction invariant, same sentinel discipline as git-sync).
 *
 * NOTE: the LIVE GitHub push/fetch API-sequence round-trip is asserted by the
 * coordinator's e2e once `ProjectApp`'s onPush/onFetch dispatch by destination
 * kind — from this lane the panel routes Push/Fetch through those injected props
 * but the GitHub branch of the dispatch is wired in ProjectApp (a frozen file).
 */

const TOKEN = "ghp_E2E_SENTINEL_NEVER_RENDER_4242";
const API = "https://api.github.com";

/** CORS headers for fulfilled cross-origin responses (the app calls api.github.com). */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization, content-type, accept, x-github-api-version",
};

function fulfillJson(route: Route, status: number, body: unknown) {
  return route.fulfill({
    status,
    headers: { ...CORS, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** True for the CORS preflight; fulfilled empty so the real call proceeds. */
function handlePreflight(route: Route): boolean {
  if (route.request().method() === "OPTIONS") {
    void route.fulfill({ status: 204, headers: CORS });
    return true;
  }
  return false;
}

/** Seed the DEVICE connection (token+login) before any page script runs. */
async function seedConnection(page: Page) {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key!, value!),
    ["galley.githubConnect", JSON.stringify({ token: TOKEN, login: "octocat" })],
  );
}

/** GET /user route → the resolved login (the only call the config flow makes). */
async function routeUser(page: Page) {
  await page.route(`${API}/**`, async (route) => {
    if (handlePreflight(route)) return;
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === "GET" && path === "/user") {
      return fulfillJson(route, 200, { login: "octocat" });
    }
    return fulfillJson(route, 500, { message: `unrouted ${req.method()} ${path}` });
  });
}

test("settings: paste PAT → Validate shows the login; Disconnect clears; no repo selection here", async ({
  page,
}) => {
  await routeUser(page);

  await page.goto("/settings");
  const section = page.getByTestId("settings-section-github");
  await expect(section).toBeVisible({ timeout: 30_000 });

  // Honest copy: the token stays in this browser; the needed scope is named.
  await expect(section).toContainText(/stored in this browser only/i);
  await expect(section).toContainText(/repo|Contents/);

  // Paste + Validate → the resolved login shows; the password input clears.
  await page.getByTestId("github-token-input").fill(TOKEN);
  await page.getByTestId("github-validate").click();
  await expect(page.getByTestId("github-login")).toHaveText("octocat");
  await expect(page.getByTestId("github-status")).toHaveAttribute("data-ok", "true");

  // The repo selection is NOT on the device-scoped Settings card — it's per-project.
  await expect(page.getByTestId("github-repo-owner")).toHaveCount(0);
  await expect(page.getByTestId("github-repo-save")).toHaveCount(0);

  // The connection survives a reload; the token never renders.
  await page.reload();
  await expect(page.getByTestId("github-login")).toHaveText("octocat", { timeout: 30_000 });
  expect(await page.content()).not.toContain(TOKEN);

  // Disconnect wipes it: back to the paste-a-PAT state.
  await page.getByTestId("github-disconnect").click();
  await expect(page.getByTestId("github-token-input")).toBeVisible();
  await expect(page.getByTestId("github-login")).toHaveCount(0);
});

test("chooser always offers GitHub; with no connection, picking it shows the inline connect", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await page.getByTestId("git-sync-button").click();
  await expect(page.getByTestId("git-sync-panel")).toBeVisible();

  // Destination-first: the chooser offers both kinds regardless of connection.
  await expect(page.getByTestId("git-dest-chooser")).toBeVisible();
  await expect(page.getByTestId("git-dest-github")).toBeVisible();

  // Pick GitHub with no stored connection → the inline connect (no Settings bounce).
  await page.getByTestId("git-dest-github").click();
  await expect(page.getByTestId("git-sync-connect")).toBeVisible();
  await expect(page.getByTestId("github-token-input")).toBeVisible();
  // The repo picker is hidden until connected.
  await expect(page.getByTestId("github-repo-owner")).toHaveCount(0);
});

test("inline connect → pick the per-project repo → land on the configured card", async ({
  page,
}) => {
  await routeUser(page);

  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await page.getByTestId("git-sync-button").click();
  await expect(page.getByTestId("git-sync-panel")).toBeVisible();

  // Pick GitHub → inline connect → paste PAT → Connect.
  await page.getByTestId("git-dest-github").click();
  await page.getByTestId("github-token-input").fill(TOKEN);
  await page.getByTestId("github-validate").click();

  // Connected → the repo picker renders, owner prefilled from the login.
  await expect(page.getByTestId("git-sync-github")).toBeVisible();
  await expect(page.getByTestId("github-repo-owner")).toHaveValue("octocat");

  // Choose this project's repository and save it → the configured card.
  await page.getByTestId("github-repo-name").fill("paper");
  await page.getByTestId("github-repo-save").click();
  await expect(page.getByTestId("git-dest-configured")).toBeVisible();
  await expect(page.getByTestId("git-dest-summary-repo")).toContainText("octocat/paper");
  await expect(page.getByTestId("git-dest-summary-branch")).toContainText("main");
  await expect(page.getByTestId("git-dest-summary-identity")).toContainText("octocat");
  await expect(page.getByTestId("git-sync-push")).toBeVisible();
  await expect(page.getByTestId("git-sync-fetch")).toBeVisible();

  // The destination persists for THIS project across a reopen (per-project + kind).
  await page.getByTestId("git-sync-panel").getByRole("button", { name: "Close" }).click();
  await page.getByTestId("git-sync-button").click();
  await expect(page.getByTestId("git-dest-configured")).toBeVisible();
  await expect(page.getByTestId("git-dest-summary-repo")).toContainText("octocat/paper");

  // The token is nowhere in the DOM.
  expect(await page.content()).not.toContain(TOKEN);
});

test("pre-seeded connection: picking GitHub goes straight to the repo picker", async ({
  page,
}) => {
  await seedConnection(page);

  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await page.getByTestId("git-sync-button").click();
  await page.getByTestId("git-dest-github").click();

  // Already connected → no inline connect; straight to the repo picker.
  await expect(page.getByTestId("git-sync-connect")).toHaveCount(0);
  await expect(page.getByTestId("git-sync-github")).toBeVisible();
  await expect(page.getByTestId("github-repo-owner")).toHaveValue("octocat");

  await page.getByTestId("github-repo-name").fill("paper");
  await page.getByTestId("github-repo-save").click();
  await expect(page.getByTestId("git-dest-configured")).toBeVisible();
  await expect(page.getByTestId("git-dest-summary-repo")).toContainText("octocat/paper");

  // Token stays out of the DOM.
  expect(await page.content()).not.toContain(TOKEN);
});

test("GitHub fetch round-trip: ref → commit → tree → blob surfaces an Accept-gated candidate, then imports", async ({
  page,
}) => {
  // The coordinator's piece (see the NOTE above): with ProjectApp dispatching by
  // destination kind, a GitHub destination's Fetch reads the repo tree via the
  // REST Git Data API and routes it through the SAME Accept-gated compare overlay
  // as the generic git path — never a silent apply.
  const REMOTE_FILE = "main.typ";
  const REMOTE_TEXT = "= Hello from GitHub\n\nFetched over REST — café ☕";
  const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

  await page.route(`${API}/**`, async (route) => {
    if (handlePreflight(route)) return;
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const search = new URL(req.url()).search;
    if (req.method() === "GET" && path === "/user") {
      return fulfillJson(route, 200, { login: "octocat" });
    }
    if (path === "/repos/octocat/paper/git/ref/heads/main") {
      return fulfillJson(route, 200, { object: { sha: "commit-sha" } });
    }
    if (path === "/repos/octocat/paper/git/commits/commit-sha") {
      return fulfillJson(route, 200, { tree: { sha: "tree-sha" } });
    }
    if (path === "/repos/octocat/paper/git/trees/tree-sha" && search.includes("recursive=1")) {
      return fulfillJson(route, 200, {
        truncated: false,
        tree: [
          {
            path: REMOTE_FILE,
            type: "blob",
            sha: "blob-1",
            size: Buffer.byteLength(REMOTE_TEXT, "utf-8"),
          },
        ],
      });
    }
    if (path === "/repos/octocat/paper/git/blobs/blob-1") {
      return fulfillJson(route, 200, { content: b64(REMOTE_TEXT), encoding: "base64" });
    }
    return fulfillJson(route, 500, { message: `unrouted ${req.method()} ${path}` });
  });

  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Connect + target this project at octocat/paper, landing on the configured card.
  await page.getByTestId("git-sync-button").click();
  await page.getByTestId("git-dest-github").click();
  await page.getByTestId("github-token-input").fill(TOKEN);
  await page.getByTestId("github-validate").click();
  await page.getByTestId("github-repo-name").fill("paper");
  await page.getByTestId("github-repo-save").click();
  await expect(page.getByTestId("git-dest-configured")).toBeVisible();

  // Fetch → the candidate routes through the Accept-gated compare overlay (the
  // git panel closes, the compare opens). Nothing has mutated the project yet.
  await page.getByTestId("git-sync-fetch").click();
  const compare = page.getByTestId("version-compare");
  await expect(compare).toBeVisible({ timeout: 30_000 });
  await expect(compare).toContainText("GitHub"); // the otherLabel for a github fetch
  await expect(page.getByTestId("vcompare-file").filter({ hasText: REMOTE_FILE }).first()).toBeVisible();

  // Accept: "Import these changes" applies the remote tree as an explicit edit.
  await page.getByTestId("git-fetch-import").click();
  await expect(compare).toHaveCount(0);

  // The PAT never reaches the DOM at any point in the round-trip.
  expect(await page.content()).not.toContain(TOKEN);
});

test("bad token: inline connect surfaces the typed error and the PAT never reaches the DOM", async ({
  page,
}) => {
  await page.route(`${API}/**`, async (route) => {
    if (handlePreflight(route)) return;
    const req = route.request();
    if (req.method() === "GET" && new URL(req.url()).pathname === "/user") {
      return fulfillJson(route, 401, { message: "Bad credentials" });
    }
    return fulfillJson(route, 500, { message: "unrouted" });
  });

  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await page.getByTestId("git-sync-button").click();
  await page.getByTestId("git-dest-github").click();
  await page.getByTestId("github-token-input").fill(TOKEN);
  await page.getByTestId("github-validate").click();

  const status = page.getByTestId("github-status");
  await expect(status).toHaveAttribute("data-ok", "false");
  await expect(status).toContainText("401");
  await expect(status).toContainText(/Bad credentials/);

  // Still not connected; the input was cleared; the token text exists NOWHERE.
  await expect(page.getByTestId("git-sync-github")).toHaveCount(0);
  await expect(page.getByTestId("github-token-input")).toHaveValue("");
  const content = await page.content();
  expect(content).not.toContain(TOKEN);
  // Not in any encoded form either (base64 of the raw and Bearer wire forms).
  expect(content).not.toContain(Buffer.from(TOKEN, "utf-8").toString("base64"));
  expect(content).not.toContain(Buffer.from(`Bearer ${TOKEN}`, "utf-8").toString("base64"));
});
