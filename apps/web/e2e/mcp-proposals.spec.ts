import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import {
  CollabProject,
  CollabConnection,
  WebSocketTransport,
  publishProposal,
  getProposal,
  type WebSocketLike,
} from "@galley/collab";

/**
 * #16.1 (ADR-0020) acceptance e2e — the mailbox + the mandatory browser Accept
 * gate, end-to-end over the REAL sync relay:
 *
 * The browser Shares the project from the UI (minting the capability room), a
 * NODE-side Yjs peer — the same wiring the MCP kernel uses — joins that room and
 * publishes pending proposals, and the browser surfaces each one as a review
 * card. Accept applies the text through the conflict-aware agent path (and the
 * change replicates back to the peer); Reject leaves the document untouched. The
 * MCP protocol layer itself is covered by apps/mcp's integration tests.
 */

const HERE = fileURLToPath(import.meta.url);
// `ws` is not (and must not become) a browser-app dependency; the Node-side test
// peer borrows the kernel's, resolving it from apps/mcp's dependency context.
const requireFromMcp = createRequire(resolve(HERE, "../../../mcp/package.json"));
const { WebSocket: WS } = requireFromMcp("ws") as {
  WebSocket: new (url: string) => WebSocketLike;
};

const MCP_AUTHOR = { kind: "agent", runId: "mcp" } as const;

/** A kernel-shaped Node peer joined to the shared room. */
function joinAsNodePeer(syncUrl: string, room: string) {
  const project = new CollabProject();
  const url = `${syncUrl.replace(/\/+$/, "")}/${encodeURIComponent(room)}`;
  const connection = new CollabConnection(
    project,
    new WebSocketTransport(() => new WS(url)),
    { author: MCP_AUTHOR },
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

/** The live text of the project's main file on the Node peer, or undefined. */
function mainFileText(project: CollabProject): { path: string; text: string } | undefined {
  const mainId = project.mainFileId();
  if (!mainId) return undefined;
  const file = project.getFile(mainId);
  return file && !file.deleted ? { path: file.path, text: file.text } : undefined;
}

/** Boot the default project shell and Share it; returns the sync URL + room. */
async function shareFromUi(page: Page): Promise<{ syncUrl: string; room: string }> {
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await page.getByTestId("share-button").click();
  const linkInput = page.getByTestId("share-link");
  await expect(linkInput).toBeVisible({ timeout: 30_000 });
  // #19.4: the link is `/join/<room>` (no ?sync= — a joiner derives the relay
  // from the link's origin). Derive it here the same way: ws://<host>:1234.
  const shareUrl = new URL(await linkInput.inputValue());
  expect(shareUrl.pathname).toMatch(/^\/join\//);
  const room = decodeURIComponent(shareUrl.pathname.split("/").pop() ?? "");
  const syncUrl = shareUrl.searchParams.get("sync") ?? `ws://${shareUrl.hostname}:1234`;
  expect(room).toMatch(/^share-/);
  return { syncUrl, room };
}

test("MCP proposals surface in the shared project; Accept applies through the gate, Reject leaves the text untouched", async ({
  page,
}) => {
  const { syncUrl, room } = await shareFromUi(page);
  const peer = joinAsNodePeer(syncUrl, room);
  try {
    // The Node peer converges on the shared project (the browser pushed its state up).
    await expect
      .poll(() => mainFileText(peer.project)?.text ?? "", { timeout: 30_000 })
      .toContain("Annus Mirabilis");
    const main = mainFileText(peer.project)!;

    // ---- Proposal 1: Accept ------------------------------------------------
    const marker = `MCP_ACCEPTED_${Date.now()}`;
    const baseText = main.text;
    const proposedText = `${baseText}\n${marker}\n`;
    const id1 = await publishProposal(
      peer.project,
      {
        filePath: main.path,
        baseText,
        proposedText,
        blocks: [{ search: baseText, replace: proposedText }],
        request: "Add a closing marker line",
      },
      MCP_AUTHOR,
    );

    // The browser surfaces the proposal card (request + diff + Accept/Reject).
    const card = page.getByTestId("mcp-proposal");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("mcp-proposal-request")).toHaveText(
      "Add a closing marker line",
    );
    // Until a human decides, the document is untouched (the kernel cannot land it).
    const editor = page.locator('[data-testid="editor"] .cm-content');
    await expect(editor).not.toContainText(marker);

    // Accept → the text lands in the editor and the card clears. The proposal
    // appends at the END of the demo main.typ (#20.2), past the virtualized
    // editor viewport — scroll the cursor to the end before asserting.
    await card.getByTestId("accept").click();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await expect(editor).toContainText(marker, { timeout: 30_000 });
    await expect(page.getByTestId("mcp-proposal")).toHaveCount(0);

    // The change survives in the CRDT (replicates back to the Node peer) and the
    // verdict reaches the kernel side of the mailbox.
    await expect
      .poll(() => mainFileText(peer.project)?.text ?? "", { timeout: 30_000 })
      .toContain(marker);
    await expect
      .poll(() => getProposal(peer.project, id1)?.status, { timeout: 30_000 })
      .toBe("accepted");

    // ---- Proposal 2: Reject ------------------------------------------------
    const marker2 = `MCP_REJECTED_${Date.now()}`;
    const base2 = mainFileText(peer.project)!.text;
    const id2 = await publishProposal(
      peer.project,
      {
        filePath: main.path,
        baseText: base2,
        proposedText: `${base2}\n${marker2}\n`,
        blocks: [{ search: base2, replace: `${base2}\n${marker2}\n` }],
        request: "A change the human will decline",
      },
      MCP_AUTHOR,
    );

    const card2 = page.getByTestId("mcp-proposal");
    await expect(card2).toBeVisible({ timeout: 30_000 });
    await card2.getByTestId("reject").click();
    await expect(page.getByTestId("mcp-proposal")).toHaveCount(0);

    // Rejected → byte-for-byte untouched text, verdict recorded.
    await expect
      .poll(() => getProposal(peer.project, id2)?.status, { timeout: 30_000 })
      .toBe("rejected");
    await expect(editor).not.toContainText(marker2);
    expect(mainFileText(peer.project)!.text).toBe(base2);

    // The proposal surface is gone; the shared session itself is undisturbed.
    await expect(page.getByTestId("collab-indicator")).toBeVisible();
  } finally {
    peer.destroy();
  }
});

test("ADR-0024 §4: the global pending-review badge stays visible with the agent sidebar collapsed, and opens the Accept card", async ({
  page,
}) => {
  const { syncUrl, room } = await shareFromUi(page);
  const peer = joinAsNodePeer(syncUrl, room);
  try {
    await expect
      .poll(() => mainFileText(peer.project)?.text ?? "", { timeout: 30_000 })
      .toContain("Annus Mirabilis");
    const main = mainFileText(peer.project)!;

    // Collapse the agent sidebar — historically this hid (made `inert`) the only
    // proposal-review surface, so a pending change became invisible.
    await page.getByTestId("collapse-sidebar").click();

    // A pending proposal arrives from the kernel-shaped peer.
    const marker = `MCP_BADGE_${Date.now()}`;
    const baseText = main.text;
    const proposedText = `${baseText}\n${marker}\n`;
    const id = await publishProposal(
      peer.project,
      {
        filePath: main.path,
        baseText,
        proposedText,
        blocks: [{ search: baseText, replace: proposedText }],
        request: "A change reviewed from the global badge",
      },
      MCP_AUTHOR,
    );

    // The GLOBAL badge surfaces the count even though the sidebar is collapsed —
    // historically the only review surface was inside that now-`inert` sidebar.
    const badge = page.getByTestId("pending-review-badge");
    await expect(badge).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("pending-review-count")).toHaveText("1");
    // Nothing has changed yet — the gate is mandatory.
    const editor = page.locator('[data-testid="editor"] .cm-content');
    await expect(editor).not.toContainText(marker);

    // The badge toggles the review pane. Collapse it, then click to REVEAL the
    // Accept card (the core acceptance: review is reachable from the shell root,
    // not just the sidebar).
    const pane = page.getByTestId("pending-review-pane");
    await expect(pane).toBeVisible({ timeout: 30_000 }); // editor auto-open on arrival
    await badge.click();
    await expect(pane).toHaveCount(0);
    await badge.click();
    await expect(pane).toBeVisible();
    const card = pane.getByTestId("mcp-proposal");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByTestId("accept").click();

    // The text lands and the badge clears (count → 0 ⇒ badge absent).
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await expect(editor).toContainText(marker, { timeout: 30_000 });
    await expect(page.getByTestId("pending-review-badge")).toHaveCount(0);
    await expect
      .poll(() => getProposal(peer.project, id)?.status, { timeout: 30_000 })
      .toBe("accepted");
  } finally {
    peer.destroy();
  }
});

test("ADR-0024 §4: a viewer SEES the pending-review count but gets no Accept (ask an editor)", async ({
  browser,
}) => {
  const ctxHost = await browser.newContext();
  const ctxViewer = await browser.newContext();
  let peer: ReturnType<typeof joinAsNodePeer> | null = null;
  try {
    // Host shares as a VIEW-ONLY link.
    const host = await ctxHost.newPage();
    await host.goto("/?seed=einstein");
    await expect(host.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
    await host.getByTestId("share-button").click();
    await expect(host.getByTestId("share-link")).toBeVisible({ timeout: 30_000 });
    await host.getByTestId("share-role-viewer").check();
    const viewerUrl = await host.getByTestId("share-link").inputValue();
    const shareUrl = new URL(viewerUrl);
    expect(shareUrl.searchParams.get("role")).toBe("viewer");
    const room = decodeURIComponent(shareUrl.pathname.split("/").pop() ?? "");
    const syncUrl = shareUrl.searchParams.get("sync") ?? `ws://${shareUrl.hostname}:1234`;

    // A kernel-shaped peer joins and waits for the host's content.
    peer = joinAsNodePeer(syncUrl, room);
    await expect
      .poll(() => mainFileText(peer!.project)?.text ?? "", { timeout: 30_000 })
      .toContain("Annus Mirabilis");
    const main = mainFileText(peer.project)!;

    // The viewer joins the view-only link.
    const viewer = await ctxViewer.newPage();
    await viewer.goto(viewerUrl);
    await expect(viewer.getByTestId("join-name-prompt")).toBeVisible({ timeout: 30_000 });
    await viewer.getByTestId("join-name-submit").click();
    await expect(viewer.getByTestId("open-library")).toBeVisible({ timeout: 30_000 });

    // The peer publishes a pending proposal.
    const baseText = main.text;
    await publishProposal(
      peer.project,
      {
        filePath: main.path,
        baseText,
        proposedText: `${baseText}\nVIEWER_SEES_${Date.now()}\n`,
        blocks: [{ search: baseText, replace: `${baseText}\nX\n` }],
        request: "A change a viewer cannot accept",
      },
      MCP_AUTHOR,
    );

    // The viewer SEES the count (today they'd see nothing) — but there is no
    // Accept affordance and no clickable badge button.
    await expect(viewer.getByTestId("pending-review-viewer")).toBeVisible({ timeout: 30_000 });
    await expect(viewer.getByTestId("pending-review-count")).toHaveText("1");
    await expect(viewer.getByTestId("pending-review-badge")).toHaveCount(0);
    await expect(viewer.getByTestId("accept")).toHaveCount(0);
    await expect(viewer.getByTestId("mcp-proposal")).toHaveCount(0);
  } finally {
    peer?.destroy();
    await ctxHost.close();
    await ctxViewer.close();
  }
});
