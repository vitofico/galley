import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import {
  CollabProject,
  CollabConnection,
  WebSocketTransport,
  publishProposal,
  markRunOpen,
  markRunClosed,
  getProposal,
  type WebSocketLike,
} from "@galley/collab";

/**
 * ADR-0025 §5 (Task 5) run-card e2e — a run's many pending proposals collapse into
 * ONE review card with a single Accept-all, end-to-end over the REAL sync relay.
 *
 * Mirrors mcp-proposals.spec.ts: the browser Shares from the UI (minting the
 * capability room), a NODE-side kernel-shaped peer joins and publishes pending
 * proposals — here three single-file proposals sharing one `runId` — and the
 * browser surfaces ONE run card. Accept-all applies all three and the card
 * clears. A second test marks a run still-streaming (open boundary) and asserts
 * Accept-all is disabled while per-record review stays available.
 */

const HERE = fileURLToPath(import.meta.url);
const requireFromMcp = createRequire(resolve(HERE, "../../../mcp/package.json"));
const { WebSocket: WS } = requireFromMcp("ws") as {
  WebSocket: new (url: string) => WebSocketLike;
};

const MCP_AUTHOR = { kind: "agent", runId: "mcp" } as const;

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

function mainFileText(project: CollabProject): { path: string; text: string } | undefined {
  const mainId = project.mainFileId();
  if (!mainId) return undefined;
  const file = project.getFile(mainId);
  return file && !file.deleted ? { path: file.path, text: file.text } : undefined;
}

async function shareFromUi(page: Page): Promise<{ syncUrl: string; room: string }> {
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await page.getByTestId("share-button").click();
  const linkInput = page.getByTestId("share-link");
  await expect(linkInput).toBeVisible({ timeout: 30_000 });
  const shareUrl = new URL(await linkInput.inputValue());
  expect(shareUrl.pathname).toMatch(/^\/join\//);
  const room = decodeURIComponent(shareUrl.pathname.split("/").pop() ?? "");
  const syncUrl = shareUrl.searchParams.get("sync") ?? `ws://${shareUrl.hostname}:1234`;
  expect(room).toMatch(/^share-/);
  // Close the share popover (Escape) so its topbar overlay doesn't sit over the
  // run card's Accept-all in the global pending-review bar.
  await page.keyboard.press("Escape");
  await expect(linkInput).toHaveCount(0, { timeout: 30_000 });
  return { syncUrl, room };
}

/**
 * Publish `count` sequential single-file proposals on the peer, each appending its
 * own marker line, all carrying the SAME `runId` so they group into one run card.
 * Returns the ids + the markers (oldest first). Each proposal's baseText is the
 * ORIGINAL document so the markers do not depend on prior accepts landing first;
 * the browser's conflict-aware Accept re-applies each block against live text.
 */
async function publishRun(
  project: CollabProject,
  filePath: string,
  baseText: string,
  runId: string,
  count: number,
): Promise<{ ids: string[]; markers: string[] }> {
  const ids: string[] = [];
  const markers: string[] = [];
  for (let i = 0; i < count; i++) {
    const marker = `RUN_${runId}_${i}`;
    markers.push(marker);
    const proposedText = `${baseText}\n${marker}\n`;
    const id = await publishProposal(
      project,
      {
        filePath,
        baseText,
        proposedText,
        blocks: [{ search: baseText, replace: proposedText }],
        request: `Run change #${i + 1}`,
        runId,
      },
      MCP_AUTHOR,
    );
    ids.push(id);
  }
  return { ids, markers };
}

test("a run of 3 proposals shows ONE run card; Accept-all applies all and the card clears", async ({
  page,
}) => {
  const { syncUrl, room } = await shareFromUi(page);
  const peer = joinAsNodePeer(syncUrl, room);
  try {
    await expect
      .poll(() => mainFileText(peer.project)?.text ?? "", { timeout: 30_000 })
      .toContain("Annus Mirabilis");
    const main = mainFileText(peer.project)!;

    const runId = `run-${Date.now()}`;
    const { ids, markers } = await publishRun(peer.project, main.path, main.text, runId, 3);

    // ONE run card surfaces for the whole run (not three separate cards).
    const card = page.getByTestId("run-review-card");
    await expect(card).toHaveCount(1, { timeout: 30_000 });
    await expect(card.getByTestId("run-review-count")).toHaveText(/3 changes/);
    // Nothing has changed yet — the gate is mandatory.
    const editor = page.locator('[data-testid="editor"] .cm-content');
    for (const marker of markers) await expect(editor).not.toContainText(marker);

    // Accept-all applies every record in the run.
    await card.getByTestId("run-accept-all").click();

    // The run card clears once every record is applied (count → 0 ⇒ badge absent);
    // wait for that before driving the editor, so the (now-unmounted) review pane
    // no longer overlays the editor's click target.
    await expect(page.getByTestId("run-review-card")).toHaveCount(0, { timeout: 30_000 });

    // All three markers landed in the document (they append at the END of the demo
    // main.typ, past the virtualized viewport — scroll the cursor to the end first).
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    for (const marker of markers) {
      await expect(editor).toContainText(marker, { timeout: 30_000 });
    }

    // Every record's verdict reached the kernel side of the mailbox.
    for (const id of ids) {
      await expect
        .poll(() => getProposal(peer.project, id)?.status, { timeout: 30_000 })
        .toBe("accepted");
    }
  } finally {
    peer.destroy();
  }
});

test("a still-streaming run disables Accept-all but keeps per-record review", async ({ page }) => {
  const { syncUrl, room } = await shareFromUi(page);
  const peer = joinAsNodePeer(syncUrl, room);
  try {
    await expect
      .poll(() => mainFileText(peer.project)?.text ?? "", { timeout: 30_000 })
      .toContain("Annus Mirabilis");
    const main = mainFileText(peer.project)!;

    const runId = `run-stream-${Date.now()}`;
    // Mark the run OPEN (streaming) BEFORE its proposals arrive — the persisted run
    // boundary drives the card's `streaming` flag (ADR-0025 §5).
    markRunOpen(peer.project, runId, Date.now());
    await publishRun(peer.project, main.path, main.text, runId, 2);

    const card = page.getByTestId("run-review-card");
    await expect(card).toHaveCount(1, { timeout: 30_000 });
    // Accept-all is disabled while in progress; the "run in progress…" cue shows.
    await expect(card.getByTestId("run-accept-all")).toBeDisabled();
    await expect(card.getByTestId("run-review-streaming")).toBeVisible();

    // Per-record review still works: expand the card and accept one record directly.
    await card.getByTestId("run-review-expand").click();
    const firstAccept = card.getByTestId("accept").first();
    await expect(firstAccept).toBeVisible({ timeout: 30_000 });
    await firstAccept.click();
    // The second record is still pending, so the run card (and its review pane)
    // stays mounted — collapse the pane via the badge so it no longer overlays the
    // editor before driving the cursor to the end of the document.
    await page.getByTestId("pending-review-badge").click();
    await expect(page.getByTestId("pending-review-pane")).toHaveCount(0);
    const editor = page.locator('[data-testid="editor"] .cm-content');
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await expect(editor).toContainText(`RUN_${runId}_0`, { timeout: 30_000 });

    // Re-open the review pane to re-assert the run card's streaming state. With one
    // record accepted, a single record remains pending — so the card now renders as
    // the familiar single-record inline card, and the per-record Accept stays
    // available (the run review surface is never lost).
    await page.getByTestId("pending-review-badge").click();
    await expect(card).toBeVisible({ timeout: 30_000 });

    // Closing the run boundary lifts the streaming gate: the "run in progress…" cue
    // disappears (Accept-all is gated ONLY on streaming — an unsigned run still
    // applies through the same per-record review gate, never blocked on provenance).
    markRunClosed(peer.project, runId, Date.now());
    await expect(card.getByTestId("run-review-streaming")).toHaveCount(0, { timeout: 30_000 });
    // The remaining single record stays reviewable per-record (inline card).
    await expect(card.getByTestId("accept")).toBeVisible();
  } finally {
    peer.destroy();
  }
});
