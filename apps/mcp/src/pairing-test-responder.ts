import {
  base64UrlToBytes,
  bytesToBase64Url,
  computeClaimMac,
  deriveBootstrap,
  deriveSealKey,
  exportEphemeralPublic,
  generateEphemeralKeyPair,
  observeControlRequests,
  publishControlResponse,
  readControlRequests,
  sealPairingPayload,
  verifyClaimMac,
  type ControlRequest,
  type DocHost,
  type PairingPayload,
} from "@galley/collab";
import { PAIRING_CLAIM_OP } from "./control.js";

/**
 * A minimal in-memory fake browser responder for the pairing room (the reference
 * browser side): on each pairing_claim, verify the kernel claim BEFORE consuming
 * the code, then mint an ephemeral ECDH pair, derive the seal key, seal, and reply
 * with {bEphPub, bClaimMac, sealed}. `voided` enforces the one-time code.
 */
export function startFakePairingResponder(
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
