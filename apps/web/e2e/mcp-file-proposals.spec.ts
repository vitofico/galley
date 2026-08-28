import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import {
  CollabProject,
  CollabConnection,
  WebSocketTransport,
  publishFileProposal,
  getFileProposal,
  type WebSocketLike,
} from "@galley/collab";

/**
 * `propose_files` acceptance e2e — the sibling multi-file mailbox + the mandatory
 * browser Accept gate, end-to-end over the REAL sync relay (mirrors
 * mcp-proposals.spec.ts). A Node-side kernel-shaped peer publishes a multi-file
 * change set (create + edit); the browser surfaces ONE atomic card. "Accept all"
 * applies the whole set (the new file is created and the edit lands); Reject
 * leaves everything untouched. The MCP protocol layer is covered in apps/mcp.
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

function fileTextByPath(project: CollabProject, path: string): string | undefined {
  const f = project.snapshot().files.find((x) => !x.deleted && x.path === path);
  return f?.text;
}

async function shareFromUi(page: Page): Promise<{ syncUrl: string; room: string }> {
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await page.getByTestId("share-button").click();
  const linkInput = page.getByTestId("share-link");
  await expect(linkInput).toBeVisible({ timeout: 30_000 });
  const shareUrl = new URL(await linkInput.inputValue());
  const room = decodeURIComponent(shareUrl.pathname.split("/").pop() ?? "");
  const syncUrl = shareUrl.searchParams.get("sync") ?? `ws://${shareUrl.hostname}:1234`;
  expect(room).toMatch(/^share-/);
  return { syncUrl, room };
}

test("propose_files: a multi-file card Accepts atomically (new file + edit), Reject leaves all untouched", async ({
  page,
}) => {
  const { syncUrl, room } = await shareFromUi(page);
  const peer = joinAsNodePeer(syncUrl, room);
  try {
    await expect
      .poll(() => mainFileText(peer.project)?.text ?? "", { timeout: 30_000 })
      .toContain("Annus Mirabilis");
    const main = mainFileText(peer.project)!;

    // ---- Accept all: create /chapters/intro.typ AND append an include to main.
    const stamp = Date.now();
    const newPath = `/chapters/intro-${stamp}.typ`;
    const introMarker = `INTRO_BODY_${stamp}`;
    const includeMarker = `#include "chapters/intro-${stamp}.typ"`;
    const proposedMain = `${main.text}\n${includeMarker}\n`;
    const id1 = await publishFileProposal(
      peer.project,
      {
        request: "Add an intro chapter",
        ops: [
          { kind: "create", path: newPath, baseText: "", proposedText: `= Introduction\n${introMarker}\n`, blocks: [] },
          {
            kind: "edit",
            path: main.path,
            baseText: main.text,
            proposedText: proposedMain,
            blocks: [{ search: main.text, replace: proposedMain }],
          },
        ],
      },
      MCP_AUTHOR,
    );

    const card = page.getByTestId("mcp-file-proposal");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("mcp-file-proposal-request")).toHaveText("Add an intro chapter");
    await expect(card.getByTestId("file-proposal-op")).toHaveCount(2);

    // Nothing has changed yet — the gate is mandatory.
    expect(fileTextByPath(peer.project, newPath)).toBeUndefined();

    await card.getByTestId("file-proposal-accept").click();
    await expect(page.getByTestId("mcp-file-proposal")).toHaveCount(0);

    // The whole set landed: the new file exists with its body, AND main carries
    // the include — both replicated back to the Node peer; verdict recorded.
    await expect
      .poll(() => fileTextByPath(peer.project, newPath) ?? "", { timeout: 30_000 })
      .toContain(introMarker);
    await expect
      .poll(() => mainFileText(peer.project)?.text ?? "", { timeout: 30_000 })
      .toContain(includeMarker);
    await expect
      .poll(() => getFileProposal(peer.project, id1)?.status, { timeout: 30_000 })
      .toBe("accepted");

    // ---- Reject: a second set the human declines — nothing changes.
    const base2 = mainFileText(peer.project)!.text;
    const declinePath = `/chapters/declined-${stamp}.typ`;
    const id2 = await publishFileProposal(
      peer.project,
      {
        request: "A set the human will decline",
        ops: [{ kind: "create", path: declinePath, baseText: "", proposedText: "nope\n", blocks: [] }],
      },
      MCP_AUTHOR,
    );
    const card2 = page.getByTestId("mcp-file-proposal");
    await expect(card2).toBeVisible({ timeout: 30_000 });
    await card2.getByTestId("file-proposal-reject").click();
    await expect(page.getByTestId("mcp-file-proposal")).toHaveCount(0);
    await expect
      .poll(() => getFileProposal(peer.project, id2)?.status, { timeout: 30_000 })
      .toBe("rejected");
    expect(fileTextByPath(peer.project, declinePath)).toBeUndefined();
    expect(mainFileText(peer.project)!.text).toBe(base2);
  } finally {
    peer.destroy();
  }
});

test("propose_files: a rename + delete change set Accepts atomically (file moves, other is soft-deleted)", async ({
  page,
}) => {
  const { syncUrl, room } = await shareFromUi(page);
  const peer = joinAsNodePeer(syncUrl, room);
  try {
    await expect
      .poll(() => mainFileText(peer.project)?.text ?? "", { timeout: 30_000 })
      .toContain("Annus Mirabilis");

    // Seed a scratch file from the peer so there is something to delete.
    const stamp = Date.now();
    const scratchPath = `/scratch-${stamp}.typ`;
    const movedFrom = `/draft-${stamp}.typ`;
    const movedTo = `/chapters/final-${stamp}.typ`;
    const marker = `MOVED_BODY_${stamp}`;
    peer.project.create(scratchPath, "throwaway\n", MCP_AUTHOR);
    peer.project.create(movedFrom, `= Draft\n${marker}\n`, MCP_AUTHOR);
    await expect.poll(() => fileTextByPath(peer.project, movedFrom) ?? "", { timeout: 30_000 }).toContain(marker);

    const id = await publishFileProposal(
      peer.project,
      {
        request: "Reorganize the project",
        ops: [
          { kind: "rename", path: movedFrom, newPath: movedTo, baseText: "", proposedText: "", blocks: [] },
          { kind: "delete", path: scratchPath, baseText: "", proposedText: "", blocks: [] },
        ],
      },
      MCP_AUTHOR,
    );

    const card = page.getByTestId("mcp-file-proposal");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId("file-proposal-op")).toHaveCount(2);
    // The rename row shows the destination; nothing has changed yet.
    await expect(card.getByTestId("file-proposal-op-newpath")).toHaveText(movedTo);
    expect(fileTextByPath(peer.project, movedTo)).toBeUndefined();
    expect(fileTextByPath(peer.project, scratchPath)).toBe("throwaway\n");

    await card.getByTestId("file-proposal-accept").click();
    await expect(page.getByTestId("mcp-file-proposal")).toHaveCount(0);

    // The file moved (text preserved at the new path; gone from the old) and the
    // scratch file is soft-deleted — both replicated back to the Node peer.
    await expect.poll(() => fileTextByPath(peer.project, movedTo) ?? "", { timeout: 30_000 }).toContain(marker);
    await expect.poll(() => fileTextByPath(peer.project, movedFrom), { timeout: 30_000 }).toBeUndefined();
    await expect.poll(() => fileTextByPath(peer.project, scratchPath), { timeout: 30_000 }).toBeUndefined();
    await expect.poll(() => getFileProposal(peer.project, id)?.status, { timeout: 30_000 }).toBe("accepted");
  } finally {
    peer.destroy();
  }
});

