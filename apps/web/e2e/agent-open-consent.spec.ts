import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test, expect, type Page } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";
import {
  CollabDocument,
  CollabConnection,
  WebSocketTransport,
  publishControlRequest,
  getControlResponse,
  awaitControlResponse,
  bytesToBase64Url,
  base64UrlToBytes,
  deriveBootstrap,
  generateEphemeralKeyPair,
  exportEphemeralPublic,
  deriveSealKey,
  computeClaimMac,
  verifyClaimMac,
  openPairingPayload,
  PAIRING_NONCE_BYTES,
  type DocHost,
  type WebSocketLike,
  type ControlResponse,
} from "@galley/collab";
import { createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * #16.3 open_project bridge — the per-request consent flow, end-to-end over the
 * REAL sync relay, WITHOUT a real MCP kernel:
 *
 * The browser enables Agent Access (minting a CSPRNG control room and exposing
 * the `galley-mcp …` pairing command). A NODE-side Yjs peer — the same wiring
 * the kernel uses — joins that control room and publishes control requests. We
 * first discover the open project's id (list_projects), then drive open_project:
 *   - Deny → the responder publishes an ok:false refusal and NO share happens.
 *   - Approve → the browser mints a share room and the responder publishes
 *     ok:true with {syncUrl, room, projectId, mainFile}.
 *
 * Everything stays in ONE page load: Agent Access is enabled via the IN-APP
 * (SPA) settings route so the manager singleton + the ProjectApp consent handler
 * both survive (a full reload would mint a fresh, OFF singleton — capability dies
 * with the tab by design).
 */

const HERE = fileURLToPath(import.meta.url);
// `ws` is the kernel's dependency, not the web app's; borrow it from apps/mcp.
const requireFromMcp = createRequire(resolve(HERE, "../../../mcp/package.json"));
const { WebSocket: WS } = requireFromMcp("ws") as {
  WebSocket: new (url: string) => WebSocketLike;
};

const KERNEL_AUTHOR = { kind: "human", userId: "test-kernel" } as const;

/** A kernel-shaped Node peer joined to the control room; its doc is the mailbox host. */
function joinControlRoomAsPeer(syncUrl: string, controlRoom: string) {
  const doc = new CollabDocument("");
  const url = `${syncUrl.replace(/\/+$/, "")}/${encodeURIComponent(controlRoom)}`;
  const connection = new CollabConnection(
    doc,
    new WebSocketTransport(() => new WS(url)),
    { author: KERNEL_AUTHOR },
  );
  connection.connect();
  const host: DocHost = { doc: doc.doc };
  return {
    host,
    destroy() {
      connection.destroy();
      doc.destroy();
    },
  };
}

/**
 * Boot the default project, open /settings IN-APP (SPA), enable Agent Access,
 * read the pairing command, then go Back to the editor (SPA) so the ProjectApp
 * consent handler is mounted. Returns the relay + control room.
 */
async function enableAgentAccess(page: Page): Promise<{ syncUrl: string; controlRoom: string; responseKey: Uint8Array }> {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  // Open settings via the in-app shortcut (SPA navigation — no reload).
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("agent-access-enable").click();
  const pairing = page.getByTestId("agent-access-pairing");
  await expect(pairing).toBeVisible({ timeout: 30_000 });
  const command = await pairing.inputValue();
  const syncMatch = command.match(/--sync\s+(\S+)/);
  const codeMatch = command.match(/--pairing-code\s+(\S+)/);
  expect(syncMatch, `pairing command had a --sync flag: ${command}`).not.toBeNull();
  expect(codeMatch, `pairing command had a --pairing-code flag (B2): ${command}`).not.toBeNull();
  const syncUrl = syncMatch![1]!.startsWith("ws")
    ? syncMatch![1]!
    : `ws://${new URL(page.url()).hostname}:1234`;
  // B2 (ADR-0026): run the kernel-side ECDH handshake to OBTAIN the control room
  // (the command carries only the one-time code).
  const { pairingRoom, macKey, codeSecret } = await deriveBootstrap(codeMatch![1]!);
  const pairPeer = joinControlRoomAsPeer(syncUrl, pairingRoom);
  let controlRoom: string;
  let responseKey: Uint8Array;
  try {
    const kernelEph = await generateEphemeralKeyPair();
    const ephPub = await exportEphemeralPublic(kernelEph);
    const nonce = new Uint8Array(randomBytes(PAIRING_NONCE_BYTES));
    const nonceB64 = bytesToBase64Url(nonce);
    const requestId = randomUUID();
    const claimMac = await computeClaimMac(macKey, {
      direction: "kernel",
      ephPublicRaw: ephPub,
      nonce,
      requestId,
    });
    publishControlRequest(
      pairPeer.host,
      { op: "pairing_claim", params: { ephPub: bytesToBase64Url(ephPub), nonce: nonceB64, claimMac } },
      KERNEL_AUTHOR,
      requestId,
    );
    const resp = await awaitControlResponse(pairPeer.host, requestId, { timeoutMs: 30_000 });
    expect(resp.ok).toBe(true);
    const { bEphPub, bClaimMac, sealed } = (resp as Extract<ControlResponse, { ok: true }>)
      .result as { bEphPub: string; bClaimMac: string; sealed: { iv: string; ct: string } };
    const browserPub = base64UrlToBytes(bEphPub)!;
    expect(
      await verifyClaimMac(
        macKey,
        { direction: "browser", ephPublicRaw: browserPub, nonce, requestId },
        bClaimMac,
      ),
    ).toBe(true);
    const sealKey = await deriveSealKey(kernelEph.privateKey, browserPub, codeSecret, nonce);
    const opened = await openPairingPayload(sealKey, sealed, { nonce: nonceB64, requestId, pairingRoom });
    expect(opened).not.toBeNull();
    controlRoom = opened!.controlRoom;
    expect(controlRoom).toMatch(/^share-/);
    responseKey = base64UrlToBytes(opened!.responseKey)!;
  } finally {
    pairPeer.destroy();
  }
  // Back to the editor (SPA) so the consent handler re-registers and the modal
  // can render. The singleton stays enabled across this in-app navigation.
  await page.getByTestId("settings-back").click();
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  return { syncUrl, controlRoom, responseKey };
}

/** Ask the responder for the open project's id via list_projects. */
async function discoverProjectId(host: DocHost): Promise<string> {
  const id = publishControlRequest(host, { op: "list_projects", params: {} }, KERNEL_AUTHOR);
  let projectId = "";
  await expect
    .poll(
      () => {
        const resp = getControlResponse(host, id);
        if (resp?.ok) {
          const rows = resp.result as Array<{ projectId: string }>;
          if (rows.length > 0) projectId = rows[0]!.projectId;
        }
        return projectId;
      },
      { timeout: 30_000 },
    )
    .not.toBe("");
  return projectId;
}

test("agent open_project: the consent modal gates the share — Deny refuses, Approve mints a room", async ({
  page,
}) => {
  const { syncUrl, controlRoom } = await enableAgentAccess(page);
  const peer = joinControlRoomAsPeer(syncUrl, controlRoom);
  try {
    const projectId = await discoverProjectId(peer.host);
    expect(projectId.length).toBeGreaterThan(0);

    // ---- Request 1: DENY ----------------------------------------------------
    const denyId = publishControlRequest(
      peer.host,
      { op: "open_project", params: { projectId } },
      KERNEL_AUTHOR,
    );

    // (a) The blocking consent modal appears, naming the project.
    const modal = page.getByTestId("agent-open-consent");
    await expect(modal).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("agent-open-consent-ask")).toBeChecked();
    await expect(page.getByTestId("agent-open-consent-background")).not.toBeChecked();
    await expect(page.getByTestId("agent-open-consent-project")).toBeVisible();
    await expect(page.getByTestId("agent-open-consent-deny")).toBeVisible();
    await expect(page.getByTestId("agent-open-consent-approve")).toBeVisible();

    // (b) Deny → ok:false refusal; the modal closes; NO share happens.
    await page.getByTestId("agent-open-consent-deny").click();
    await expect(modal).toBeHidden({ timeout: 10_000 });
    await expect
      .poll(() => getControlResponse(peer.host, denyId)?.ok, { timeout: 30_000 })
      .toBe(false);
    const denyResp = getControlResponse(peer.host, denyId) as Extract<
      ControlResponse,
      { ok: false }
    >;
    expect(denyResp.error).toContain("declined");
    // No share happened: the Share trigger still reads "Share", not "Shared" (a
    // passive signal — clicking it would itself start a share, so we don't).
    await expect(page.getByTestId("share-button")).toHaveText(/share/i);
    await expect(page.getByTestId("share-button")).not.toHaveText(/shared/i);

    // ---- Request 2: APPROVE -------------------------------------------------
    const okId = publishControlRequest(
      peer.host,
      { op: "open_project", params: { projectId } },
      KERNEL_AUTHOR,
    );
    await expect(modal).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("agent-open-consent-approve").click();
    await expect(modal).toBeHidden({ timeout: 10_000 });

    // (c) Approve → ok:true with the full handoff payload.
    await expect
      .poll(() => getControlResponse(peer.host, okId)?.ok, { timeout: 30_000 })
      .toBe(true);
    const okResp = getControlResponse(peer.host, okId) as Extract<ControlResponse, { ok: true }>;
    const result = okResp.result as {
      syncUrl: string;
      room: string;
      projectId: string;
      mainFile: string;
    };
    expect(result.projectId).toBe(projectId);
    expect(result.room).toMatch(/^share-/);
    expect(result.room).not.toBe(controlRoom); // never the control room
    expect(result.syncUrl).toMatch(/^wss?:\/\//);
    expect(result.mainFile.length).toBeGreaterThan(0);
    // The approve path actually upgraded the session to shared (passive signal).
    await expect(page.getByTestId("share-button")).toHaveText(/shared/i);
  } finally {
    peer.destroy();
  }
});

test("agent open_project for a project that is not on screen: asks first, then switches the tab (ADR-0032)", async ({
  page,
}) => {
  const { syncUrl, controlRoom } = await enableAgentAccess(page);
  const peer = joinControlRoomAsPeer(syncUrl, controlRoom);
  try {
    // The agent creates a second project; the tab stays on the first one.
    const createId = publishControlRequest(
      peer.host,
      { op: "create_project", params: { name: "Second project" } },
      KERNEL_AUTHOR,
    );
    await expect
      .poll(() => getControlResponse(peer.host, createId)?.ok, { timeout: 30_000 })
      .toBe(true);
    const created = (
      getControlResponse(peer.host, createId) as Extract<ControlResponse, { ok: true }>
    ).result as { projectId: string };
    const startUrl = page.url();
    expect(startUrl).not.toContain(created.projectId);

    const modal = page.getByTestId("agent-open-consent");

    // ---- DENY: the dialog names the other project; the tab does not move. ----
    const denyId = publishControlRequest(
      peer.host,
      { op: "open_project", params: { projectId: created.projectId } },
      KERNEL_AUTHOR,
    );
    await expect(modal).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("agent-open-consent-project")).toHaveText("Second project");
    await expect(page.getByTestId("agent-open-consent-switch")).toBeVisible();
    await page.getByTestId("agent-open-consent-deny").click();
    await expect(modal).toBeHidden({ timeout: 10_000 });
    await expect
      .poll(() => getControlResponse(peer.host, denyId)?.ok, { timeout: 30_000 })
      .toBe(false);
    expect(page.url()).toBe(startUrl);

    // ---- APPROVE: the tab switches and that project is shared, in one click. ----
    const okId = publishControlRequest(
      peer.host,
      { op: "open_project", params: { projectId: created.projectId } },
      KERNEL_AUTHOR,
    );
    await expect(modal).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("agent-open-consent-approve").click();
    await expect(modal).toBeHidden({ timeout: 10_000 });
    await expect(page).toHaveURL(new RegExp(`/p/${created.projectId}$`), { timeout: 30_000 });
    await expect
      .poll(() => getControlResponse(peer.host, okId)?.ok, { timeout: 30_000 })
      .toBe(true);
    const result = (getControlResponse(peer.host, okId) as Extract<ControlResponse, { ok: true }>)
      .result as { projectId: string; room: string };
    expect(result.projectId).toBe(created.projectId);
    expect(result.room).toMatch(/^share-/);
    // No second dialog on the destination page: consent was given once.
    await expect(modal).toBeHidden();
    await expect(page.getByTestId("share-button")).toHaveText(/shared/i);
  } finally {
    peer.destroy();
  }
});

test("real stdio kernel reuses one approval and uploads a mixed binary project", async ({ page }) => {
  test.setTimeout(180_000);
  const { syncUrl, controlRoom, responseKey } = await enableAgentAccess(page);
  const { Client } = await import(pathToFileURL(requireFromMcp.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
  const { StdioClientTransport } = await import(pathToFileURL(requireFromMcp.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href);
  let client = new Client({ name: "galley-binary-import-e2e", version: "1.0.0" });
  const stateDir = await mkdtemp(resolve(tmpdir(), "galley-kernel-reconnect-"));
  const makeTransport = () => new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../../mcp/bin/galley-mcp.mjs", import.meta.url)), "--sync", syncUrl],
    env: {
      GALLEY_MCP_PAIRING_FILE: resolve(stateDir, "pairing.json"),
      GALLEY_MCP_CONTROL_ROOM: controlRoom,
      GALLEY_MCP_RESPONSE_KEY: bytesToBase64Url(responseKey),
    },
    stderr: "ignore",
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
    expect(result.isError, `MCP ${name} succeeded`).not.toBe(true);
    return JSON.parse(result.content[0].text);
  };
  try {
    await client.connect(makeTransport());
    await client.listTools();
    const { projects } = await call("list_projects");
    const projectId = projects[0].projectId;
    const opening = call("open_project", { projectId });
    await expect(page.getByTestId("agent-open-consent")).toBeVisible();
    await page.getByTestId("agent-open-consent-auto").check();
    await page.getByTestId("agent-open-consent-background").check();
    await page.getByTestId("agent-open-consent-approve").click();
    expect((await opening).status).toBe("opened");
    await client.listTools();
    expect(await call("open_project", { projectId })).toMatchObject({ status: "opened", reused: true });
    await expect(page.getByTestId("agent-open-consent")).toBeHidden();

    // A name refresh replaces awareness presence; it must retain Auto ownership.
    await page.getByTestId("share-button").click();
    await page.getByTestId("share-display-name").fill("CV import host");
    await page.getByTestId("share-display-name-save").click();
    await page.getByTestId("share-button").click();

    const before = await call("read_document");
    await call("propose_edit", { request: "First kernel single-file edit", edits: [
      { search: before.text, replace: before.text + "\n// First kernel sequence check\n" },
    ] });
    await expect.poll(async () => (await call("read_document")).text).toContain("First kernel sequence check");
    const original = await call("read_document");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");
    const font = await readFile(fileURLToPath(new URL("../public/fonts/NewCMMath-Book.otf", import.meta.url)));
    const assets = [
      { path: "/photo.png", bytes: png },
      { path: "/fonts/math.otf", bytes: font },
      { path: "/CV.pdf", bytes: pdf },
    ];
    const proposal = await call("propose_files", {
      request: "Import a Typst document with its photo, font and PDF in one approval",
      ops: [
        { kind: "edit", path: "/main.typ", edits: [{ search: original.text, replace: '= CV import\n#image("photo.png")\n' }] },
        ...assets.map(({ path, bytes }) => ({ kind: "create-binary", path, bytes: bytes.toString("base64") })),
      ],
    });
    expect(["applied", "pending_review"]).toContain(proposal.status);
    for (const asset of assets) {
      const hash = createHash("sha256").update(asset.bytes).digest("hex");
      await expect.poll(async () => {
        const result = await client.callTool({ name: "read_file", arguments: { path: asset.path } });
        if (result.isError) return null;
        return JSON.parse(result.content[0].text).hash;
      }).toBe(hash);
    }
    await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
    // Keep the SAME mounted browser and its replay high-water marks while a
    // fresh OS process reuses the grant. Reloading here hid sequence rollback.
    await client.close();
    client = new Client({ name: "galley-reconnect-e2e", version: "1.0.0" });
    await client.connect(makeTransport());
    await client.listTools();
    expect((await call("open_project", { projectId })).status).toBe("opened");
    await client.listTools();
    await expect(page.getByTestId("agent-open-consent")).toBeHidden();
    expect((await call("read_document")).text).toContain("= CV import");
    await call("propose_edit", { request: "Fresh kernel single-file edit without tab reload", edits: [
      { search: "CV import", replace: "CV import resumed" },
    ] });
    await expect.poll(async () => (await call("read_document")).text).toContain("CV import resumed");
    await page.getByTestId("share-button").click();
    await page.getByTestId("share-display-name").fill("CV reconnected host");
    await page.getByTestId("share-display-name-save").click();
    await page.getByTestId("share-button").click();
    await call("propose_files", {
      request: "Reuse the approved project after reconnect",
      ops: [
        {
          kind: "rename",
          path: "/fonts/math.otf",
          newPath: "/fonts/renamed.otf",
        },
        {
          kind: "edit",
          path: "/main.typ",
          edits: [{ search: "CV import", replace: "CV reconnected" }],
        },
      ],
    });
    await expect
      .poll(async () => (await call("read_document")).text)
      .toContain("CV reconnected");
    expect((await call("read_file", { path: "/fonts/renamed.otf" })).hash).toBe(
      createHash("sha256").update(font).digest("hex"),
    );
    await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, {
      timeout: 60_000,
    });
    expect(await call("compile")).toMatchObject({
      ok: true,
      source: "browser",
    });

    // A later browser reload must also keep the grant and updated binary file.
    await page.reload();
    await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
    await expect(page.getByTestId("agent-mode-auto")).toBeChecked();
    await page.keyboard.press("ControlOrMeta+,");
    await expect(page.getByTestId("agent-background-active")).toBeVisible();
  } finally {
    await client.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
