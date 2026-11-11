import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import {
  CollabProject,
  CollabConnection,
  WebSocketTransport,
  publishProposal,
  getProposal,
  type WebSocketLike,
} from "@galley/collab";
import { gotoEditor } from "./app-helpers.js";

/**
 * Hosted connector, Ask mode (ADR-0033 §4), over the REAL sync relay.
 *
 * A project connected to the hosted connector is kept in its connector room by
 * a link of its own, with NO Share session. A proposal the connector publishes
 * into that room must still reach the person: it surfaces as a review card,
 * the document stays untouched until Accept, and Accept applies it through the
 * same conflict-aware path as any other proposal. The connector's own HTTP
 * surface is covered by apps/mcp's tests; here a Node peer stands in for it.
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
const PROJECT = "e2e-connector-review";
const ROOM = "share-e2econnectorreview00000000000";

/** The connector, as the relay sees it: one more peer in the project's room. */
function joinAsConnector() {
  const project = new CollabProject();
  const connection = new CollabConnection(
    project,
    new WebSocketTransport(() => new WS(`ws://localhost:1234/${ROOM}`)),
  );
  connection.connect();
  return {
    project,
    destroy() {
      connection.destroy();
      project.destroy();
    },
  };
}

function mainFile(project: CollabProject) {
  const id = project.mainFileId();
  const file = id ? project.getFile(id) : undefined;
  return file && !file.deleted
    ? { path: file.path, text: file.text }
    : undefined;
}

test("a connector proposal waits for Accept in a connected project, with no Share session", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as unknown as { __GALLEY_CONFIG__?: unknown }).__GALLEY_CONFIG__ = {
      auth: true,
      hostedConnector: true,
    };
  });
  await page.route("**/auth/me", (route) =>
    route.fulfill({
      status: 200,
      json: { authenticated: true, userId: "oidc:e2e-user", display: "Ada" },
    }),
  );
  await page.route("**/auth/connector/projects", (route) =>
    route.fulfill({
      status: 200,
      json: {
        ok: true,
        projects: [
          {
            roomId: ROOM,
            projectId: PROJECT,
            reviewMode: "ask",
            connectedAtMs: 1,
          },
        ],
      },
    }),
  );

  await gotoEditor(page, { id: PROJECT });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, {
    timeout: 60_000,
  });

  const connector = joinAsConnector();
  try {
    // The browser keeps the server copy current: the peer converges on it.
    await expect
      .poll(() => mainFile(connector.project)?.text ?? "", { timeout: 30_000 })
      .not.toBe("");
    const main = mainFile(connector.project)!;

    const marker = `CONNECTOR_ACCEPTED_${Date.now()}`;
    const proposedText = `${main.text}\n${marker}\n`;
    const id = await publishProposal(
      connector.project,
      {
        filePath: main.path,
        baseText: main.text,
        proposedText,
        blocks: [{ search: main.text, replace: proposedText }],
        request: "Add a closing line",
      },
      CONNECTOR,
    );

    // The card appears although nothing was Shared from this tab.
    const card = page.getByTestId("mcp-proposal");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("mcp-proposal-request")).toHaveText(
      "Add a closing line",
    );
    await expect(page.getByTestId("share-link")).toHaveCount(0);
    const editor = page.locator('[data-testid="editor"] .cm-content');
    await expect(editor).not.toContainText(marker);

    await card.getByTestId("accept").click();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await expect(editor).toContainText(marker, { timeout: 30_000 });
    await expect(page.getByTestId("mcp-proposal")).toHaveCount(0);

    // The server copy has the change and the verdict.
    await expect
      .poll(() => mainFile(connector.project)?.text ?? "", { timeout: 30_000 })
      .toContain(marker);
    await expect
      .poll(() => getProposal(connector.project, id)?.status, {
        timeout: 30_000,
      })
      .toBe("accepted");
  } finally {
    connector.destroy();
  }
});
