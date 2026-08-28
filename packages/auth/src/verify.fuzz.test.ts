/**
 * Adversarial fuzz harness for the jose-backed ID-token SIGNATURE verification
 * (verify.ts), wave-33 #22.2 — the LAST light auth surface. verify.test.ts already
 * pins the named attacks (alg=none, HMAC alg-confusion, unknown kid, tamper, wrong
 * nonce/iss/aud, expiry). This harness is the SECOND wall: it sweeps the
 * alg-confusion / wrong-key / structural-mangling space DETERMINISTICALLY and pins:
 *
 *   VERIFY-INV (no forgery verifies): the ONLY token that verifies is one signed by
 *     a key in the TRUSTED JWKS with an ALLOWLISTED asymmetric alg AND all claims
 *     correct. No alg substitution (none / HS* / unlisted), no foreign key, no
 *     embedded jwk/jku header, no structural mangling can produce ok:true. verifyIdToken
 *     NEVER throws (it returns ok:false with a non-leaky reason).
 *
 * DETERMINISM: a single keypair is minted once; every adversarial case is derived
 * from a loop index over fixed pools — no Math.random / Date.now.
 */
import { describe, it, expect, beforeAll } from "vitest";
import * as jose from "jose";
import { verifyIdToken, DEFAULT_ID_TOKEN_ALGS, type JwksGetter } from "./index.js";

const ISSUER = "https://idp.example.com";
const CLIENT = "galley";
const NONCE = "nonce-123";
const NOW = 1_700_000_000_000;
const nowSec = Math.floor(NOW / 1000);

let priv: jose.KeyLike;
let pubJwk: jose.JWK;
let jwks: JwksGetter; // trusted set (k1)
let foreignPriv: jose.KeyLike; // a key NOT in the trusted set
let esPriv: jose.KeyLike; // an EC key signed under k1's id (kid spoof)

const goodClaims = () => ({
  iss: ISSUER,
  sub: "user-1",
  aud: CLIENT,
  iat: nowSec - 10,
  exp: nowSec + 3600,
  nonce: NONCE,
});

const opts = () => ({ jwks, issuer: ISSUER, clientId: CLIENT, nonce: NONCE, nowMs: NOW });

beforeAll(async () => {
  const kp = await jose.generateKeyPair("RS256", { extractable: true });
  priv = kp.privateKey;
  pubJwk = { ...(await jose.exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  jwks = jose.createLocalJWKSet({ keys: [pubJwk] });
  foreignPriv = (await jose.generateKeyPair("RS256", { extractable: true })).privateKey;
  esPriv = (await jose.generateKeyPair("ES256", { extractable: true })).privateKey;
});

describe("verifyIdToken — fuzz: VERIFY-INV no alg substitution verifies", () => {
  it("symmetric / unlisted / none algs are ALL rejected (alg-confusion sweep)", async () => {
    // Symmetric MAC attempts using the public JWK bytes as the secret, plus the
    // explicit none variants. None of these is in DEFAULT_ID_TOKEN_ALGS.
    const macSecret = new TextEncoder().encode(JSON.stringify(pubJwk));
    const hmacAlgs = ["HS256", "HS384", "HS512"];
    for (let i = 0; i < hmacAlgs.length; i++) {
      const tok = await new jose.SignJWT(goodClaims())
        .setProtectedHeader({ alg: hmacAlgs[i]!, kid: "k1" })
        .sign(macSecret);
      const res = await verifyIdToken(tok, opts());
      expect(res.ok, `${hmacAlgs[i]} must be rejected`).toBe(false);
    }
    // alg=none (unsecured JWT) — never verifies.
    const unsigned = new jose.UnsecuredJWT(goodClaims()).encode();
    expect((await verifyIdToken(unsigned, opts())).ok).toBe(false);
  });

  it("a token whose alg is asymmetric but NOT on the allowlist is rejected", async () => {
    // Restrict the allowlist to RS256 only, then present an ES256 token signed by a
    // (here irrelevant) key: it must be refused by the algorithm gate.
    const esToken = await new jose.SignJWT(goodClaims())
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .sign(esPriv);
    const res = await verifyIdToken(esToken, { ...opts(), algorithms: ["RS256"] });
    expect(res.ok).toBe(false);
  });

  it("the configured allowlist is asymmetric-only (defensive constant sanity)", () => {
    for (const a of DEFAULT_ID_TOKEN_ALGS) {
      expect(a.startsWith("HS")).toBe(false);
      expect(a).not.toBe("none");
    }
  });
});

describe("verifyIdToken — fuzz: foreign key / kid spoof never verifies", () => {
  it("a token signed by a key NOT in the trusted JWKS is rejected regardless of kid", async () => {
    const kids = ["k1", "k2", "unknown", "", "../k1"];
    for (let i = 0; i < kids.length; i++) {
      const tok = await new jose.SignJWT(goodClaims())
        .setProtectedHeader({ alg: "RS256", kid: kids[i]! })
        .sign(foreignPriv); // foreign key, but claims the trusted kid
      const res = await verifyIdToken(tok, opts());
      expect(res.ok, `foreign key with kid='${kids[i]}' must be rejected`).toBe(false);
    }
  });

  it("a token carrying an EMBEDDED public jwk header (self-referential key) is rejected", async () => {
    // Attacker signs with their OWN (foreign) key and embeds a public jwk in the
    // header, hoping the verifier trusts the token-supplied key instead of the
    // configured JWKS. jose selects from the trusted set by kid and ignores the
    // header jwk/jku/x5u entirely → rejected. We embed the FOREIGN public key so
    // a header-trusting verifier would (wrongly) accept it.
    const foreignPubJwk = { ...(await jose.exportJWK(foreignPriv)), kid: "k1", alg: "RS256", use: "sig" };
    const tok = await new jose.SignJWT(goodClaims())
      .setProtectedHeader({ alg: "RS256", kid: "k1", jwk: foreignPubJwk as unknown as jose.JWK })
      .sign(foreignPriv);
    const res = await verifyIdToken(tok, opts());
    expect(res.ok).toBe(false);
  });
});

describe("verifyIdToken — fuzz: structural mangling never crashes and never verifies", () => {
  it("mangled compact-JWS strings all return ok:false without throwing", async () => {
    const valid = await new jose.SignJWT(goodClaims())
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .sign(priv);
    const [h, p, s] = valid.split(".");
    const mangled: string[] = [
      "", // empty
      "....", // dots only
      "a.b", // two segments
      "a.b.c.d", // four segments
      h!, // header only
      `${h}.${p}`, // missing signature
      `${h}.${p}.`, // empty signature
      `.${p}.${s}`, // empty header
      `${h}..${s}`, // empty payload
      `${h}.${p}.${s}X`, // corrupted signature tail
      `${s}.${p}.${h}`, // reordered segments
      `${h}.${Buffer.from('{"sub":"admin"}').toString("base64url")}.${s}`, // payload swap
      "not.base64.atall!!!",
      "\u0000.\u0000.\u0000", // NUL bytes
      "🔥.🔥.🔥", // non-ascii
    ];
    for (let i = 0; i < mangled.length; i++) {
      const res = await verifyIdToken(mangled[i]!, opts());
      expect(res.ok, `mangled[${i}] must not verify`).toBe(false);
      // Never throws (reaching here proves it); reason is a bounded diagnostic string.
      expect(typeof (res as { reason?: string }).reason).toBe("string");
    }
  });

  it("the valid control token still verifies (no false negative from the harness)", async () => {
    const valid = await new jose.SignJWT(goodClaims())
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .sign(priv);
    const res = await verifyIdToken(valid, opts());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.claims.sub).toBe("user-1");
  });
});

describe("verifyIdToken — fuzz: post-signature claim corruption is caught (belt-and-suspenders)", () => {
  // A token correctly SIGNED by the trusted key but with a corrupt claim must still
  // be rejected by the layered checks (nonce/iss/aud/exp/sub) — signature validity
  // alone never authenticates.
  const claimMutators: ReadonlyArray<readonly [string, (c: Record<string, unknown>, i: number) => Record<string, unknown>]> = [
    ["wrong-nonce", (c, i) => ({ ...c, nonce: `wrong-${i}` })],
    ["missing-nonce", (c) => { const { nonce: _o, ...r } = c; return r; }],
    ["wrong-iss", (c, i) => ({ ...c, iss: `https://evil-${i}.example` })],
    ["wrong-aud", (c, i) => ({ ...c, aud: `other-${i}` })],
    ["expired", (c, i) => ({ ...c, exp: nowSec - 3600 - i, iat: nowSec - 7200 })],
    ["missing-sub", (c) => { const { sub: _o, ...r } = c; return r; }],
    ["empty-sub", (c) => ({ ...c, sub: "" })],
  ];

  it("every signed-but-corrupt claim variant is rejected", async () => {
    for (let i = 0; i < claimMutators.length * 4; i++) {
      const [label, mutate] = claimMutators[i % claimMutators.length]!;
      const claims = mutate(goodClaims() as Record<string, unknown>, i);
      const tok = await new jose.SignJWT(claims as jose.JWTPayload)
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .sign(priv); // properly signed by the TRUSTED key
      const res = await verifyIdToken(tok, opts());
      expect(res.ok, `signed-but-${label} (i=${i}) must be rejected`).toBe(false);
    }
  });
});
