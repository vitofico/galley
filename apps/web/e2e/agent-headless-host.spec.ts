import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import { gotoEditor, skipDemoSeed } from "./app-helpers.js";
import {
  CollabDocument,
  CollabConnection,
  CollabProject,
  WebSocketTransport,
  publishControlRequest,
  getControlResponse,
  awaitControlResponse,
  publishFileProposal,
  getFileProposal,
  deriveProposalKey,
  signProposal,
  bytesToBase64Url,
  base64UrlToBytes,
  deriveBootstrap,
  generateEphemeralKeyPair,
  exportEphemeralPublic,
  deriveSealKey,
  computeClaimMac,
  verifyClaimMac,
  openPairingPayload,
  AGENT_WORKER_PRESENCE_FIELD,
  PAIRING_NONCE_BYTES,
  type DocHost,
  type ProposalScope,
  type SignableProposal,
  type WebSocketLike,
  type ControlResponse,
} from "@galley/collab";
import { randomBytes, randomUUID } from "node:crypto";

/**
 * F13.3 apply-over-relay — the HEADLESS agent host applies a SIGNED MCP proposal
 * for a project whose editor tab is NOT foregrounded, end-to-end over the REAL
 * sync relay, WITHOUT a real MCP kernel.
 *
 * The flow the test drives (one page load, so the manager singleton + the grant
 * survive — a reload would mint a fresh OFF singleton):
 *   1. Boot the editor on a project, enable Agent Access (the kernel-side ECDH
 *      handshake recovers the session `responseKey` — the secret the kernel and
 *      browser both derive proposal keys from).
 *   2. Drive `open_project` → Approve: the browser mints a share room + records a
 *      grant; the handoff payload carries {grantId, room, syncUrl, projectId,
 *      mainFile} — the exact scope a proposal signature binds to.
 *   3. Toggle "Background agent access" ON for that project (sets `persistentAccess`
 *      on the grant + grants content access).
 *   4. Navigate the editor OFF that project (→ the library): the foreground editor
 *      unmounts, so the app-root `<AgentBackgroundHosts/>` — not the editor — owns
 *      the apply. We confirm via the host's `agentWorker` awareness presence.
 *   5. Publish a SIGNED file proposal into the share room's mailbox as the paired
 *      agent (deriveProposalKey(responseKey, scope) + signProposal). The host
 *      auto-applies it WITH NO foreground editor → assert the edit lands (exactly
 *      once) + the mailbox record flips to "accepted" (the apply seam only resolves
 *      a record after a successful checkpoint+apply, so "accepted" ⇒ the change
 *      landed under a checkpoint).
 *   6. Revoke the standing access: the host detaches (its `agentWorker` presence
 *      drops, it leaves the room, the grant/verifier clear). Publish a SECOND signed
 *      proposal and assert it does NOT apply (stays pending) — the negative control.
 *
 * Why the positive AND negative controls: an unsigned or wrong-scope proposal is
 * silently ignored, so a mis-built signature would make a one-sided test "pass" by
 * never applying. The positive proves a CORRECT signature DOES apply; the negative
 * proves the host genuinely stops after Revoke (not that applies never happen).
 *
 * Apply is asynchronous on a separate event loop — every wait is `expect.poll`, and
 * the host attach/detach barriers are the host's own awareness presence (not a
 * fixed sleep), so the negative assertion only runs once the host has provably left.
 */

const HERE = fileURLToPath(import.meta.url);
// `ws` is the kernel's dependency, not the web app's; borrow it from apps/mcp.
const requireFromMcp = createRequire(resolve(HERE, "../../../mcp/package.json"));
const { WebSocket: WS } = requireFromMcp("ws") as {
  WebSocket: new (url: string) => WebSocketLike;
};

/** The Node peer's author — the record's stored author is always forced to "mcp". */
const KERNEL_AUTHOR = { kind: "human", userId: "test-kernel" } as const;

/**
 * Pre-set the project's in-app acceptance mode to Auto BEFORE the editor boots, so
 * the grant `open_project` mints inherits Auto (`mintGrantMode`). The headless host
 * only auto-applies an `auto`-mode grant — an `ask` grant leaves every proposal for
 * the human card. Same mechanism `in-app-auto.spec` uses (a per-project localStorage
 * value keyed by the `/p/<id>` projectId), installed as an init script so it lands
 * before the first boot.
 */
async function setAutoMode(page: Page, projectId: string): Promise<void> {
  await page.addInitScript(
    ([id]) => {
      try {
        localStorage.setItem(`galley.agentAcceptanceMode.${id}`, "auto");
      } catch {
        /* storage unavailable — the grant falls back to Ask and the test fails loudly */
      }
    },
    [projectId],
  );
}

/** A Yjs peer joined to `room`; its doc hosts the mailbox + the synced project. */
interface RoomPeer {
  host: DocHost;
  connection: CollabConnection;
  project: CollabProject;
  destroy(): void;
}

/** Join `room` on `syncUrl` as a kernel-shaped Node peer (the wiring the kernel uses). */
function joinRoomAsPeer(syncUrl: string, room: string): RoomPeer {
  const doc = new CollabDocument("");
  const url = `${syncUrl.replace(/\/+$/, "")}/${encodeURIComponent(room)}`;
  const connection = new CollabConnection(
    doc,
    new WebSocketTransport(() => new WS(url)),
    { author: KERNEL_AUTHOR },
  );
  connection.connect();
  return {
    host: { doc: doc.doc },
    connection,
    project: new CollabProject(doc.doc),
    destroy() {
      connection.destroy();
      doc.destroy();
    },
  };
}

/** Whether any peer in `connection`'s room advertises the headless host's worker marker. */
function headlessHostPresent(connection: CollabConnection): boolean {
  for (const state of connection.awareness.getStates().values()) {
    if (state && (state as Record<string, unknown>)[AGENT_WORKER_PRESENCE_FIELD] === true) {
      return true;
    }
  }
  return false;
}

/** The live text of `path` in the peer's synced project view, or null when absent. */
function fileTextAt(project: CollabProject, path: string): string | null {
  const file = project.snapshot().files.find((f) => f.path === path && !f.deleted);
  return file ? file.text : null;
}

/**
 * Boot the editor on `projectId`, enable Agent Access via the in-app (SPA) settings
 * route, run the kernel-side ECDH pairing handshake to OBTAIN the control room +
 * the session `responseKey`, then return to the editor so the open_project consent
 * handler is mounted. Mirrors agent-open-consent.spec, additionally surfacing the
 * `responseKey` (the proposal-signing secret).
 */
async function enableAgentAccess(
  page: Page,
  projectId: string,
): Promise<{ syncUrl: string; controlRoom: string; responseKey: Uint8Array }> {
  await gotoEditor(page, { id: projectId });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("agent-access-enable").click();
  const pairing = page.getByTestId("agent-access-pairing");
  await expect(pairing).toBeVisible({ timeout: 30_000 });
  const command = await pairing.inputValue();
  const syncMatch = command.match(/--sync\s+(\S+)/);
  const codeMatch = command.match(/--pairing-code\s+(\S+)/);
  expect(syncMatch, `pairing command had a --sync flag: ${command}`).not.toBeNull();
  expect(codeMatch, `pairing command had a --pairing-code flag: ${command}`).not.toBeNull();
  const syncUrl = syncMatch![1]!.startsWith("ws")
    ? syncMatch![1]!
    : `ws://${new URL(page.url()).hostname}:1234`;
  // B2 (ADR-0026): the kernel-side handshake recovers the control room AND the
  // sealed responseKey from the one-time code.
  const { pairingRoom, macKey, codeSecret } = await deriveBootstrap(codeMatch![1]!);
  const pairPeer = joinRoomAsPeer(syncUrl, pairingRoom);
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
      await verifyClaimMac(macKey, { direction: "browser", ephPublicRaw: browserPub, nonce, requestId }, bClaimMac),
    ).toBe(true);
    const sealKey = await deriveSealKey(kernelEph.privateKey, browserPub, codeSecret, nonce);
    const opened = await openPairingPayload(sealKey, sealed, { nonce: nonceB64, requestId, pairingRoom });
    expect(opened).not.toBeNull();
    controlRoom = opened!.controlRoom;
    expect(controlRoom).toMatch(/^share-/);
    const key = base64UrlToBytes(opened!.responseKey);
    expect(key).not.toBeNull();
    responseKey = key!;
  } finally {
    pairPeer.destroy();
  }
  await page.getByTestId("settings-back").click();
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  return { syncUrl, controlRoom, responseKey };
}

/** Discover the open project's id via the control mailbox (list_projects). */
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

/** The full open_project handoff payload (the grant's signing coordinates). */
interface OpenHandoff {
  syncUrl: string;
  room: string;
  projectId: string;
  mainFile: string;
  grantId: string;
}

/** Drive open_project → Approve and return the share-room handoff (grant coordinates). */
async function approveOpenProject(
  page: Page,
  controlHost: DocHost,
  projectId: string,
): Promise<OpenHandoff> {
  const okId = publishControlRequest(
    controlHost,
    { op: "open_project", params: { projectId } },
    KERNEL_AUTHOR,
  );
  const modal = page.getByTestId("agent-open-consent");
  await expect(modal).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("agent-open-consent-approve").click();
  await expect(modal).toBeHidden({ timeout: 10_000 });
  await expect.poll(() => getControlResponse(controlHost, okId)?.ok, { timeout: 30_000 }).toBe(true);
  const okResp = getControlResponse(controlHost, okId) as Extract<ControlResponse, { ok: true }>;
  const result = okResp.result as OpenHandoff;
  expect(result.room).toMatch(/^share-/);
  expect(result.grantId.length).toBeGreaterThan(0);
  expect(result.mainFile.length).toBeGreaterThan(0);
  return result;
}

/**
 * Publish a SIGNED single-file `edit` into the share room's mailbox as the paired
 * agent: append `marker` to the main file. The signature derives from the session
 * `responseKey` over the EXACT grant scope, so the browser's auto-accept verifier
 * authenticates it. Returns the minted record id.
 */
async function publishSignedAppend(
  shareHost: DocHost,
  scope: ProposalScope,
  responseKey: Uint8Array,
  mainFile: string,
  baseText: string,
  marker: string,
): Promise<string> {
  const proposedText = `${baseText}\n${marker}\n`;
  const K = await deriveProposalKey(responseKey, scope);
  const signer = (signable: SignableProposal) => signProposal(K, scope, signable);
  return publishFileProposal(
    shareHost,
    {
      request: `Append ${marker}`,
      ops: [
        {
          kind: "edit",
          path: mainFile,
          baseText,
          proposedText,
          blocks: [{ search: baseText, replace: proposedText }],
        },
      ],
    },
    KERNEL_AUTHOR,
    signer,
  );
}

test("headless host applies a signed proposal off-foreground, and Revoke stops it", async ({
  page,
}) => {
  // A controlled, single-project library (no Einstein demo card) so list_projects
  // resolves the project under test deterministically.
  await skipDemoSeed(page);
  const projectId = "e2e-f13-host";
  // The grant must be Auto for the headless host to apply without a human card.
  await setAutoMode(page, projectId);

  // 1. Enable Agent Access; recover the control room + the signing responseKey.
  const { syncUrl, controlRoom, responseKey } = await enableAgentAccess(page, projectId);
  const controlPeer = joinRoomAsPeer(syncUrl, controlRoom);
  let sharePeer: RoomPeer | null = null;
  try {
    const discovered = await discoverProjectId(controlPeer.host);
    expect(discovered).toBe(projectId);

    // 2. Approve open_project → the share-room handoff (the grant's coordinates).
    const handoff = await approveOpenProject(page, controlPeer.host, projectId);
    await expect(page.getByTestId("share-button")).toHaveText(/shared/i);

    // The full proposal scope: a signature binds to ALL six fields (any mismatch
    // derives a different key AND signs different bytes → the verifier refuses it).
    const fileScope: ProposalScope = {
      grantId: handoff.grantId,
      controlRoom,
      syncUrl: handoff.syncUrl,
      projectId: handoff.projectId,
      shareRoom: handoff.room,
      mailbox: "mcpFileProposals",
    };

    // Join the share room as the agent peer; wait until the project syncs so we sign
    // against the file's ACTUAL base text (the conflict-aware apply needs base==live).
    sharePeer = joinRoomAsPeer(syncUrl, handoff.room);
    let baseText = "";
    await expect
      .poll(
        () => {
          const text = fileTextAt(sharePeer!.project, handoff.mainFile);
          if (text !== null) baseText = text;
          return text;
        },
        { timeout: 30_000 },
      )
      .not.toBeNull();
    expect(baseText.length).toBeGreaterThan(0);

    // 3. Toggle Background agent access ON for this project (persistentAccess + content).
    await page.keyboard.press("ControlOrMeta+,");
    await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("agent-background-section")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("agent-background-enable").click();
    await expect(page.getByTestId("agent-background-active")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("settings-back").click();
    await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

    // 4. Navigate the editor OFF the project (→ the library). The foreground editor
    //    unmounts; the app-root host now owns the apply. Confirm it attached via its
    //    own `agentWorker` presence in the share room (a real barrier, not a sleep).
    await page.getByTestId("open-library").click();
    await expect(page.getByTestId("library")).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => headlessHostPresent(sharePeer!.connection), { timeout: 30_000 })
      .toBe(true);

    // 5. POSITIVE control: a correctly-signed proposal auto-applies with NO foreground
    //    editor. The edit lands (exactly once) and the mailbox record flips to
    //    "accepted" — the headless apply seam only resolves a record AFTER a
    //    successful pre-apply checkpoint + apply, so "accepted" ⇒ the change landed
    //    under a checkpoint (a checkpoint failure PAUSES the host instead).
    const marker1 = `% F13-HEADLESS-${randomUUID()}`;
    const id1 = await publishSignedAppend(
      sharePeer.host,
      fileScope,
      responseKey,
      handoff.mainFile,
      baseText,
      marker1,
    );
    await expect
      .poll(() => getFileProposal(sharePeer!.host, id1)?.status, { timeout: 30_000 })
      .toBe("accepted");
    // The edit is visible in the shared doc, and applied EXACTLY ONCE (no second
    // applier raced the host — the editor is off the project + the grant Web-Lock).
    await expect
      .poll(() => fileTextAt(sharePeer!.project, handoff.mainFile)?.includes(marker1), {
        timeout: 30_000,
      })
      .toBe(true);
    const appliedText = fileTextAt(sharePeer.project, handoff.mainFile) ?? "";
    expect(appliedText.split(marker1).length - 1).toBe(1);

    // 6. Revoke the standing access from the library's settings surface (SPA nav, so
    //    the manager singleton survives). The host must detach: its presence drops.
    await page.getByTestId("library-settings").click();
    await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("agent-background-revoke")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("agent-background-revoke").click();
    // The grant cleared → the app-root host tears down and leaves the share room.
    await expect
      .poll(() => headlessHostPresent(sharePeer!.connection), { timeout: 30_000 })
      .toBe(false);

    // NEGATIVE control: a SECOND signed proposal must NOT apply now that the host has
    // detached (grant + verifier cleared, room left). The presence-gone barrier above
    // is the real proof — with no host peer in the room, this record reaches no
    // applier — so it stays pending. We then hold for a bounded window, asserting on
    // every tick that it never flips (and the host never re-appears), which would be
    // the only ways a stray apply could sneak in.
    const marker2 = `% F13-AFTER-REVOKE-${randomUUID()}`;
    const id2 = await publishSignedAppend(
      sharePeer.host,
      fileScope,
      responseKey,
      handoff.mainFile,
      // base is the post-apply text now (marker1 already landed); irrelevant since
      // nothing should apply, but keeps the op well-formed against the live file.
      appliedText,
      marker2,
    );
    // A bounded settle so any apply the host MIGHT (wrongly) attempt would have time
    // to land before we assert it did not — the negative twin of the positive poll
    // above (which lands in well under a second). The host having left the room makes
    // a late apply impossible; this just closes the timing window definitively.
    await page.waitForTimeout(2_000);
    expect(headlessHostPresent(sharePeer.connection)).toBe(false);
    expect(getFileProposal(sharePeer.host, id2)?.status).toBe("pending");
    expect(fileTextAt(sharePeer.project, handoff.mainFile)?.includes(marker2)).toBe(false);
  } finally {
    sharePeer?.destroy();
    controlPeer.destroy();
  }
});
