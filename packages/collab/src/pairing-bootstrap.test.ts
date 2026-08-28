import { describe, it, expect } from "vitest";
import {
  mintPairingCode,
  deriveBootstrap,
  generateEphemeralKeyPair,
  exportEphemeralPublic,
  deriveSealKey,
  computeClaimMac,
  verifyClaimMac,
  sealPairingPayload,
  openPairingPayload,
  PAIRING_CODE_BYTES,
  PAIRING_NONCE_BYTES,
  type PairingPayload,
  type ClaimContext,
} from "./pairing-bootstrap.js";
import { isCapabilityRoomId } from "@galley/shared";

/**
 * The GATING crypto tests for B2 durable pairing (ADR-0026, v2 — forward secrecy).
 *
 * The pairing CODE is the only PASTED secret; from it BOTH sides derive (without
 * transmitting it) a pairing room id, a bootstrap MAC key, and a code SECRET. The
 * kernel PROVES it knows the code with a claimMac over its EPHEMERAL public key +
 * nonce + the request id (not the code). The AEAD seal key is derived from BOTH an
 * EPHEMERAL ECDH shared secret AND the code secret, and the ephemeral private keys
 * are DISCARDED — so a recorded transcript PLUS a later code leak still cannot
 * recover the responseKey (forward secrecy). These tests pin determinism, the
 * constant-time MAC verify, the FS property, and the AES-GCM round-trip + tamper.
 */

const PAYLOAD: PairingPayload = {
  syncUrl: "ws://127.0.0.1:1234",
  controlRoom: "share-0123456789abcdef0123456789abcdef",
  responseKey: "Y29udHJvbC1yZXNwb25zZS1rZXktMzItYnl0ZXNfXw", // 32 base64url bytes
};

const NONCE = (fill = 7): Uint8Array => new Uint8Array(PAIRING_NONCE_BYTES).fill(fill);

describe("mintPairingCode", () => {
  it("mints a base64url code that decodes to PAIRING_CODE_BYTES", () => {
    const code = mintPairingCode();
    expect(typeof code).toBe("string");
    expect(/^[A-Za-z0-9_-]+$/.test(code)).toBe(true);
    expect(code).not.toContain("=");
  });

  it("mints a fresh, non-repeating code each call", () => {
    expect(mintPairingCode()).not.toBe(mintPairingCode());
  });
});

describe("deriveBootstrap — HKDF room + mac key + code secret, deterministic", () => {
  it("is deterministic: the same code derives the SAME room, macKey, codeSecret", async () => {
    const code = mintPairingCode();
    const a = await deriveBootstrap(code);
    const b = await deriveBootstrap(code);
    expect(a.pairingRoom).toBe(b.pairingRoom);
    expect(Buffer.from(a.macKey).equals(Buffer.from(b.macKey))).toBe(true);
    expect(Buffer.from(a.codeSecret).equals(Buffer.from(b.codeSecret))).toBe(true);
  });

  it("derives a capability-shaped pairing room id in the share- namespace (#3)", async () => {
    const { pairingRoom } = await deriveBootstrap(mintPairingCode());
    expect(/^share-[0-9a-f]{32}$/.test(pairingRoom)).toBe(true);
    // It MUST satisfy isCapabilityRoomId so the relay admits the cookie-less kernel
    // under GALLEY_SYNC_AUTH=required (absent-Origin capability carve-out).
    expect(isCapabilityRoomId(pairingRoom)).toBe(true);
  });

  it("the room id does NOT contain the raw code", async () => {
    const code = mintPairingCode();
    const { pairingRoom } = await deriveBootstrap(code);
    expect(pairingRoom).not.toContain(code);
  });

  it("a different code derives a DIFFERENT room + macKey + codeSecret", async () => {
    const a = await deriveBootstrap(mintPairingCode());
    const b = await deriveBootstrap(mintPairingCode());
    expect(a.pairingRoom).not.toBe(b.pairingRoom);
    expect(Buffer.from(a.macKey).equals(Buffer.from(b.macKey))).toBe(false);
    expect(Buffer.from(a.codeSecret).equals(Buffer.from(b.codeSecret))).toBe(false);
  });

  it("the mac key and code secret are DISTINCT (separate info labels)", async () => {
    const { macKey, codeSecret } = await deriveBootstrap(mintPairingCode());
    expect(Buffer.from(macKey).equals(Buffer.from(codeSecret))).toBe(false);
  });

  it("rejects a malformed (non-base64url) code", async () => {
    await expect(deriveBootstrap("not valid base64url!!")).rejects.toThrow();
  });

  it("rejects a WRONG-LENGTH code (must decode to exactly 16 bytes)", async () => {
    await expect(deriveBootstrap("abcd1234efgh5678")).rejects.toThrow(/16 bytes/);
    await expect(
      deriveBootstrap("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    ).rejects.toThrow(/16 bytes/);
  });
});

describe("ephemeral ECDH + seal-key derivation", () => {
  it("both sides derive the SAME seal key from ECDH(eph) ‖ codeSecret", async () => {
    const { codeSecret } = await deriveBootstrap(mintPairingCode());
    const k = await generateEphemeralKeyPair();
    const b = await generateEphemeralKeyPair();
    const kPub = await exportEphemeralPublic(k);
    const bPub = await exportEphemeralPublic(b);
    const nonce = NONCE();
    const sealKernel = await deriveSealKey(k.privateKey, bPub, codeSecret, nonce);
    const sealBrowser = await deriveSealKey(b.privateKey, kPub, codeSecret, nonce);
    expect(Buffer.from(sealKernel).equals(Buffer.from(sealBrowser))).toBe(true);
    expect(sealKernel.length).toBe(32);
  });

  it("a different ephemeral pair derives a DIFFERENT seal key (FS substrate)", async () => {
    const { codeSecret } = await deriveBootstrap(mintPairingCode());
    const k1 = await generateEphemeralKeyPair();
    const b1 = await generateEphemeralKeyPair();
    const k2 = await generateEphemeralKeyPair();
    const b2 = await generateEphemeralKeyPair();
    const nonce = NONCE();
    const s1 = await deriveSealKey(k1.privateKey, await exportEphemeralPublic(b1), codeSecret, nonce);
    const s2 = await deriveSealKey(k2.privateKey, await exportEphemeralPublic(b2), codeSecret, nonce);
    expect(Buffer.from(s1).equals(Buffer.from(s2))).toBe(false);
  });

  it("the seal key depends on the CODE secret too (wrong code ⇒ wrong seal key even with same ECDH)", async () => {
    const a = await deriveBootstrap(mintPairingCode());
    const b = await deriveBootstrap(mintPairingCode());
    const k = await generateEphemeralKeyPair();
    const br = await generateEphemeralKeyPair();
    const kPub = await exportEphemeralPublic(k);
    const nonce = NONCE();
    const withA = await deriveSealKey(br.privateKey, kPub, a.codeSecret, nonce);
    const withB = await deriveSealKey(br.privateKey, kPub, b.codeSecret, nonce);
    expect(Buffer.from(withA).equals(Buffer.from(withB))).toBe(false);
  });

  it("a different nonce (HKDF salt) derives a different seal key", async () => {
    const { codeSecret } = await deriveBootstrap(mintPairingCode());
    const k = await generateEphemeralKeyPair();
    const b = await generateEphemeralKeyPair();
    const kPub = await exportEphemeralPublic(k);
    const s1 = await deriveSealKey(b.privateKey, kPub, codeSecret, NONCE(1));
    const s2 = await deriveSealKey(b.privateKey, kPub, codeSecret, NONCE(2));
    expect(Buffer.from(s1).equals(Buffer.from(s2))).toBe(false);
  });
});

describe("FORWARD SECRECY — a recorded transcript + the leaked code cannot recover the responseKey", () => {
  it("opening requires an EPHEMERAL PRIVATE KEY that is discarded; transcript+code is insufficient", async () => {
    const code = mintPairingCode();
    const { codeSecret } = await deriveBootstrap(code);

    // Honest handshake: kernel + browser ephemeral pairs.
    const kernel = await generateEphemeralKeyPair();
    const browser = await generateEphemeralKeyPair();
    const kPub = await exportEphemeralPublic(kernel); // ON THE WIRE
    const bPub = await exportEphemeralPublic(browser); // ON THE WIRE
    const nonce = NONCE();
    const aad = { nonce: "bm9uY2U", requestId: "req-1", pairingRoom: "pair-abc" };

    const browserSeal = await deriveSealKey(browser.privateKey, kPub, codeSecret, nonce);
    const sealed = await sealPairingPayload(browserSeal, PAYLOAD, aad); // ON THE WIRE

    // The kernel opens it with ITS private key — proving the transcript is well-formed.
    const kernelSeal = await deriveSealKey(kernel.privateKey, bPub, codeSecret, nonce);
    expect(await openPairingPayload(kernelSeal, sealed, aad)).toEqual(PAYLOAD);

    // THE ATTACKER: holds the FULL transcript (kPub, bPub, sealed, nonce, aad) AND
    // later leaks the CODE (⇒ codeSecret). The ephemeral PRIVATE keys are gone. With
    // only the two PUBLIC keys + codeSecret, the attacker cannot compute ECDH, so it
    // cannot derive the seal key. We model "attacker tries a FRESH ephemeral pair"
    // (the only ECDH it can compute) — the derived key differs and the open fails.
    const attacker = await generateEphemeralKeyPair();
    const guessSeal = await deriveSealKey(
      attacker.privateKey,
      kPub, // a public key from the transcript
      codeSecret, // the leaked code's secret
      nonce,
    );
    expect(Buffer.from(guessSeal).equals(Buffer.from(kernelSeal))).toBe(false);
    expect(await openPairingPayload(guessSeal, sealed, aad)).toBeNull();
  });
});

describe("claimMac — PROOF of the code over (ephPub, nonce, requestId), not the code", () => {
  const ctx = (over: Partial<ClaimContext> = {}): ClaimContext => ({
    direction: "kernel",
    ephPublicRaw: new Uint8Array(65).fill(4),
    nonce: NONCE(),
    requestId: "req-1",
    ...over,
  });

  it("verifies a freshly computed claim mac (constant-time accept)", async () => {
    const { macKey } = await deriveBootstrap(mintPairingCode());
    const c = ctx();
    const mac = await computeClaimMac(macKey, c);
    expect(await verifyClaimMac(macKey, c, mac)).toBe(true);
  });

  it("rejects a claim mac under a DIFFERENT key", async () => {
    const a = await deriveBootstrap(mintPairingCode());
    const b = await deriveBootstrap(mintPairingCode());
    const c = ctx();
    expect(await verifyClaimMac(b.macKey, c, await computeClaimMac(a.macKey, c))).toBe(false);
  });

  it("rejects a claim mac for a DIFFERENT nonce (anti-replay)", async () => {
    const { macKey } = await deriveBootstrap(mintPairingCode());
    const mac = await computeClaimMac(macKey, ctx({ nonce: NONCE(1) }));
    expect(await verifyClaimMac(macKey, ctx({ nonce: NONCE(2) }), mac)).toBe(false);
  });

  it("rejects a claim mac for a DIFFERENT requestId (#2: id replay binding)", async () => {
    const { macKey } = await deriveBootstrap(mintPairingCode());
    const mac = await computeClaimMac(macKey, ctx({ requestId: "req-A" }));
    expect(await verifyClaimMac(macKey, ctx({ requestId: "req-B" }), mac)).toBe(false);
  });

  it("rejects a claim mac for a DIFFERENT ephemeral pubkey (binds the eph key)", async () => {
    const { macKey } = await deriveBootstrap(mintPairingCode());
    const mac = await computeClaimMac(macKey, ctx({ ephPublicRaw: new Uint8Array(65).fill(4) }));
    expect(
      await verifyClaimMac(macKey, ctx({ ephPublicRaw: new Uint8Array(65).fill(5) }), mac),
    ).toBe(false);
  });

  it("a kernel claim is NOT accepted as a browser claim (direction domain-separation, no reflection)", async () => {
    const { macKey } = await deriveBootstrap(mintPairingCode());
    const mac = await computeClaimMac(macKey, ctx({ direction: "kernel" }));
    expect(await verifyClaimMac(macKey, ctx({ direction: "browser" }), mac)).toBe(false);
  });

  it("fails CLOSED — garbage / empty / non-base64url mac verifies false, never throws", async () => {
    const { macKey } = await deriveBootstrap(mintPairingCode());
    const c = ctx();
    expect(await verifyClaimMac(macKey, c, "")).toBe(false);
    expect(await verifyClaimMac(macKey, c, "!!!not-b64!!!")).toBe(false);
    expect(await verifyClaimMac(macKey, c, undefined as unknown as string)).toBe(false);
  });

  it("computeClaimMac rejects a wrong-length nonce; verify fails closed on it", async () => {
    const { macKey } = await deriveBootstrap(mintPairingCode());
    await expect(computeClaimMac(macKey, ctx({ nonce: new Uint8Array(16) }))).rejects.toThrow(
      /32 bytes/,
    );
    expect(await verifyClaimMac(macKey, ctx({ nonce: new Uint8Array(16) }), "AAAA")).toBe(false);
  });
});

describe("seal/open — AES-256-GCM round-trip with AAD binding", () => {
  const aad = { nonce: "bm9uY2U", requestId: "req-1", pairingRoom: "pair-deadbeef" };
  // A standalone 32-byte seal key (the ECDH derivation is tested above).
  const SEAL = new Uint8Array(32).fill(0x5a);
  const OTHER = new Uint8Array(32).fill(0x6b);

  it("round-trips the payload under the seal key + AAD", async () => {
    const sealed = await sealPairingPayload(SEAL, PAYLOAD, aad);
    expect(await openPairingPayload(SEAL, sealed, aad)).toEqual(PAYLOAD);
  });

  it("the sealed envelope does NOT contain the responseKey or controlRoom in cleartext", async () => {
    const sealed = await sealPairingPayload(SEAL, PAYLOAD, aad);
    const blob = JSON.stringify(sealed);
    expect(blob).not.toContain(PAYLOAD.responseKey);
    expect(blob).not.toContain(PAYLOAD.controlRoom);
  });

  it("open under the WRONG key fails (returns null, never throws)", async () => {
    const sealed = await sealPairingPayload(SEAL, PAYLOAD, aad);
    expect(await openPairingPayload(OTHER, sealed, aad)).toBeNull();
  });

  it("open with TAMPERED AAD fails (GCM authenticates the AAD)", async () => {
    const sealed = await sealPairingPayload(SEAL, PAYLOAD, aad);
    expect(await openPairingPayload(SEAL, sealed, { ...aad, requestId: "req-2" })).toBeNull();
    expect(await openPairingPayload(SEAL, sealed, { ...aad, nonce: "b3RoZXI" })).toBeNull();
    expect(await openPairingPayload(SEAL, sealed, { ...aad, pairingRoom: "pair-x" })).toBeNull();
  });

  it("open with TAMPERED ciphertext fails (GCM tag mismatch)", async () => {
    const sealed = await sealPairingPayload(SEAL, PAYLOAD, aad);
    const flipped = { ...sealed, ct: sealed.ct.slice(0, -2) + (sealed.ct.endsWith("A") ? "B" : "A") };
    expect(await openPairingPayload(SEAL, flipped, aad)).toBeNull();
  });

  it("open of a malformed envelope fails closed (null, never throws)", async () => {
    expect(await openPairingPayload(SEAL, { iv: "", ct: "" }, aad)).toBeNull();
    expect(await openPairingPayload(SEAL, { iv: "!!", ct: "!!" } as never, aad)).toBeNull();
  });

  it("a fresh IV per seal: two seals of the same payload differ", async () => {
    const s1 = await sealPairingPayload(SEAL, PAYLOAD, aad);
    const s2 = await sealPairingPayload(SEAL, PAYLOAD, aad);
    expect(s1.iv).not.toBe(s2.iv);
    expect(s1.ct).not.toBe(s2.ct);
  });
});

describe("constants", () => {
  it("PAIRING_CODE_BYTES is 16 (128-bit code) and nonce is 32", () => {
    expect(PAIRING_CODE_BYTES).toBe(16);
    expect(PAIRING_NONCE_BYTES).toBe(32);
  });
});
