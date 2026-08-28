import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  deriveBootstrap,
  generateEphemeralKeyPair,
  exportEphemeralPublic,
  deriveSealKey,
  verifyClaimMac,
  computeClaimMac,
  sealPairingPayload,
  base64UrlToBytes,
  bytesToBase64Url,
  mintPairingCode,
  publishControlResponse,
  readControlRequests,
  observeControlRequests,
  type DocHost,
  type ControlRequest,
  type PairingPayload,
} from "@galley/collab";
import { runPairingHandshake, PAIRING_CLAIM_OP } from "./control.js";

/**
 * The pairing handshake (B2, ADR-0026, v2 — forward secrecy) — kernel side driven
 * against an IN-MEMORY fake browser responder over ONE shared Y.Doc (no relay).
 * The gating proofs:
 *   - the kernel's claim carries an ephemeral pubkey + MAC + nonce, NEVER the code,
 *   - the browser verifies the claim (binding the real request.id) BEFORE sealing,
 *     replies with its OWN ephemeral pubkey + the sealed payload (encrypted),
 *   - the kernel verifies the browser's claim, ECDHs, opens the seal,
 *   - a wrong-code kernel cannot open the seal; a peer sees neither code nor key,
 *   - FORWARD SECRECY: the seal key needs an ephemeral private key.
 */

const SYNC = "ws://127.0.0.1:1234";
const CONTROL_ROOM = "share-0123456789abcdef0123456789abcdef";
const RESPONSE_KEY_B64 = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE"; // 32 x "A"

const PAYLOAD: PairingPayload = {
  syncUrl: SYNC,
  controlRoom: CONTROL_ROOM,
  responseKey: RESPONSE_KEY_B64,
};

/** A bare DocHost wrapping a Y.Doc — the in-memory "pairing room". */
function makeHost(): DocHost {
  return { doc: new Y.Doc() };
}

/**
 * A minimal in-memory fake browser responder for the pairing room (the reference
 * browser side): on each pairing_claim, verify the kernel claim BEFORE consuming
 * the code, then mint an ephemeral ECDH pair, derive the seal key, seal, and reply
 * with {bEphPub, bClaimMac, sealed}. `voided` enforces the one-time code.
 */
function startFakePairingResponder(
  host: DocHost,
  code: string,
  payload: PairingPayload,
  opts: { onClaim?: (req: ControlRequest) => void; voided?: () => boolean } = {},
): () => void {
  let handled = false;
  const author = { kind: "human" as const, userId: "fake-browser" };
  const drain = async (): Promise<void> => {
    const { macKey, codeSecret, pairingRoom } = await deriveBootstrap(code);
    for (const req of readControlRequests(host, { includeAnswered: true })) {
      if (req.op !== PAIRING_CLAIM_OP) continue;
      if (handled) continue;
      opts.onClaim?.(req);
      if (opts.voided?.()) continue;
      const ephPubB64 = req.params["ephPub"];
      const nonceB64 = req.params["nonce"];
      const claimMac = req.params["claimMac"];
      if (typeof ephPubB64 !== "string" || typeof nonceB64 !== "string" || typeof claimMac !== "string") {
        continue;
      }
      const nonce = base64UrlToBytes(nonceB64);
      const kernelPub = base64UrlToBytes(ephPubB64);
      if (nonce === null || kernelPub === null) continue;
      const requestId = req.id; // the REAL mailbox id (#2)
      const ok = await verifyClaimMac(
        macKey,
        { direction: "kernel", ephPublicRaw: kernelPub, nonce, requestId },
        claimMac,
      );
      if (!ok) {
        publishControlResponse(host, { id: req.id, ok: false, error: "bad claim" }, author, {
          overwrite: true,
        });
        continue;
      }
      handled = true; // one-time

      const browserEph = await generateEphemeralKeyPair();
      const browserPub = await exportEphemeralPublic(browserEph);
      const sealKey = await deriveSealKey(browserEph.privateKey, kernelPub, codeSecret, nonce);
      const bClaimMac = await computeClaimMac(macKey, {
        direction: "browser",
        ephPublicRaw: browserPub,
        nonce,
        requestId,
      });
      const sealed = await sealPairingPayload(sealKey, payload, { nonce: nonceB64, requestId, pairingRoom });
      publishControlResponse(
        host,
        {
          id: req.id,
          ok: true,
          result: { bEphPub: bytesToBase64Url(browserPub), bClaimMac, sealed } as unknown,
        },
        author,
        { overwrite: true },
      );
    }
  };
  const unobserve = observeControlRequests(host, () => void drain());
  void drain();
  return unobserve;
}

describe("runPairingHandshake — happy path", () => {
  it("obtains the controlRoom + responseKey via the sealed response", async () => {
    const host = makeHost();
    const code = mintPairingCode();
    const stop = startFakePairingResponder(host, code, PAYLOAD);
    const result = await runPairingHandshake(code, { host, timeoutMs: 2000 });
    stop();
    expect(result.controlRoom).toBe(CONTROL_ROOM);
    expect(result.syncUrl).toBe(SYNC);
    expect(
      Buffer.from(result.responseKey).equals(Buffer.from(base64UrlToBytes(RESPONSE_KEY_B64)!)),
    ).toBe(true);
  });

  it("the claim message carries an ephPub + MAC + nonce but NEVER the code or responseKey", async () => {
    const host = makeHost();
    const code = mintPairingCode();
    let seen: ControlRequest | undefined;
    const stop = startFakePairingResponder(host, code, PAYLOAD, { onClaim: (req) => void (seen = req) });
    await runPairingHandshake(code, { host, timeoutMs: 2000 });
    stop();
    expect(seen).toBeDefined();
    const wire = JSON.stringify(seen);
    expect(wire).not.toContain(code);
    expect(wire).not.toContain(RESPONSE_KEY_B64);
    expect(typeof seen!.params["claimMac"]).toBe("string");
    expect(typeof seen!.params["nonce"]).toBe("string");
    expect(typeof seen!.params["ephPub"]).toBe("string");
  });

  it("the sealed RESPONSE never carries the responseKey or controlRoom in cleartext", async () => {
    const host = makeHost();
    const code = mintPairingCode();
    const stop = startFakePairingResponder(host, code, PAYLOAD);
    await runPairingHandshake(code, { host, timeoutMs: 2000 });
    stop();
    const responses = host.doc.getMap("mcpControlResponses").toJSON();
    const blob = JSON.stringify(responses);
    expect(blob).not.toContain(RESPONSE_KEY_B64);
    expect(blob).not.toContain(CONTROL_ROOM);
  });
});

describe("runPairingHandshake — failure modes", () => {
  it("a WRONG code (different derived keys) cannot complete the handshake", async () => {
    const host = makeHost();
    const realCode = mintPairingCode();
    const wrongCode = mintPairingCode();
    const stop = startFakePairingResponder(host, realCode, PAYLOAD);
    await expect(runPairingHandshake(wrongCode, { host, timeoutMs: 800 })).rejects.toThrow();
    stop();
  });

  it("times out (rejects) when no responder ever answers", async () => {
    const host = makeHost();
    await expect(runPairingHandshake(mintPairingCode(), { host, timeoutMs: 300 })).rejects.toThrow();
  });

  it("rejects a sealed payload whose responseKey is not 32 bytes (shape validation)", async () => {
    const host = makeHost();
    const code = mintPairingCode();
    const bad: PairingPayload = { ...PAYLOAD, responseKey: "QUFB" }; // 3 bytes
    const stop = startFakePairingResponder(host, code, bad);
    await expect(runPairingHandshake(code, { host, timeoutMs: 800 })).rejects.toThrow();
    stop();
  });

  it("rejects an all-zero responseKey", async () => {
    const host = makeHost();
    const code = mintPairingCode();
    const bad: PairingPayload = { ...PAYLOAD, responseKey: bytesToBase64Url(new Uint8Array(32)) };
    const stop = startFakePairingResponder(host, code, bad);
    await expect(runPairingHandshake(code, { host, timeoutMs: 800 })).rejects.toThrow(/all-zero/);
    stop();
  });

  it("rejects a controlRoom that is not a capability room id", async () => {
    const host = makeHost();
    const code = mintPairingCode();
    const bad: PairingPayload = { ...PAYLOAD, controlRoom: "not-a-capability" };
    const stop = startFakePairingResponder(host, code, bad);
    await expect(runPairingHandshake(code, { host, timeoutMs: 800 })).rejects.toThrow(
      /capability room/,
    );
    stop();
  });

  it("rejects a response whose browser claim does NOT verify (forged eph key swap)", async () => {
    const host = makeHost();
    const code = mintPairingCode();
    const { codeSecret, pairingRoom } = await deriveBootstrap(code);
    // A hostile responder that verifies nothing and signs a GARBAGE browser claim:
    // it seals correctly (it derived the keys somehow) but cannot forge bClaimMac
    // without macKey — model that by responding with a wrong bClaimMac.
    const author = { kind: "human" as const, userId: "evil" };
    const unobserve = observeControlRequests(host, () => {
      void (async () => {
        for (const req of readControlRequests(host, { includeAnswered: true })) {
          if (req.op !== PAIRING_CLAIM_OP) continue;
          const kernelPub = base64UrlToBytes(req.params["ephPub"] as string);
          const nonce = base64UrlToBytes(req.params["nonce"] as string);
          if (kernelPub === null || nonce === null) continue;
          const eph = await generateEphemeralKeyPair();
          const sealKey = await deriveSealKey(eph.privateKey, kernelPub, codeSecret, nonce);
          const sealed = await sealPairingPayload(sealKey, PAYLOAD, {
            nonce: req.params["nonce"] as string,
            requestId: req.id,
            pairingRoom,
          });
          publishControlResponse(
            host,
            {
              id: req.id,
              ok: true,
              result: {
                bEphPub: bytesToBase64Url(await exportEphemeralPublic(eph)),
                bClaimMac: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", // garbage
                sealed,
              } as unknown,
            },
            author,
            { overwrite: true },
          );
          return;
        }
      })();
    });
    await expect(runPairingHandshake(code, { host, timeoutMs: 800 })).rejects.toThrow(
      /browser claim did not verify/,
    );
    unobserve();
  });
});

describe("FORWARD SECRECY — transcript + code cannot recover the responseKey", () => {
  it("the seal key requires an ephemeral private key (discarded); replaying the transcript fails", async () => {
    const host = makeHost();
    const code = mintPairingCode();
    let sealedSeen: { iv: string; ct: string } | undefined;
    let bPubSeen: string | undefined;
    let kPubSeen: string | undefined;
    let nonceSeen: string | undefined;
    let ridSeen: string | undefined;
    // Wrap the responder to CAPTURE the full transcript (the attacker's recording).
    const author = { kind: "human" as const, userId: "browser" };
    const { macKey, codeSecret, pairingRoom } = await deriveBootstrap(code);
    const unobserve = observeControlRequests(host, () => {
      void (async () => {
        for (const req of readControlRequests(host, { includeAnswered: true })) {
          if (req.op !== PAIRING_CLAIM_OP) continue;
          const kernelPub = base64UrlToBytes(req.params["ephPub"] as string);
          const nonce = base64UrlToBytes(req.params["nonce"] as string);
          if (kernelPub === null || nonce === null) continue;
          const browserEph = await generateEphemeralKeyPair();
          const browserPub = await exportEphemeralPublic(browserEph);
          const sealKey = await deriveSealKey(browserEph.privateKey, kernelPub, codeSecret, nonce);
          const bClaimMac = await computeClaimMac(macKey, {
            direction: "browser",
            ephPublicRaw: browserPub,
            nonce,
            requestId: req.id,
          });
          const sealed = await sealPairingPayload(sealKey, PAYLOAD, {
            nonce: req.params["nonce"] as string,
            requestId: req.id,
            pairingRoom,
          });
          sealedSeen = sealed;
          bPubSeen = bytesToBase64Url(browserPub);
          kPubSeen = req.params["ephPub"] as string;
          nonceSeen = req.params["nonce"] as string;
          ridSeen = req.id;
          publishControlResponse(
            host,
            { id: req.id, ok: true, result: { bEphPub: bPubSeen, bClaimMac, sealed } as unknown },
            author,
            { overwrite: true },
          );
          return;
        }
      })();
    });
    const result = await runPairingHandshake(code, { host, timeoutMs: 2000 });
    unobserve();
    expect(result.controlRoom).toBe(CONTROL_ROOM); // honest handshake worked

    // THE ATTACKER: holds the transcript (kPub, bPub, sealed, nonce, requestId) AND
    // the leaked code (⇒ codeSecret). The ephemeral PRIVATE keys are gone. With only
    // public keys + the code, it cannot derive the seal key — its only ECDH option
    // is a FRESH ephemeral pair, which yields a different key, so the open fails.
    expect(sealedSeen && bPubSeen && kPubSeen && nonceSeen && ridSeen).toBeTruthy();
    const { openPairingPayload } = await import("@galley/collab");
    const attacker = await generateEphemeralKeyPair();
    const guess = await deriveSealKey(
      attacker.privateKey,
      base64UrlToBytes(bPubSeen!)!,
      codeSecret,
      base64UrlToBytes(nonceSeen!)!,
    );
    const recovered = await openPairingPayload(guess, sealedSeen!, {
      nonce: nonceSeen!,
      requestId: ridSeen!,
      pairingRoom,
    });
    expect(recovered).toBeNull();
  });
});
