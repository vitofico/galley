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

test("enabled, with a server that applies: the card says how to undo and lists what was applied", async ({
  page,
}) => {
  await signedIn(page, true);
  await page.route("**/auth/connector/projects", (route) =>
    route.fulfill({
      status: 200,
      json: {
        ok: true,
        appliesChanges: true,
        projects: [
          { roomId: ROOM, projectId: "proj-elsewhere", reviewMode: "auto", connectedAtMs: 1 },
        ],
      },
    }),
  );
  await page.route("**/auth/connector/tokens", (route) =>
    route.fulfill({
      status: 200,
      json: {
        ok: true,
        tokens: [
          { tokenId: "aaaaaaaaaaaaaaaa", name: "Claude chat", createdAtMs: 1, expiresAtMs: 2e12 },
        ],
      },
    }),
  );
  await page.route(`**/auth/connector/projects/${ROOM}/activity`, (route) =>
    route.fulfill({
      status: 200,
      json: {
        ok: true,
        changes: [
          {
            version: 1,
            changeId: "c1",
            state: "applied",
            atMs: 1_800_000_000_000,
            tokenId: "aaaaaaaaaaaaaaaa",
            request: "Tighten the opening",
            files: ["/main.typ"],
            ops: 1,
            bytes: 40,
            checkpointId: `${"1".repeat(13)}-${"a".repeat(64)}`,
            restorable: true,
          },
        ],
      },
    }),
  );
  await page.goto("/settings#agent-access");
  await expect(page.getByTestId("hosted-connector-status-note")).toContainText(
    "undone, not prevented",
    { timeout: 60_000 },
  );
  const activity = page.getByTestId("hosted-connector-activity");
  await activity.locator("summary").click();
  await expect(activity.locator("li")).toContainText(
    "“Tighten the opening” (/main.typ, applied), asked by Claude chat",
  );
  await expect(activity.locator("li")).toContainText("restore its checkpoint from History");
});

test("enabled: a token is created, shown once, listed without its secret, and revoked", async ({
  page,
}) => {
  await signedIn(page, true);
  await page.route("**/auth/connector/projects", (route) =>
    route.fulfill({ status: 200, json: { ok: true, projects: [] } }),
  );
  const info = {
    tokenId: "aaaaaaaaaaaaaaaa",
    name: "Claude chat",
    createdAtMs: 1_800_000_000_000,
    expiresAtMs: 1_807_776_000_000,
  };
  const secret = `gly_${"A".repeat(43)}`;
  let tokens: (typeof info)[] = [];
  const created: unknown[] = [];
  await page.route("**/auth/connector/tokens", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ status: 200, json: { ok: true, tokens } });
    created.push(route.request().postDataJSON());
    tokens = [info];
    return route.fulfill({
      status: 200,
      json: { ok: true, token: secret, ...info },
    });
  });
  await page.route(
    `**/auth/connector/tokens/${info.tokenId}/revoke`,
    (route) => {
      tokens = [];
      return route.fulfill({ status: 200, json: { ok: true } });
    },
  );

  await page.goto("/settings#agent-access");
  const create = page.getByTestId("connector-token-create");
  await expect(create).toBeDisabled({ timeout: 60_000 }); // a token needs a name
  await page.getByTestId("connector-token-name").fill("Claude chat");
  await page.getByTestId("connector-token-lifetime").selectOption("30");
  await create.click();

  await expect(page.getByTestId("connector-token-secret")).toHaveValue(secret);
  // The paste-ready address for chat apps that cannot send a header.
  await expect(page.getByTestId("connector-token-address")).toHaveValue(
    new RegExp(`^https?://[^/]+/mcp/${secret}$`),
  );
  await expect(page.getByTestId("connector-token-created")).toContainText(
    "only this once",
  );
  expect(created).toEqual([{ name: "Claude chat", expiresInDays: 30 }]);
  // The list names the token and never carries the secret.
  const row = page.getByTestId("connector-tokens").getByLabel("Token name");
  await expect(row).toHaveValue(/Claude chat \(expires /);
  await expect(page.getByTestId("connector-tokens")).not.toContainText("gly_");

  await page.getByTestId("connector-token-revoke").click();
  await expect(
    page.getByTestId("connector-tokens").getByLabel("Token name"),
  ).toHaveCount(0);
  // The secret is not re-fetchable: a reload shows no token and no secret.
  await page.reload();
  await expect(page.getByTestId("connector-token-create")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("connector-token-secret")).toHaveCount(0);
});
