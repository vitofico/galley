import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type BrowserContext } from "@playwright/test";
import {
  CollabProject,
  CollabConnection,
  WebSocketTransport,
  publishProposal,
  type WebSocketLike,
} from "@galley/collab";
import { gotoEditor, suppressCoachOverlay } from "./app-helpers.js";

/**
 * A connected project on a second device (ADR-0034), over the REAL sync relay.
 *
 * The first context holds the project and keeps its server copy current. The
 * second starts with empty storage, as a phone does: it finds the project in
 * its library because it is signed in, opens it from the server copy, and
 * accepts a proposal there. The room id reaches it only through the signed-in
 * listing and must not end up in its address or its storage.
 */

const HERE = fileURLToPath(import.meta.url);
// `ws` is not a browser-app dependency; borrow it from apps/mcp's context.
const requireFromMcp = createRequire(
  resolve(HERE, "../../../mcp/package.json"),
);
const { WebSocket: WS } = requireFromMcp("ws") as {
  WebSocket: new (url: string) => WebSocketLike;
};

const CONNECTOR = { kind: "agent", runId: "connector" } as const;

/** Sign a context in and give it the person's connected projects. */
async function signIn(
  context: BrowserContext,
  projects: { roomId: string; projectId: string; name?: string }[],
) {
  await context.addInitScript(() => {
    (window as unknown as { __GALLEY_CONFIG__?: unknown }).__GALLEY_CONFIG__ = {
      auth: true,
      hostedConnector: true,
    };
  });
  await context.route("**/auth/me", (route) =>
    route.fulfill({
      status: 200,
      json: { authenticated: true, userId: "oidc:e2e-user", display: "Ada" },
    }),
  );
  await context.route("**/auth/connector/projects", (route) =>
    route.fulfill({
      status: 200,
      json: {
        ok: true,
        projects: projects.map((p) => ({
          ...p,
          reviewMode: "ask",
          connectedAtMs: 1,
        })),
      },
    }),
  );
}

function mainFile(project: CollabProject) {
  const id = project.mainFileId();
  const file = id ? project.getFile(id) : undefined;
  return file && !file.deleted
    ? { path: file.path, text: file.text }
    : undefined;
}

test("a second device opens a connected project from the library and accepts a proposal", async ({
  browser,
}) => {
  const projectId = "e2e-second-device";
  const room = "share-e2eseconddevice000000000000000";
  const listing = [{ roomId: room, projectId, name: "My novel" }];
  const desktopCtx = await browser.newContext();
  const phoneCtx = await browser.newContext();
  const connectorProject = new CollabProject();
  const connector = new CollabConnection(
    connectorProject,
    new WebSocketTransport(() => new WS(`ws://localhost:1234/${room}`)),
  );
  try {
    await signIn(desktopCtx, listing);
    await signIn(phoneCtx, listing);

    // The device that holds the project fills the server copy.
    const desktop = await desktopCtx.newPage();
    await gotoEditor(desktop, { id: projectId });
    await expect(desktop.getByTestId("status")).toHaveText(/page\(s\)/, {
      timeout: 60_000,
    });
    connector.connect();
    await expect
      .poll(() => mainFile(connectorProject)?.text ?? "", { timeout: 30_000 })
      .not.toBe("");
    const main = mainFile(connectorProject)!;

    // The second device has nothing of its own, and lists the project anyway.
    const phone = await phoneCtx.newPage();
    await suppressCoachOverlay(phone);
    await phone.goto("/library");
    const card = phone.getByTestId("connected-project-card");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("My novel");
    await phone.getByTestId("open-connected-project").click();

    // It opens from the server copy, under the project's id.
    await expect(phone).toHaveURL(new RegExp(`/c/${projectId}$`));
    const phoneEditor = phone.locator('[data-testid="editor"] .cm-content');
    await expect(phoneEditor).toContainText(main.text.split("\n")[0]!, {
      timeout: 30_000,
    });
    await expect(phone.getByTestId("collab-indicator")).toHaveText(
      "Server copy",
    );
    await expect(phone.getByTestId("share-button")).toHaveCount(0);

    // A proposal from the connector reaches it, and Accept applies it.
    const marker = `SECOND_DEVICE_ACCEPTED_${Date.now()}`;
    const proposedText = `${main.text}\n${marker}\n`;
    await publishProposal(
      connectorProject,
      {
        filePath: main.path,
        baseText: main.text,
        proposedText,
        blocks: [{ search: main.text, replace: proposedText }],
        request: "Add a closing line",
      },
      CONNECTOR,
    );
    const proposal = phone.getByTestId("mcp-proposal");
    await expect(proposal).toBeVisible({ timeout: 30_000 });
    await proposal.getByTestId("accept").click();
    await expect(phone.getByTestId("mcp-proposal")).toHaveCount(0);

    // The device that holds the project sees the change, and nothing left to review.
    const desktopEditor = desktop.locator('[data-testid="editor"] .cm-content');
    await desktopEditor.click();
    await desktop.keyboard.press("ControlOrMeta+End");
    await expect(desktopEditor).toContainText(marker, { timeout: 30_000 });
    await expect(desktop.getByTestId("mcp-proposal")).toHaveCount(0);

    // The room id is a secret: not in the address, not in this device's storage.
    const stored = await phone.evaluate(async () => {
      const dbs = (await indexedDB.databases()).map((d) => d.name ?? "");
      const local = Object.entries(localStorage).flat();
      const session = Object.entries(sessionStorage).flat();
      return [location.href, ...dbs, ...local, ...session].join("\n");
    });
    expect(stored).not.toContain(room);
    expect(stored).toContain(`galley-connected-project-v1-${projectId}`);

    // The device that holds the project is sent to its own copy.
    await desktop.goto(`/c/${projectId}`);
    await expect(desktop).toHaveURL(new RegExp(`/p/${projectId}$`));
  } finally {
    connector.destroy();
    connectorProject.destroy();
    await desktopCtx.close();
    await phoneCtx.close();
  }
});

test("a project that is not connected to this account does not open", async ({
  context,
  page,
}) => {
  await signIn(context, []);
  await page.goto("/c/someone-elses-project");
  await expect(page.getByTestId("connected-unavailable")).toContainText(
    "not connected to your account",
  );
  await expect(page.getByTestId("editor")).toHaveCount(0);
  await page.getByTestId("connected-to-library").click();
  await expect(page.getByTestId("library")).toBeVisible();
  await expect(page.getByTestId("connected-project-card")).toHaveCount(0);
});

test("a connected project whose server copy is still empty says so", async ({
  context,
  page,
}) => {
  const projectId = "e2e-second-device-empty";
  await signIn(context, [
    { roomId: "share-e2eseconddeviceempty0000000000", projectId },
  ]);
  await suppressCoachOverlay(page);
  await page.goto(`/c/${projectId}`);
  await expect(page.getByTestId("connected-empty")).toContainText(
    "no copy of this project yet",
    { timeout: 30_000 },
  );
});
