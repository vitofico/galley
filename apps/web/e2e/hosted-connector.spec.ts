import { test, expect, type Page } from "@playwright/test";

/**
 * Hosted connector settings (ADR-0033 §1, §3), in a real browser.
 *
 * `addInitScript` stands in for the web-server's /config.js and the `/auth/*`
 * routes are answered by interception (the auth-gate.spec.ts pattern), so the
 * card is driven without an IdP or a relay:
 *   - by default it does not exist: Agent Access is the one card it always was;
 *   - where the operator enabled it, a connected project can be switched
 *     between Ask and Auto and disconnected, and the card says what a server
 *     copy means before anything is connected.
 */

const ROOM = "share-0123456789abcdef0123456789abcdef";
const ME = {
  authenticated: true,
  userId: "oidc:e2e-user",
  display: "Ada Lovelace",
};

async function signedIn(page: Page, hostedConnector: boolean) {
  await page.addInitScript((enabled) => {
    (window as unknown as { __GALLEY_CONFIG__?: unknown }).__GALLEY_CONFIG__ = {
      auth: true,
      ...(enabled ? { hostedConnector: true } : {}),
    };
  }, hostedConnector);
  await page.route("**/auth/me", (route) =>
    route.fulfill({ status: 200, json: ME }),
  );
}

test("off by default: Agent Access shows no hosted connector", async ({
  page,
}) => {
  await signedIn(page, false);
  await page.goto("/settings#agent-access");
  await expect(page.getByTestId("agent-access-enable")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("hosted-connector-projects")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Hosted connector" }),
  ).toHaveCount(0);
});

test("enabled: a connected project can change review mode and be disconnected", async ({
  page,
}) => {
  await signedIn(page, true);
  let projects = [
    {
      roomId: ROOM,
      projectId: "proj-elsewhere",
      reviewMode: "ask",
      connectedAtMs: 1,
    },
  ];
  const posts: { url: string; body: unknown }[] = [];
  await page.route("**/auth/connector/projects", (route) =>
    route.fulfill({ status: 200, json: { ok: true, projects } }),
  );
  await page.route(
    `**/auth/connector/projects/${ROOM}/review-mode`,
    (route) => {
      const body = route.request().postDataJSON() as { reviewMode: string };
      posts.push({ url: route.request().url(), body });
      projects = [{ ...projects[0]!, reviewMode: body.reviewMode }];
      return route.fulfill({ status: 200, json: { ok: true } });
    },
  );
  await page.route(`**/auth/capability-rooms/${ROOM}/revoke`, (route) => {
    posts.push({ url: route.request().url(), body: null });
    projects = [];
    return route.fulfill({ status: 200, json: { ok: true } });
  });

  await page.goto("/settings#agent-access");
  // Both ways in are named, and the cost of this one is stated up front.
  await expect(page.getByRole("heading", { name: "Local bridge" })).toBeVisible(
    {
      timeout: 60_000,
    },
  );
  await expect(
    page.getByRole("heading", { name: "Hosted connector" }),
  ).toBeVisible();
  await expect(
    page.getByText("keeps a copy of it on this server"),
  ).toBeVisible();

  const list = page.getByTestId("hosted-connector-projects");
  const mode = list.getByTestId("hosted-connector-mode");
  await expect(mode).toHaveValue("ask");
  await mode.selectOption("auto");
  await expect(mode).toHaveValue("auto");
  expect(posts[0]?.body).toEqual({ reviewMode: "auto" });

  await list.getByTestId("hosted-connector-disconnect").click();
  await expect(list.getByTestId("hosted-connector-mode")).toHaveCount(0);
  expect(posts[1]?.url).toContain(`/auth/capability-rooms/${ROOM}/revoke`);
});
