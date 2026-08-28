/**
 * Roadmap #4 slice 4c: the live OIDC auth router, driven offline through Hono's
 * `app.request` against a MOCKED IdP (minted keypair + a fake token endpoint).
 * Proves the full login→callback→me→logout flow AND the Security-Analyst wiring
 * must-enforce list: __Host- HttpOnly/Secure/SameSite=Lax cookie, same-origin
 * returnTo (open-redirect guard), one-time state (replay), signature-verified
 * tokens only, and the unauthenticated path.
 */
import { describe, it, expect, beforeAll } from "vitest";
import * as jose from "jose";
import type { OidcLoginState, OidcProviderConfig } from "@galley/shared";
import { InMemorySessionStore, InMemoryOidcLoginStateStore, type JwksGetter } from "@galley/auth";
import { createAuthRouter, safeReturnTo, type AuthRouterDeps } from "./auth-router.js";

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
let otherPriv: jose.KeyLike;
let jwks: JwksGetter;

beforeAll(async () => {
  const kp = await jose.generateKeyPair("RS256", { extractable: true });
  priv = kp.privateKey;
  const pub = { ...(await jose.exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  jwks = jose.createLocalJWKSet({ keys: [pub] });
  otherPriv = (await jose.generateKeyPair("RS256", { extractable: true })).privateKey;
});

const goodClaims = (nonce: string): Record<string, unknown> => ({
  iss: ISSUER,
  sub: "user-1",
  aud: CLIENT,
  iat: nowSec - 10,
  exp: nowSec + 3600,
  nonce,
});

function sign(claims: Record<string, unknown>, key: jose.KeyLike = priv): Promise<string> {
  return new jose.SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).sign(key);
}

/**
 * Build a router + a fake IdP token endpoint that signs an ID token bound to the
 * latest login's nonce. `tokenOverride` lets a test inject a bad response.
 */
function setup(
  overrides: Partial<AuthRouterDeps> = {},
  tokenOverride?: { key?: jose.KeyLike; claims?: (nonce: string) => Record<string, unknown>; status?: number; body?: unknown },
) {
  const sessionStore = new InMemorySessionStore();
  const loginStateStore = new InMemoryOidcLoginStateStore();
  const puts: OidcLoginState[] = [];
  const origPut = loginStateStore.put.bind(loginStateStore);
  loginStateStore.put = async (s) => {
    puts.push(s);
    return origPut(s);
  };

  const fetchImpl = (async () => {
    if (tokenOverride?.status || tokenOverride?.body !== undefined) {
      return new Response(JSON.stringify(tokenOverride.body ?? {}), {
        status: tokenOverride.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    const nonce = puts[puts.length - 1]!.nonce;
    const claims = tokenOverride?.claims ? tokenOverride.claims(nonce) : goodClaims(nonce);
    const idToken = await sign(claims, tokenOverride?.key ?? priv);
    return new Response(JSON.stringify({ id_token: idToken, token_type: "Bearer" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const app = createAuthRouter({
    config,
    sessionStore,
    loginStateStore,
    jwks,
    fetch: fetchImpl,
    now: () => NOW,
    ...overrides,
  });
  return { app, sessionStore, puts };
}

/** Run login → return the state param + the stored login transaction. */
async function login(app: ReturnType<typeof setup>["app"], puts: OidcLoginState[], returnTo = "/projects/x") {
  const res = await app.request(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  expect(res.status).toBe(302);
  const authUrl = new URL(res.headers.get("location")!);
  return { res, authUrl, state: authUrl.searchParams.get("state")!, ls: puts[puts.length - 1]! };
}

describe("auth router — full flow", () => {
  it("login → callback → me → logout", async () => {
    const { app, puts } = setup();

    const { authUrl, state, ls } = await login(app, puts);
    expect(authUrl.origin + authUrl.pathname).toBe(config.authorizationEndpoint);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("redirect_uri")).toBe(config.redirectUri); // from config, not Host
    expect(ls.state).toBe(state);
    expect(ls.returnTo).toBe("/projects/x");

    const cb = await app.request(`/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/projects/x");
    const setCookie = cb.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("__Host-galley.sid=");
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    const sid = setCookie.match(/__Host-galley\.sid=([^;]+)/)![1]!;

    const me = await app.request("/me", { headers: { cookie: `__Host-galley.sid=${sid}` } });
    expect(me.status).toBe(200);
    // /me is the SPA boot gate's authority — a cached 200 could render the app
    // after logout/expiry, so EVERY response must be no-store (+ Vary: Cookie).
    expect(me.headers.get("cache-control")).toBe("no-store");
    expect(me.headers.get("vary")).toBe("Cookie");
    const body = (await me.json()) as { authenticated: boolean; userId: string; oidc?: { sub: string } };
    expect(body.authenticated).toBe(true);
    expect(body.userId.startsWith("oidc:")).toBe(true);
    expect(body.oidc?.sub).toBe("user-1");

    const out = await app.request("/logout", { method: "POST", headers: { cookie: `__Host-galley.sid=${sid}` } });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");

    const me2 = await app.request("/me", { headers: { cookie: `__Host-galley.sid=${sid}` } });
    expect(me2.status).toBe(401); // session destroyed
    expect(me2.headers.get("cache-control")).toBe("no-store"); // the 401 too
    expect(me2.headers.get("vary")).toBe("Cookie");
  });

  // 14-E (auth activation UX): /me carries a human-readable identity for the
  // account chip — the ID token's `name`, else `email`, else nothing (the SPA
  // falls back to the opaque userId). Stored on the session at callback time;
  // never used for authorization.
  it("/me surfaces the OIDC name (else email) as `display`", async () => {
    const meAfterLogin = async (extra: Record<string, unknown>) => {
      const { app, puts } = setup({}, { claims: (nonce) => ({ ...goodClaims(nonce), ...extra }) });
      const { state } = await login(app, puts);
      const cb = await app.request(`/callback?code=abc&state=${encodeURIComponent(state)}`);
      const sid = (cb.headers.get("set-cookie") ?? "").match(/__Host-galley\.sid=([^;]+)/)![1]!;
      const me = await app.request("/me", { headers: { cookie: `__Host-galley.sid=${sid}` } });
      return (await me.json()) as { display?: string };
    };
    expect((await meAfterLogin({ name: "Ada Lovelace", email: "ada@example.com" })).display).toBe("Ada Lovelace");
    expect((await meAfterLogin({ email: "ada@example.com" })).display).toBe("ada@example.com");
    expect((await meAfterLogin({ name: "   " })).display).toBeUndefined(); // whitespace ≠ a name
    expect("display" in (await meAfterLogin({}))).toBe(false); // neither claim → key absent
  });

  it("insecure-cookie mode drops Secure + the __Host- prefix (dev/loopback)", async () => {
    const { app, puts } = setup({ cookie: { secure: false } });
    const { state } = await login(app, puts);
    const cb = await app.request(`/callback?code=abc&state=${encodeURIComponent(state)}`);
    const setCookie = cb.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("galley.sid=");
    expect(setCookie).not.toContain("__Host-");
    expect(setCookie).not.toMatch(/Secure/);
  });
});

describe("auth router — security", () => {
  it("forces a same-origin returnTo (open-redirect guard)", async () => {
    for (const evil of ["https://evil.com", "//evil.com", "/\\evil", "javascript:alert(1)"]) {
      const { app, puts } = setup();
      const { state } = await login(app, puts, evil);
      const cb = await app.request(`/callback?code=abc&state=${encodeURIComponent(state)}`);
      expect(cb.headers.get("location"), evil).toBe("/");
    }
  });

  it("rejects an unknown / already-consumed state (replay defense)", async () => {
    const { app, puts } = setup();
    const { state } = await login(app, puts);
    expect((await app.request(`/callback?code=abc&state=${state}`)).status).toBe(302); // first use
    expect((await app.request(`/callback?code=abc&state=${state}`)).status).toBe(400); // replay → burned
    expect((await app.request(`/callback?code=abc&state=nope`)).status).toBe(400); // unknown
  });

  it("rejects an ID token signed by an untrusted key (401, no session)", async () => {
    const { app, puts, sessionStore } = setup({}, { key: otherPriv });
    const { state } = await login(app, puts);
    const cb = await app.request(`/callback?code=abc&state=${state}`);
    expect(cb.status).toBe(401);
    expect(cb.headers.get("set-cookie")).toBeNull();
    // no session was created
    const me = await app.request("/me");
    expect(me.status).toBe(401);
    void sessionStore;
  });

  it("rejects a token-endpoint error (502) and a non-2xx", async () => {
    const { app, puts } = setup({}, { status: 500, body: { error: "boom" } });
    const { state } = await login(app, puts);
    expect((await app.request(`/callback?code=abc&state=${state}`)).status).toBe(502);
  });

  it("/me is 401 without a cookie; /callback with no state is 400", async () => {
    const { app } = setup();
    const me = await app.request("/me");
    expect(me.status).toBe(401);
    expect(me.headers.get("cache-control")).toBe("no-store"); // never cacheable
    expect(me.headers.get("vary")).toBe("Cookie");
    expect((await app.request("/callback?code=abc")).status).toBe(400);
  });
});

describe("safeReturnTo", () => {
  it("keeps same-origin paths (incl. hyphens/query) and rejects everything else", () => {
    expect(safeReturnTo("/projects/my-doc?x=1")).toBe("/projects/my-doc?x=1");
    expect(safeReturnTo("/")).toBe("/");
    expect(safeReturnTo(undefined)).toBe("/");
    for (const bad of ["https://evil", "//evil", "/\\x", "/\r/x", "/\n", "evil", ""]) {
      expect(safeReturnTo(bad), bad).toBe("/");
    }
  });
});
