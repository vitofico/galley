/**
 * Roadmap #4 slice 4b: ID-token signature verification + discovery, offline. Mints
 * a real RSA keypair with jose, signs ID tokens, serves a local JWKS, and verifies
 * — then adversarially probes the security boundary: a tampered signature, the
 * `none`/HMAC alg-confusion attacks, an unknown kid, wrong nonce/iss/aud, and
 * expiry. Discovery is validated against an injected fetch (HTTPS-only, exact iss).
 */
import { describe, it, expect, beforeAll } from "vitest";
import * as jose from "jose";
import { verifyIdToken, discoverOidcProvider, type JwksGetter } from "./index.js";

const ISSUER = "https://idp.example.com";
const CLIENT = "galley";
const NONCE = "nonce-123";
const NOW = 1_700_000_000_000; // fixed ms
const nowSec = Math.floor(NOW / 1000);

let priv: jose.KeyLike;
let jwks: JwksGetter; // trusted local key set
let otherPriv: jose.KeyLike; // an attacker key NOT in the trusted set
let pubJwk: jose.JWK;

async function signIdToken(
  claims: Record<string, unknown>,
  opts: { key?: jose.KeyLike; alg?: string; kid?: string } = {},
): Promise<string> {
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1" })
    .sign(opts.key ?? priv);
}

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
  otherPriv = (await jose.generateKeyPair("RS256", { extractable: true })).privateKey;
});

describe("verifyIdToken", () => {
  it("accepts a correctly-signed, in-time, nonce-matching token", async () => {
    const token = await signIdToken(goodClaims());
    const res = await verifyIdToken(token, opts());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.claims.sub).toBe("user-1");
  });

  it("rejects a token signed by a key NOT in the trusted JWKS", async () => {
    const token = await signIdToken(goodClaims(), { key: otherPriv });
    const res = await verifyIdToken(token, opts());
    expect(res.ok).toBe(false);
  });

  it("rejects a tampered token (payload edited after signing)", async () => {
    const token = await signIdToken(goodClaims());
    const [h, , s] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...goodClaims(), sub: "admin" })).toString("base64url");
    const res = await verifyIdToken(`${h}.${forged}.${s}`, opts());
    expect(res.ok).toBe(false);
  });

  it("rejects the alg=none attack", async () => {
    // An unsigned token with alg:none must never verify.
    const unsigned = new jose.UnsecuredJWT(goodClaims()).encode();
    const res = await verifyIdToken(unsigned, opts());
    expect(res.ok).toBe(false);
  });

  it("rejects an HMAC (alg-confusion) token even if it 'matches' the public key bytes", async () => {
    // Attacker tries HS256 using the RSA public JWK material as the MAC secret.
    const secret = new TextEncoder().encode(JSON.stringify(pubJwk));
    const hsToken = await new jose.SignJWT(goodClaims())
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .sign(secret);
    const res = await verifyIdToken(hsToken, opts());
    expect(res.ok).toBe(false); // HS256 not in the allowlist
  });

  it("rejects an unknown kid", async () => {
    const token = await signIdToken(goodClaims(), { kid: "unknown" });
    const res = await verifyIdToken(token, opts());
    expect(res.ok).toBe(false);
  });

  it("rejects wrong nonce / issuer / audience", async () => {
    expect((await verifyIdToken(await signIdToken({ ...goodClaims(), nonce: "wrong" }), opts())).ok).toBe(false);
    expect((await verifyIdToken(await signIdToken({ ...goodClaims(), iss: "https://evil" }), opts())).ok).toBe(false);
    expect((await verifyIdToken(await signIdToken({ ...goodClaims(), aud: "someone-else" }), opts())).ok).toBe(false);
  });

  it("rejects an expired token (beyond clock tolerance)", async () => {
    const token = await signIdToken({ ...goodClaims(), exp: nowSec - 3600, iat: nowSec - 7200 });
    expect((await verifyIdToken(token, opts())).ok).toBe(false);
  });

  it("rejects a token missing sub (layered claim check after signature)", async () => {
    const { sub: _omit, ...noSub } = goodClaims();
    const token = await signIdToken(noSub);
    const res = await verifyIdToken(token, opts());
    expect(res.ok).toBe(false);
  });
});

describe("discoverOidcProvider", () => {
  const wellKnown = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks`,
  };
  const fakeFetch = (body: unknown, status = 200): typeof fetch =>
    (async () =>
      ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response) as unknown as typeof fetch;

  it("returns validated HTTPS endpoints when the issuer matches", async () => {
    const d = await discoverOidcProvider(ISSUER, fakeFetch(wellKnown));
    expect(d.tokenEndpoint).toBe(`${ISSUER}/token`);
    expect(d.jwksUri).toBe(`${ISSUER}/jwks`);
  });

  it("rejects an issuer mismatch (mix-up defense)", async () => {
    await expect(discoverOidcProvider(ISSUER, fakeFetch({ ...wellKnown, issuer: "https://evil" }))).rejects.toThrow();
  });

  it("rejects a non-HTTPS endpoint in the document", async () => {
    await expect(
      discoverOidcProvider(ISSUER, fakeFetch({ ...wellKnown, token_endpoint: "http://idp.example.com/token" })),
    ).rejects.toThrow();
  });

  it("rejects a non-HTTPS issuer outright", async () => {
    await expect(discoverOidcProvider("http://idp.example.com", fakeFetch(wellKnown))).rejects.toThrow(/https/);
  });

  it("throws on a non-2xx discovery response", async () => {
    await expect(discoverOidcProvider(ISSUER, fakeFetch({}, 404))).rejects.toThrow();
  });
});

/**
 * The `allowHttp` escape hatch: a self-hoster running a LOCAL IdP (a Keycloak on
 * `http://idp.localtest.me:8090` inside a kind cluster) has no TLS to offer. It
 * is OFF unless the caller passes literal `true` — @galley/auth never reads env,
 * so a deploy can only get here by opting in explicitly.
 *
 * It is a genuine trust concession, not just an eavesdropping one: on plain http
 * an on-path attacker can serve their own discovery document and JWKS, so the
 * remaining checks (issuer match, alg allowlist, nonce, aud/azp, exp/iat) are all
 * against values the attacker supplies and a login can be FORGED as any user.
 * That is why the tests below fence it in tightly rather than treat it as a
 * cosmetic scheme swap.
 *
 * The PIN tests exist so that a future change to the option plumbing cannot
 * quietly widen the hatch: plain http must stay off by default, must need
 * literal `true`, and must never reach an https-issuer deploy.
 */
describe("discoverOidcProvider — plain-http escape hatch (default OFF)", () => {
  const HTTP_ISSUER = "http://idp.localtest.me:8090/realms/galley";
  const httpDoc = {
    issuer: HTTP_ISSUER,
    authorization_endpoint: `${HTTP_ISSUER}/protocol/openid-connect/auth`,
    token_endpoint: `${HTTP_ISSUER}/protocol/openid-connect/token`,
    jwks_uri: `${HTTP_ISSUER}/protocol/openid-connect/certs`,
  };
  const httpsDoc = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks`,
  };
  const fakeFetch = (body: unknown, status = 200): typeof fetch =>
    (async () =>
      ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response) as unknown as typeof fetch;
  const allow = { allowHttp: true } as const;

  it("PIN: http is STILL rejected by default (option absent, empty, or explicitly false)", async () => {
    await expect(discoverOidcProvider(HTTP_ISSUER, fakeFetch(httpDoc))).rejects.toThrow(/issuer must be https/);
    await expect(discoverOidcProvider(HTTP_ISSUER, fakeFetch(httpDoc), {})).rejects.toThrow(/issuer must be https/);
    await expect(discoverOidcProvider(HTTP_ISSUER, fakeFetch(httpDoc), { allowHttp: false })).rejects.toThrow(
      /issuer must be https/,
    );
  });

  it("PIN: an http endpoint inside the document is STILL rejected by default", async () => {
    for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
      await expect(
        discoverOidcProvider(ISSUER, fakeFetch({ ...httpsDoc, [k]: `http://idp.example.com/x` }), {}),
        k,
      ).rejects.toThrow(new RegExp(`${k} missing or not https`));
    }
  });

  it("PIN: allowHttp needs the LITERAL boolean true — no truthy value opens the hatch", async () => {
    // Guards the `opts.allowHttp === true` check against a regression to a bare
    // truthiness test, which a stray "0"/"false" string or a 1 from a hand-rolled
    // env parse would then silently satisfy.
    const truthy: unknown[] = [1, "1", "true", "yes", {}, [], () => true];
    for (const v of truthy) {
      await expect(
        discoverOidcProvider(HTTP_ISSUER, fakeFetch(httpDoc), { allowHttp: v as boolean }),
        String(v),
      ).rejects.toThrow(/issuer must be https/);
    }
  });

  it("accepts an http issuer + http endpoints when allowHttp is on", async () => {
    const d = await discoverOidcProvider(HTTP_ISSUER, fakeFetch(httpDoc), allow);
    expect(d.issuer).toBe(HTTP_ISSUER);
    expect(d.authorizationEndpoint).toBe(httpDoc.authorization_endpoint);
    expect(d.tokenEndpoint).toBe(httpDoc.token_endpoint);
    expect(d.jwksUri).toBe(httpDoc.jwks_uri);
  });

  it("still accepts a fully-https provider when allowHttp is on (http is permitted, not required)", async () => {
    const d = await discoverOidcProvider(ISSUER, fakeFetch(httpsDoc), allow);
    expect(d.jwksUri).toBe(`${ISSUER}/jwks`);
  });

  it("PIN: an HTTPS issuer NEVER gets http endpoints, even with allowHttp on", async () => {
    // The footgun this fences off: a real https IdP behind a proxy with a
    // misconfigured KC_HOSTNAME advertises http endpoints in its own discovery
    // document. Today that fails at startup; with a naive flag it would instead
    // start and exchange the authorization code in plaintext against a PRODUCTION
    // IdP. The hatch is for a wholly-local http deploy, so http endpoints are
    // conditional on the ISSUER itself being http.
    for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
      await expect(
        discoverOidcProvider(ISSUER, fakeFetch({ ...httpsDoc, [k]: "http://idp.example.com/x" }), allow),
        k,
      ).rejects.toThrow(new RegExp(`${k} missing or not https`));
    }
  });

  it("an http issuer may still advertise https endpoints (the hatch permits, never downgrades)", async () => {
    const d = await discoverOidcProvider(
      HTTP_ISSUER,
      fakeFetch({ ...httpDoc, jwks_uri: `${ISSUER}/jwks` }),
      allow,
    );
    expect(d.jwksUri).toBe(`${ISSUER}/jwks`);
    expect(d.tokenEndpoint).toBe(httpDoc.token_endpoint);
  });

  it("allowHttp does NOT relax the exact issuer match (mix-up defense)", async () => {
    await expect(
      discoverOidcProvider(HTTP_ISSUER, fakeFetch({ ...httpDoc, issuer: "http://evil.localtest.me" }), allow),
    ).rejects.toThrow(/issuer mismatch/);
    // A trailing-slash / case variant is still a mismatch — exact equality only.
    await expect(
      discoverOidcProvider(HTTP_ISSUER, fakeFetch({ ...httpDoc, issuer: `${HTTP_ISSUER}/` }), allow),
    ).rejects.toThrow(/issuer mismatch/);
  });

  it("allowHttp does NOT relax endpoint presence/shape", async () => {
    for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
      const { [k]: _drop, ...missing } = httpDoc as Record<string, unknown>;
      await expect(discoverOidcProvider(HTTP_ISSUER, fakeFetch(missing), allow), `missing ${k}`).rejects.toThrow(
        new RegExp(`${k} missing or not`),
      );
      await expect(
        discoverOidcProvider(HTTP_ISSUER, fakeFetch({ ...httpDoc, [k]: 42 }), allow),
        `non-string ${k}`,
      ).rejects.toThrow(new RegExp(`${k} missing or not`));
    }
  });

  it("allowHttp does NOT open any scheme other than http/https", async () => {
    for (const bad of ["ftp://idp.localtest.me/token", "file:///etc/passwd", "javascript:alert(1)", "data:,x"]) {
      await expect(
        discoverOidcProvider(HTTP_ISSUER, fakeFetch({ ...httpDoc, token_endpoint: bad }), allow),
        bad,
      ).rejects.toThrow(/token_endpoint missing or not/);
    }
    await expect(discoverOidcProvider("ftp://idp.localtest.me", fakeFetch(httpDoc), allow)).rejects.toThrow(
      /issuer must be/,
    );
  });

  it("allowHttp does NOT relax the discovery HTTP status check", async () => {
    await expect(discoverOidcProvider(HTTP_ISSUER, fakeFetch({}, 404), allow)).rejects.toThrow(/discovery failed/);
  });

  it("allowHttp does NOT relax ID-token verification (signature/alg/nonce still enforced)", async () => {
    // The flag is a transport concession only: nothing about it reaches token
    // verification, which has no separate switch to turn off.
    const hsSecret = new TextEncoder().encode(JSON.stringify(pubJwk));
    const hsToken = await new jose.SignJWT(goodClaims())
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .sign(hsSecret);
    expect((await verifyIdToken(hsToken, opts())).ok).toBe(false);
    const wrongNonce = await signIdToken({ ...goodClaims(), nonce: "wrong" });
    expect((await verifyIdToken(wrongNonce, opts())).ok).toBe(false);
  });
});
