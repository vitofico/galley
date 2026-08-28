import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";
import {
  deriveBootstrap,
  generateEphemeralKeyPair,
  exportEphemeralPublic,
  deriveSealKey,
  computeClaimMac,
  verifyClaimMac,
  openPairingPayload,
  base64UrlToBytes,
  bytesToBase64Url,
  publishControlRequest,
  getControlResponse,
  readControlRequests,
  PAIRING_NONCE_BYTES,
  type DocHost,
  type ControlResponse,
} from "@galley/collab";
import type { Author } from "@galley/shared";
import {
  __resetControlResponderManagerForTests,
  __responseKeyForTests,
  getControlResponderManager,
  PAIRING_CLAIM_OP,
  PAIRING_CODE_TTL_MS,
  type ControlResponderMountDeps,
  type ControlLink,
} from "./control-responder-mount.js";

/**
 * The B2 browser-side pairing handshake (ADR-0026, v2 — forward secrecy). enable()
 * mints a one-time code, derives the pairing room + bootstrap keys, joins, and on a
 * VALID claim (kernel-side ECDH) derives the seal key from ECDH ‖ codeSecret, seals
 * {syncUrl, controlRoom, responseKey}, and replies with its OWN ephemeral pubkey +
 * the seal — consuming the code (one-time), enforcing the 10-min TTL, verifying the
 * claim BEFORE consuming, and binding the REAL mailbox request id (#2).
 */

const KERNEL: Author = { kind: "human", userId: "test-kernel" };
const SYNC = "ws://127.0.0.1:1234";
const CODE = "fixedPairingCodeAAAAAA"; // 16-byte base64url; deterministic for the test

function makeFakePairing(): {
  joinPairingRoom: NonNullable<ControlResponderMountDeps["joinPairingRoom"]>;
  pairingHost: DocHost;
  joinCount: number;
  destroyed: boolean;
} {
  const doc = new Y.Doc();
  const pairingHost: DocHost = { doc };
  const ref = { joinCount: 0, destroyed: false };
  const joinPairingRoom: NonNullable<ControlResponderMountDeps["joinPairingRoom"]> = () => {
    ref.joinCount += 1;
    return { host: pairingHost, destroy: () => void (ref.destroyed = true) } as ControlLink;
  };
  return {
    joinPairingRoom,
    pairingHost,
    get joinCount() {
      return ref.joinCount;
    },
    get destroyed() {
      return ref.destroyed;
    },
  };
}

function makeMemoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

function deps(over: Partial<ControlResponderMountDeps> = {}): ControlResponderMountDeps {
  return {
    mintControlRoom: () => "share-controlcontrolcontrolcontrol",
    resolveSyncUrl: () => SYNC,
    currentUserId: () => "u",
    listProjects: async () => [],
    listVersions: async () => null,
    createProject: async (name) => ({ projectId: "proj-new", name }),
    openProjectForControl: async () => ({ refused: "x" }),
    joinControlRoom: () => ({ host: { doc: new Y.Doc() }, destroy() {} }),
    mintPairingCode: () => CODE,
    sessionStore: makeMemoryStore(),
    ...over,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Build a kernel-side claim (ECDH). Returns the published request id + the parts to open. */
async function driveKernelClaim(
  host: DocHost,
  code: string,
  opts: { nonceFill?: number; badMac?: boolean } = {},
): Promise<{
  requestId: string;
  kernel: Awaited<ReturnType<typeof generateEphemeralKeyPair>>;
  nonce: Uint8Array;
  nonceB64: string;
  pairingRoom: string;
  codeSecret: Uint8Array;
  macKey: Uint8Array;
}> {
  const { macKey, codeSecret, pairingRoom } = await deriveBootstrap(code);
  const kernel = await generateEphemeralKeyPair();
  const ephPub = await exportEphemeralPublic(kernel);
  const nonce = new Uint8Array(PAIRING_NONCE_BYTES).fill(opts.nonceFill ?? 7);
  const nonceB64 = bytesToBase64Url(nonce);
  // The kernel pre-mints its own id so the claim MAC binds the mailbox id (#2).
  const requestId =
    (globalThis.crypto as { randomUUID?: () => string }).randomUUID?.() ??
    "req-" + Math.random().toString(36).slice(2);
  const claimMac = opts.badMac
    ? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    : await computeClaimMac(macKey, { direction: "kernel", ephPublicRaw: ephPub, nonce, requestId });
  publishControlRequest(
    host,
    { op: PAIRING_CLAIM_OP, params: { ephPub: bytesToBase64Url(ephPub), nonce: nonceB64, claimMac } },
    KERNEL,
    requestId,
  );
  return { requestId, kernel, nonce, nonceB64, pairingRoom, codeSecret, macKey };
}

/** Open a successful browser response (verify the browser claim + ECDH + open). */
async function openResponse(
  resp: ControlResponse,
  drive: Awaited<ReturnType<typeof driveKernelClaim>>,
): Promise<{ controlRoom: string; syncUrl: string; responseKey: string } | null> {
  if (!resp.ok) return null;
  const { bEphPub, bClaimMac, sealed } = resp.result as {
    bEphPub: string;
    bClaimMac: string;
    sealed: { iv: string; ct: string };
  };
  const browserPub = base64UrlToBytes(bEphPub)!;
  const okClaim = await verifyClaimMac(
    drive.macKey,
    { direction: "browser", ephPublicRaw: browserPub, nonce: drive.nonce, requestId: drive.requestId },
    bClaimMac,
  );
  if (!okClaim) return null;
  const sealKey = await deriveSealKey(drive.kernel.privateKey, browserPub, drive.codeSecret, drive.nonce);
  return openPairingPayload(sealKey, sealed, {
    nonce: drive.nonceB64,
    requestId: drive.requestId,
    pairingRoom: drive.pairingRoom,
  });
}

beforeEach(() => {
  __resetControlResponderManagerForTests();
});

describe("B2 pairing handshake — browser side (forward secrecy)", () => {
  it("surfaces a --pairing-code command and joins the DERIVED pairing room", async () => {
    const p = makeFakePairing();
    const mgr = getControlResponderManager(deps({ joinPairingRoom: p.joinPairingRoom }));
    mgr.enable();
    expect(mgr.getState().pairingCommand).toContain(`--pairing-code ${CODE}`);
    await flush();
    expect(p.joinCount).toBe(1);
  });

  it("on a VALID claim: ECDH-seals the payload, responds, and CONSUMES the code (one-time)", async () => {
    const p = makeFakePairing();
    const mgr = getControlResponderManager(deps({ joinPairingRoom: p.joinPairingRoom }));
    mgr.enable();
    await flush();

    const drive = await driveKernelClaim(p.pairingHost, CODE);
    await flush();
    const resp = getControlResponse(p.pairingHost, drive.requestId)!;
    expect(resp.ok).toBe(true);
    const opened = await openResponse(resp, drive);
    expect(opened).not.toBeNull();
    expect(opened!.controlRoom).toBe("share-controlcontrolcontrolcontrol");
    expect(opened!.syncUrl).toBe(SYNC);
    expect(opened!.responseKey).toBe(bytesToBase64Url(__responseKeyForTests(mgr)!));
    // The code is CONSUMED.
    expect(mgr.getState().pairingCommand).toBeNull();
  });

  it("the sealed RESPONSE never carries the responseKey or controlRoom in cleartext", async () => {
    const p = makeFakePairing();
    const mgr = getControlResponderManager(deps({ joinPairingRoom: p.joinPairingRoom }));
    mgr.enable();
    await flush();
    const drive = await driveKernelClaim(p.pairingHost, CODE);
    await flush();
    const resp = getControlResponse(p.pairingHost, drive.requestId)!;
    const key = bytesToBase64Url(__responseKeyForTests(mgr) ?? new Uint8Array());
    const blob = JSON.stringify(resp);
    expect(blob).not.toContain(key);
    expect(blob).not.toContain("share-controlcontrolcontrolcontrol");
  });

  it("a BAD claim mac is refused and does NOT consume the code", async () => {
    const p = makeFakePairing();
    const mgr = getControlResponderManager(deps({ joinPairingRoom: p.joinPairingRoom }));
    mgr.enable();
    await flush();
    const drive = await driveKernelClaim(p.pairingHost, CODE, { badMac: true });
    await flush();
    expect(getControlResponse(p.pairingHost, drive.requestId)?.ok).toBe(false);
    expect(mgr.getState().pairingCommand).toContain(`--pairing-code ${CODE}`);
  });

  it("a claim under a WRONG code (different derived keys) is refused", async () => {
    const p = makeFakePairing();
    const mgr = getControlResponderManager(deps({ joinPairingRoom: p.joinPairingRoom }));
    mgr.enable();
    await flush();
    const drive = await driveKernelClaim(p.pairingHost, "totallyDifferentCodeBB");
    await flush();
    expect(getControlResponse(p.pairingHost, drive.requestId)?.ok).toBe(false);
    expect(mgr.getState().pairingCommand).toContain(`--pairing-code ${CODE}`);
  });

  it("#2: a claim copied onto a SECOND mailbox id fails (the MAC binds the real request.id)", async () => {
    const p = makeFakePairing();
    const mgr = getControlResponderManager(deps({ joinPairingRoom: p.joinPairingRoom }));
    mgr.enable();
    await flush();
    // The legit kernel claim under id A.
    const { macKey, codeSecret, pairingRoom } = await deriveBootstrap(CODE);
    void codeSecret;
    void pairingRoom;
    const kernel = await generateEphemeralKeyPair();
    const ephPub = await exportEphemeralPublic(kernel);
    const nonce = new Uint8Array(PAIRING_NONCE_BYTES).fill(4);
    const idA = "req-AAAAAAAAAAAAAAAAAAAA";
    const claimMac = await computeClaimMac(macKey, {
      direction: "kernel",
      ephPublicRaw: ephPub,
      nonce,
      requestId: idA,
    });
    // The ATTACKER copies the same {ephPub, nonce, claimMac} under a DIFFERENT id B.
    const idB = "req-BBBBBBBBBBBBBBBBBBBB";
    publishControlRequest(
      p.pairingHost,
      { op: PAIRING_CLAIM_OP, params: { ephPub: bytesToBase64Url(ephPub), nonce: bytesToBase64Url(nonce), claimMac } },
      KERNEL,
      idB,
    );
    await flush();
    // The browser binds request.id=idB, recomputes the MAC over idB ≠ idA → refuse,
    // and the code is NOT consumed.
    expect(getControlResponse(p.pairingHost, idB)?.ok).toBe(false);
    expect(mgr.getState().pairingCommand).toContain(`--pairing-code ${CODE}`);
  });

  it("#2 record-swap: a body-id-spoofed claim is DROPPED before the responder sees it (code intact)", async () => {
    const p = makeFakePairing();
    const mgr = getControlResponderManager(deps({ joinPairingRoom: p.joinPairingRoom }));
    mgr.enable();
    await flush();
    // A peer forges a raw record under map-key X whose BODY id is a captured legit
    // claim id (the spoof the body-id binding would otherwise trust). The record-swap
    // guard in readControlRequests drops it → the responder never processes the
    // claim → the one-time code is NOT consumed (no response published either).
    const { macKey } = await deriveBootstrap(CODE);
    const kernel = await generateEphemeralKeyPair();
    const ephPub = await exportEphemeralPublic(kernel);
    const nonce = new Uint8Array(PAIRING_NONCE_BYTES).fill(8);
    const spoofedBodyId = "captured-claim-id-0123456789abcd";
    const claimMac = await computeClaimMac(macKey, {
      direction: "kernel",
      ephPublicRaw: ephPub,
      nonce,
      requestId: spoofedBodyId, // MAC'd over the spoofed body id
    });
    const mapKeyX = "attacker-mapkey-0123456789abcdef";
    p.pairingHost.doc.transact(() => {
      p.pairingHost.doc.getMap("mcpControlRequests").set(mapKeyX, {
        id: spoofedBodyId, // body id ≠ map key
        op: PAIRING_CLAIM_OP,
        params: { ephPub: bytesToBase64Url(ephPub), nonce: bytesToBase64Url(nonce), claimMac },
        createdAt: 1,
        seq: 1,
      });
    });
    await flush();
    // No response published under EITHER id; the code remains offered.
    expect(getControlResponse(p.pairingHost, spoofedBodyId)).toBeUndefined();
    expect(getControlResponse(p.pairingHost, mapKeyX)).toBeUndefined();
    expect(mgr.getState().pairingCommand).toContain(`--pairing-code ${CODE}`);
  });

  it("the TTL voids an unclaimed code and tears down the pairing room (real short TTL)", async () => {
    // Real timers (WebCrypto's async ECDH/HKDF doesn't compose with fake timers); a
    // short injected TTL keeps the test fast. PAIRING_CODE_TTL_MS is 10 min in prod.
    const p = makeFakePairing();
    const mgr = getControlResponderManager(
      deps({ joinPairingRoom: p.joinPairingRoom, pairingCodeTtlMs: () => 300 }),
    );
    mgr.enable();
    await flush();
    expect(mgr.getState().pairingCommand).toContain(`--pairing-code ${CODE}`);
    await new Promise((r) => setTimeout(r, 500));
    expect(mgr.getState().pairingCommand).toBeNull();
    expect(p.destroyed).toBe(true);
    // The control-room responder stays live (the session is not revoked).
    expect(mgr.isEnabled()).toBe(true);
    expect(PAIRING_CODE_TTL_MS).toBe(10 * 60 * 1000); // pin the production value
  });

  it("disable() voids the code and tears the pairing room down", async () => {
    const p = makeFakePairing();
    const mgr = getControlResponderManager(deps({ joinPairingRoom: p.joinPairingRoom }));
    mgr.enable();
    await flush();
    expect(mgr.getState().pairingCommand).toContain(`--pairing-code ${CODE}`);
    mgr.disable();
    expect(mgr.getState().pairingCommand).toBeNull();
    expect(p.destroyed).toBe(true);
  });

  it("the kernel's claim message never carries the code (only ephPub + MAC + nonce)", async () => {
    const p = makeFakePairing();
    const mgr = getControlResponderManager(deps({ joinPairingRoom: p.joinPairingRoom }));
    mgr.enable();
    await flush();
    await driveKernelClaim(p.pairingHost, CODE);
    const wire = JSON.stringify(readControlRequests(p.pairingHost, { includeAnswered: true }));
    expect(wire).not.toContain(CODE);
  });
});
