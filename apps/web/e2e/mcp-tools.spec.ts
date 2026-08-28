import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";
import {
  CollabDocument,
  CollabConnection,
  WebSocketTransport,
  publishControlRequest,
  getControlResponse,
  awaitControlResponse,
  base64UrlToBytes,
  bytesToBase64Url,
  controlResponseSigningString,
  hmacControlResponse,
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
import { randomBytes, randomUUID } from "node:crypto";

/**
 * #1 slice 1 — the read-only tool mount behind per-project CONTENT CONSENT,
 * end-to-end over the REAL sync relay, without a real MCP kernel (the same
 * Node-side Yjs peer technique as agent-open-consent.spec.ts).
 *
 * The browser enables Agent Access (Settings). A kernel-shaped Node peer joins
 * the control room and drives tool requests through the control mailbox. What
 * this proves:
 *   (a) WITHOUT a grant, every tool op gets the typed `consent-required`
 *       refusal — and the response carries ZERO file text (asserted against
 *       the real content learned later);
 *   (b) WITH a grant (the human clicks "Allow file access" in Settings),
 *       read_file returns the file and search_project finds text in it;
 *   (c) a per-project revoke bites immediately, and revoking Agent Access
 *       entirely kills the room AND the grants — the NEXT session (fresh
 *       room) starts from zero grants;
 *   (d) a mutating op (propose_edit) is refused outright.
 *
 * Everything stays in ONE page load: a reload would mint a fresh, OFF manager
 * singleton (capability + grants die with the session by design).
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

/** Publish one control request and await its (well-formed) response. */
async function rpc(
  host: DocHost,
  op: string,
  params: Record<string, unknown>,
): Promise<ControlResponse> {
  const id = publishControlRequest(host, { op, params }, KERNEL_AUTHOR);
  await expect
    .poll(() => getControlResponse(host, id) !== undefined, { timeout: 30_000 })
    .toBe(true);
  return getControlResponse(host, id)!;
}

/**
 * Read the B2 pairing command (ADR-0026: `--sync … --pairing-code <code>`, no
 * secret) and run the kernel-side handshake to OBTAIN the control room + response
 * key — exactly what the real kernel does. The Node peer derives the pairing room +
 * bootstrap keys from the code, joins the pairing room, sends a claim (a MAC + a
 * nonce — never the code), and opens the AES-GCM-sealed response.
 */
async function readPairing(
  page: Page,
): Promise<{ syncUrl: string; controlRoom: string; responseKey: Uint8Array }> {
  const pairing = page.getByTestId("agent-access-pairing");
  await expect(pairing).toBeVisible({ timeout: 30_000 });
  const command = await pairing.inputValue();
  const syncMatch = command.match(/--sync\s+(\S+)/);
  const codeMatch = command.match(/--pairing-code\s+(\S+)/);
  expect(syncMatch, `pairing command had a --sync flag: ${command}`).not.toBeNull();
  expect(codeMatch, `pairing command had a --pairing-code flag (B2): ${command}`).not.toBeNull();
  expect(command).not.toContain("--response-key"); // the secret never rides in argv
  const code = codeMatch![1]!;
  const syncUrl = syncMatch![1]!.startsWith("ws")
    ? syncMatch![1]!
    : `ws://${new URL(page.url()).hostname}:1234`;

  // Derive (from the code only) the pairing room + bootstrap keys, then run the
  // ECDH handshake: mint an ephemeral key, claim (binding the real request id), open.
  const { pairingRoom, macKey, codeSecret } = await deriveBootstrap(code);
  const peer = joinControlRoomAsPeer(syncUrl, pairingRoom);
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
      peer.host,
      { op: "pairing_claim", params: { ephPub: bytesToBase64Url(ephPub), nonce: nonceB64, claimMac } },
      KERNEL_AUTHOR,
      requestId,
    );
    const resp = await awaitControlResponse(peer.host, requestId, { timeoutMs: 30_000 });
    expect(resp.ok, "the browser sealed a pairing response").toBe(true);
    const { bEphPub, bClaimMac, sealed } = (resp as Extract<ControlResponse, { ok: true }>)
      .result as { bEphPub: string; bClaimMac: string; sealed: { iv: string; ct: string } };
    const browserPub = base64UrlToBytes(bEphPub)!;
    expect(
      await verifyClaimMac(
        macKey,
        { direction: "browser", ephPublicRaw: browserPub, nonce, requestId },
        bClaimMac,
      ),
      "the browser claim verifies",
    ).toBe(true);
    const sealKey = await deriveSealKey(kernelEph.privateKey, browserPub, codeSecret, nonce);
    const opened = await openPairingPayload(sealKey, sealed, { nonce: nonceB64, requestId, pairingRoom });
    expect(opened, "the sealed payload opened under the ECDH seal key").not.toBeNull();
    const controlRoom = opened!.controlRoom;
    expect(controlRoom).toMatch(/^share-/);
    const responseKey = base64UrlToBytes(opened!.responseKey);
    expect(responseKey, "the response key decodes as base64url").not.toBeNull();
    expect(responseKey!.length).toBe(32);
    return { syncUrl: opened!.syncUrl, controlRoom, responseKey: responseKey! };
  } finally {
    peer.destroy();
  }
}

/**
 * Boot the default project, open /settings IN-APP (SPA), enable Agent Access.
 * The whole flow stays ON the settings page — that is the consent surface.
 */
async function enableAgentAccess(
  page: Page,
): Promise<{ syncUrl: string; controlRoom: string; responseKey: Uint8Array }> {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("agent-access-enable").click();
  return readPairing(page);
}

test("mcp tools: per-project content consent gates the read-only tools end-to-end", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { syncUrl, controlRoom, responseKey } = await enableAgentAccess(page);
  const peer = joinControlRoomAsPeer(syncUrl, controlRoom);
  let peer2: ReturnType<typeof joinControlRoomAsPeer> | undefined;
  try {
    // -- Discover the open project's id (metadata surface, no consent needed).
    const listed = await rpc(peer.host, "list_projects", {});
    expect(listed.ok).toBe(true);
    const rows = (listed as Extract<ControlResponse, { ok: true }>).result as Array<{
      projectId: string;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    const projectId = rows[0]!.projectId;

    // ---- (a) WITHOUT a grant: typed consent-required refusal, no file data --
    const denied = await rpc(peer.host, "read_file", { projectId, path: "/main.typ" });
    expect(denied.ok).toBe(false);
    // The refusal is the STATIC consent string and NOTHING else: no `result`
    // field at all, and an error that starts with the typed marker — so the
    // pre-consent response provably carries zero file text.
    expect(denied).not.toHaveProperty("result");
    const deniedError = (denied as Extract<ControlResponse, { ok: false }>).error;
    expect(deniedError.startsWith("consent-required:")).toBe(true);
    expect(deniedError).not.toContain("|"); // never a line-numbered body
    const deniedSearch = await rpc(peer.host, "search_project", { projectId, query: "the" });
    expect(deniedSearch.ok).toBe(false);
    expect((deniedSearch as Extract<ControlResponse, { ok: false }>).error).toContain(
      "consent-required",
    );
    // list_files is content metadata behind the SAME gate.
    const deniedList = await rpc(peer.host, "list_files", { projectId });
    expect(deniedList.ok).toBe(false);

    // ---- (b) GRANT in Settings → the tools answer --------------------------
    const grantButton = page
      .locator(`[data-testid="agent-content-grant"][data-project-id="${projectId}"]`)
      .first();
    await expect(grantButton).toBeVisible({ timeout: 30_000 });
    await grantButton.click();
    await expect(
      page.locator(`[data-testid="agent-content-granted"][data-project-id="${projectId}"]`),
    ).toBeVisible();

    // list_files → pick a real path.
    const filesResp = await rpc(peer.host, "list_files", { projectId });
    expect(filesResp.ok).toBe(true);
    const filesText = (
      (filesResp as Extract<ControlResponse, { ok: true }>).result as { text: string }
    ).text;
    const firstPath = filesText.split("\n").find((line) => line.startsWith("/"));
    expect(firstPath, `list_files returned at least one path:\n${filesText}`).toBeDefined();

    // read_file → the real, line-numbered file body.
    const readResp = await rpc(peer.host, "read_file", { projectId, path: firstPath! });
    expect(readResp.ok).toBe(true);
    // HIGH-1 end-to-end: the response is HMAC-signed and verifies under the
    // key from the pairing command — exactly what the real kernel checks.
    expect(readResp.sig).toBeDefined();
    expect(readResp.sig).toBe(
      await hmacControlResponse(responseKey, controlResponseSigningString(readResp)),
    );
    const readText = (
      (readResp as Extract<ControlResponse, { ok: true }>).result as { text: string }
    ).text;
    expect(readText).toMatch(/^\s*1\| /); // line-numbered content
    // Pull a real word out of the file body to prove search returns genuine
    // project content for the granted project.
    const word = readText.match(/[A-Za-z]{5,}/)?.[0];
    expect(word, `the file body contains a searchable word:\n${readText.slice(0, 200)}`).toBeDefined();

    // search_project finds that word, attributed to the file we read.
    const searchResp = await rpc(peer.host, "search_project", { projectId, query: word! });
    expect(searchResp.ok).toBe(true);
    const searchText = (
      (searchResp as Extract<ControlResponse, { ok: true }>).result as { text: string }
    ).text;
    expect(searchText).toContain("Found");
    expect(searchText).toContain(`${firstPath}:`);

    // ---- (d) A MUTATING op is refused even while granted --------------------
    const mutate = await rpc(peer.host, "propose_edit", {
      projectId,
      edits: [{ search: word!, replace: "HACKED" }],
    });
    expect(mutate.ok).toBe(false);
    expect((mutate as Extract<ControlResponse, { ok: false }>).error).toMatch(/unsupported op/);

    // ---- (c1) Per-project revoke bites immediately ---------------------------
    await page
      .locator(`[data-testid="agent-content-revoke"][data-project-id="${projectId}"]`)
      .first()
      .click();
    await expect(
      page.locator(`[data-testid="agent-content-grant"][data-project-id="${projectId}"]`),
    ).toBeVisible();
    const reDenied = await rpc(peer.host, "read_file", { projectId, path: firstPath! });
    expect(reDenied.ok).toBe(false);
    expect((reDenied as Extract<ControlResponse, { ok: false }>).error).toContain(
      "consent-required",
    );

    // ---- (c2) Revoking Agent Access revokes EVERYTHING ----------------------
    // Re-grant first, so the full revoke demonstrably clears a LIVE grant.
    await page
      .locator(`[data-testid="agent-content-grant"][data-project-id="${projectId}"]`)
      .first()
      .click();
    const granted = await rpc(peer.host, "read_file", { projectId, path: firstPath! });
    expect(granted.ok).toBe(true);
    await page.getByTestId("agent-access-revoke").click();
    await expect(page.getByTestId("agent-access-enable")).toBeVisible();

    // Re-enable: a FRESH room (the old capability is dead) with ZERO grants.
    await page.getByTestId("agent-access-enable").click();
    const second = await readPairing(page);
    expect(second.controlRoom).not.toBe(controlRoom);
    peer2 = joinControlRoomAsPeer(second.syncUrl, second.controlRoom);
    const freshDenied = await rpc(peer2.host, "read_file", { projectId, path: firstPath! });
    expect(freshDenied.ok).toBe(false);
    expect((freshDenied as Extract<ControlResponse, { ok: false }>).error).toContain(
      "consent-required",
    );
  } finally {
    peer.destroy();
    peer2?.destroy();
  }
});
