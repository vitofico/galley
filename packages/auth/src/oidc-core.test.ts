/**
 * Roadmap #4 slice 4a: the pure OIDC core, offline, deterministic. Drives the
 * full Authorization Code + PKCE flow against a MOCKED IdP (no network, no real
 * signing yet — signature verification is the jose sibling slice) and pins the
 * security-relevant invariants: PKCE S256, one-time state, nonce-bound claims,
 * issuer/audience/expiry checks, opaque stable user ids.
 */
import { describe, it, expect } from "vitest";
import type { IdTokenClaims, OidcProviderConfig } from "@galley/shared";
import {
  generatePkce,
  randomToken,
  buildAuthorizationUrl,
  parseCallback,
  buildTokenRequest,
  parseTokenResponse,
  userIdFromOidc,
  validateIdTokenClaims,
  type RandomSource,
} from "./oidc-core.js";

const config: OidcProviderConfig = {
  issuer: "https://idp.example.com",
  clientId: "galley",
  authorizationEndpoint: "https://idp.example.com/authorize",
  tokenEndpoint: "https://idp.example.com/token",
  jwksUri: "https://idp.example.com/jwks",
  redirectUri: "https://galley.example.com/auth/callback",
};

// Deterministic random: fills with a fixed, distinguishable pattern.
const fixedRandom =
  (fill: number): RandomSource =>
  (n) =>
    new Uint8Array(n).fill(fill);

describe("PKCE", () => {
  it("derives a deterministic S256 challenge from the verifier", async () => {
    const a = await generatePkce(fixedRandom(7));
    const b = await generatePkce(fixedRandom(7));
    expect(a.method).toBe("S256");
    expect(a.codeVerifier).toBe(b.codeVerifier); // same random → same verifier
    expect(a.codeChallenge).toBe(b.codeChallenge);
    // Verifier + challenge are URL-safe base64 (no +/=).
    expect(a.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
    // S256 SHA-256 digest is 32 bytes → 43 base64url chars.
    expect(a.codeChallenge).toHaveLength(43);
  });

  it("a different verifier yields a different challenge", async () => {
    const a = await generatePkce(fixedRandom(1));
    const b = await generatePkce(fixedRandom(2));
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });
});

describe("authorization URL", () => {
  it("includes all required OIDC + PKCE params", () => {
    const url = new URL(
      buildAuthorizationUrl(config, { state: "st", nonce: "no", codeChallenge: "ch" }),
    );
    expect(url.origin + url.pathname).toBe("https://idp.example.com/authorize");
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe("galley");
    expect(p.get("redirect_uri")).toBe(config.redirectUri);
    expect(p.get("scope")).toBe("openid profile email");
    expect(p.get("state")).toBe("st");
    expect(p.get("nonce")).toBe("no");
    expect(p.get("code_challenge")).toBe("ch");
    expect(p.get("code_challenge_method")).toBe("S256");
  });

  it("honors custom scopes", () => {
    const url = new URL(
      buildAuthorizationUrl({ ...config, scopes: ["openid", "groups"] }, { state: "s", nonce: "n", codeChallenge: "c" }),
    );
    expect(url.searchParams.get("scope")).toBe("openid groups");
  });
});

describe("callback parsing", () => {
  it("accepts a valid code+state", () => {
    expect(parseCallback(new URLSearchParams("code=abc&state=xyz"))).toEqual({
      ok: true,
      code: "abc",
      state: "xyz",
    });
  });
  it("surfaces an IdP error (with state when present)", () => {
    expect(parseCallback({ error: "access_denied", state: "xyz" })).toEqual({
      ok: false,
      error: "access_denied",
      state: "xyz",
    });
  });
  it("rejects a missing code", () => {
    const r = parseCallback({ state: "xyz" });
    expect(r.ok).toBe(false);
  });
});

describe("token request shaping", () => {
  it("builds a public-client (no secret) PKCE token request", () => {
    const req = buildTokenRequest(config, { code: "c0de", codeVerifier: "verif" });
    expect(req.url).toBe(config.tokenEndpoint);
    const body = new URLSearchParams(req.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("c0de");
    expect(body.get("code_verifier")).toBe("verif");
    expect(body.get("redirect_uri")).toBe(config.redirectUri);
    expect(body.get("client_id")).toBe("galley");
    expect(req.headers.authorization).toBeUndefined(); // no secret → no basic auth
  });

  it("adds client_secret_basic for a confidential client", () => {
    const req = buildTokenRequest({ ...config, clientSecret: "s3cret" }, { code: "x", codeVerifier: "v" });
    expect(req.headers.authorization).toBe(`Basic ${btoa("galley:s3cret")}`);
  });

  it("form-encodes credentials before basic auth (a ':' / special char can't corrupt the header)", () => {
    const req = buildTokenRequest(
      { ...config, clientId: "cli:ent", clientSecret: "p@ss:word/+x" },
      { code: "x", codeVerifier: "v" },
    );
    const expected = btoa(`${encodeURIComponent("cli:ent")}:${encodeURIComponent("p@ss:word/+x")}`);
    expect(req.headers.authorization).toBe(`Basic ${expected}`);
    // Decoding splits into exactly two components on the single structural ':'.
    expect(atob(req.headers.authorization!.slice("Basic ".length)).split(":")).toHaveLength(2);
  });
});

describe("token response parsing", () => {
  it("narrows a valid response", () => {
    const r = parseTokenResponse({ id_token: "jwt", access_token: "at", token_type: "Bearer", expires_in: 3600 });
    expect(r.id_token).toBe("jwt");
    expect(r.access_token).toBe("at");
    expect(r.expires_in).toBe(3600);
  });
  it("throws on a missing id_token (or non-object)", () => {
    expect(() => parseTokenResponse({ access_token: "at" })).toThrow(/id_token/);
    expect(() => parseTokenResponse(null)).toThrow();
  });
});

describe("userIdFromOidc", () => {
  it("is stable, opaque, storage-safe, and distinguishes (iss,sub)", async () => {
    const a = await userIdFromOidc("https://idp.example.com", "user-1");
    const b = await userIdFromOidc("https://idp.example.com", "user-1");
    const c = await userIdFromOidc("https://idp.example.com", "user-2");
    const d = await userIdFromOidc("https://other.example.com", "user-1");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d); // different issuer, same sub → different id (no concat collision)
    expect(a.startsWith("oidc:")).toBe(true);
    expect(a.slice(5)).toMatch(/^[A-Za-z0-9_-]+$/); // opaque, fs/url-safe
  });

  it("does not collide across the (iss,sub) boundary (NUL-delimited, not space)", async () => {
    // The whole point of the NUL separator: with a space, `iss="a" sub="b c"` and
    // `iss="a b" sub="c"` would both hash "a b c" and collide. A NUL appears in
    // neither an issuer URL nor a sub, so the two stay distinct. This matters the
    // day a second issuer is trusted; pin it now so the separator can't regress.
    const left = await userIdFromOidc("a", "b c");
    const right = await userIdFromOidc("a b", "c");
    expect(left).not.toBe(right);
  });
});

describe("ID-token claims validation", () => {
  const base: IdTokenClaims = {
    iss: config.issuer,
    sub: "user-1",
    aud: config.clientId,
    iat: 900,
    exp: 2_000,
    nonce: "the-nonce",
  };
  const opts = { issuer: config.issuer, clientId: config.clientId, nonce: "the-nonce", nowMs: 1_000_000 };

  it("accepts a well-formed, in-time, nonce-matching token", () => {
    expect(validateIdTokenClaims(base, opts)).toEqual({ ok: true });
  });
  it("rejects issuer / audience / nonce mismatches", () => {
    expect(validateIdTokenClaims({ ...base, iss: "https://evil" }, opts)).toMatchObject({ ok: false });
    expect(validateIdTokenClaims({ ...base, aud: "someone-else" }, opts)).toMatchObject({ ok: false });
    expect(validateIdTokenClaims({ ...base, nonce: "wrong" }, opts)).toMatchObject({ ok: false });
  });
  it("requires a non-empty sub and a numeric iat", () => {
    const { sub: _s, ...noSub } = base;
    expect(validateIdTokenClaims(noSub as IdTokenClaims, opts)).toMatchObject({ ok: false, reason: "missing sub" });
    expect(validateIdTokenClaims({ ...base, sub: "" }, opts)).toMatchObject({ ok: false });
    const { iat: _i, ...noIat } = base;
    expect(validateIdTokenClaims(noIat as IdTokenClaims, opts)).toMatchObject({ ok: false, reason: "missing iat" });
  });
  it("rejects azp whenever present and != clientId (even single-aud)", () => {
    expect(validateIdTokenClaims({ ...base, azp: "evil" }, opts)).toMatchObject({ ok: false, reason: "azp mismatch" });
  });
  it("requires azp = clientId when there are multiple audiences", () => {
    expect(validateIdTokenClaims({ ...base, aud: [config.clientId, "other"] }, opts)).toMatchObject({ ok: false });
    expect(
      validateIdTokenClaims({ ...base, aud: [config.clientId, "other"], azp: config.clientId }, opts),
    ).toEqual({ ok: true });
  });
  it("rejects expired and not-yet-valid tokens (with clock tolerance)", () => {
    expect(validateIdTokenClaims({ ...base, exp: 1 }, opts)).toMatchObject({ ok: false, reason: "expired" });
    expect(validateIdTokenClaims({ ...base, nbf: 100_000 }, opts)).toMatchObject({ ok: false });
  });
  it("FAILS CLOSED when no nonce is supplied to check against", () => {
    const { nonce: _omit, ...noNonce } = opts;
    expect(validateIdTokenClaims(base, noNonce)).toMatchObject({ ok: false });
  });
});

describe("randomToken", () => {
  it("is URL-safe and high-entropy by default (distinct across calls)", () => {
    expect(randomToken()).not.toBe(randomToken());
    expect(randomToken(fixedRandom(0))).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
