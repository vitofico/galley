/**
 * Service-token verifier (Wave 13 cloud enabler). Drives `createServiceTokenVerifier`
 * against a REAL EdDSA keypair generated in-test (jose is a production dependency
 * of THIS package — the whole reason the verifier lives here and not in
 * apps/web-server). Pins the hard gate: only a well-signed, EdDSA, in-window token
 * with the exact iss/aud AND a present exp verifies; everything else → null; a
 * malformed key fails loud at construction.
 */
import { describe, it, expect, beforeAll } from "vitest";
import * as jose from "jose";
import { createServiceTokenVerifier, type ServiceTokenVerifier } from "./service-token.js";

const ISSUER = "https://cloud.galley.internal";
const AUDIENCE = "galley-self-host";
const NOW = 1_700_000_000_000;
const nowSec = Math.floor(NOW / 1000);

let priv: jose.KeyLike;
let pem: string;
let verify: ServiceTokenVerifier;

beforeAll(async () => {
  const kp = await jose.generateKeyPair("EdDSA", { extractable: true });
  priv = kp.privateKey;
  pem = await jose.exportSPKI(kp.publicKey);
  verify = await createServiceTokenVerifier({
    publicKeyPem: pem,
    issuer: ISSUER,
    audience: AUDIENCE,
    now: () => NOW,
  });
});

/** Mint an EdDSA token signed by the trusted key, with claim overrides. */
async function mint(claims: Record<string, unknown>, signer: jose.KeyLike = priv): Promise<string> {
  return new jose.SignJWT(claims).setProtectedHeader({ alg: "EdDSA" }).sign(signer);
}

const valid = { iss: ISSUER, aud: AUDIENCE, exp: nowSec + 300, sub: "control-plane" };

describe("createServiceTokenVerifier", () => {
  it("verifies a well-signed, in-window token and returns its claims", async () => {
    const claims = await verify(await mint(valid));
    expect(claims).toEqual({ iss: ISSUER, aud: AUDIENCE, exp: nowSec + 300, sub: "control-plane" });
  });

  it("verifies a token WITHOUT sub (sub is optional)", async () => {
    const claims = await verify(await mint({ iss: ISSUER, aud: AUDIENCE, exp: nowSec + 300 }));
    expect(claims).toEqual({ iss: ISSUER, aud: AUDIENCE, exp: nowSec + 300 });
    expect(claims && "sub" in claims).toBe(false);
  });

  it("rejects a token signed by a DIFFERENT key (bad signature → null)", async () => {
    const other = await jose.generateKeyPair("EdDSA", { extractable: true });
    expect(await verify(await mint(valid, other.privateKey))).toBeNull();
  });

  it("rejects a WRONG-ALG token: an HS256 (symmetric) JWT is refused by the allowlist", async () => {
    const hs = await new jose.SignJWT(valid)
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode("a-shared-secret-long-enough-for-hs256-xx"));
    expect(await verify(hs)).toBeNull();
  });

  it("rejects an EXPIRED token (exp in the past → null)", async () => {
    expect(await verify(await mint({ ...valid, exp: nowSec - 120 }))).toBeNull();
  });

  it("rejects a token with NO exp claim (short-lived is mandatory → null)", async () => {
    // jose would happily verify a well-signed token that lacks exp; the verifier
    // adds the presence requirement itself. This is the pin for that guard.
    expect(await verify(await mint({ iss: ISSUER, aud: AUDIENCE }))).toBeNull();
  });

  it("rejects a WRONG issuer → null", async () => {
    expect(await verify(await mint({ ...valid, iss: "https://evil.example.com" }))).toBeNull();
  });

  it("rejects a WRONG audience → null", async () => {
    expect(await verify(await mint({ ...valid, aud: "some-other-service" }))).toBeNull();
  });

  it("rejects an ARRAY-valued aud, even one CONTAINING the configured audience (finding 2)", async () => {
    // jose treats aud as an inclusion match, so these verify at the jose layer; the
    // exact-scalar check is what rejects them — closing the cross-deployment replay.
    expect(await verify(await mint({ ...valid, aud: [AUDIENCE, "other-deployment"] }))).toBeNull();
    expect(await verify(await mint({ ...valid, aud: [AUDIENCE] }))).toBeNull(); // single-element array too
    // The exact scalar still verifies (no over-blocking).
    expect(await verify(await mint({ ...valid, aud: AUDIENCE }))).not.toBeNull();
  });

  it("rejects garbage inputs → null (never throws)", async () => {
    for (const g of ["", "garbage", "a.b.c", "not.a.jwt.at.all", "....", "Bearer x"]) {
      expect(await verify(g), g).toBeNull();
    }
  });

  it("accepts a whole-PEM base64 wrapping of the public key", async () => {
    const wrapped = btoa(pem); // some env pipelines dislike embedded newlines
    const v = await createServiceTokenVerifier({
      publicKeyPem: wrapped,
      issuer: ISSUER,
      audience: AUDIENCE,
      now: () => NOW,
    });
    expect(await v(await mint(valid))).not.toBeNull();
  });

  it("THROWS at construction on a malformed key (fail-loud startup)", async () => {
    await expect(
      createServiceTokenVerifier({ publicKeyPem: "not-a-key", issuer: ISSUER, audience: AUDIENCE }),
    ).rejects.toThrow();
    await expect(
      createServiceTokenVerifier({
        publicKeyPem: "-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----",
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).rejects.toThrow();
  });

  it("THROWS at construction on a NON-Ed25519 key (RSA SPKI would boot then 401 everything) (finding 3)", async () => {
    const rsa = await jose.generateKeyPair("RS256", { extractable: true });
    const rsaPem = await jose.exportSPKI(rsa.publicKey);
    await expect(
      createServiceTokenVerifier({ publicKeyPem: rsaPem, issuer: ISSUER, audience: AUDIENCE }),
    ).rejects.toThrow();
    // An EC key is likewise refused.
    const ec = await jose.generateKeyPair("ES256", { extractable: true });
    await expect(
      createServiceTokenVerifier({
        publicKeyPem: await jose.exportSPKI(ec.publicKey),
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).rejects.toThrow();
  });

  it("THROWS at construction on a concatenated multi-block PEM (ambiguous key) (finding 3)", async () => {
    const second = await jose.generateKeyPair("EdDSA", { extractable: true });
    const twoBlocks = `${pem}\n${await jose.exportSPKI(second.publicKey)}`;
    await expect(
      createServiceTokenVerifier({ publicKeyPem: twoBlocks, issuer: ISSUER, audience: AUDIENCE }),
    ).rejects.toThrow(/one PEM block/);
  });
});
