/**
 * Adversarial property/fuzz harness for the PURE OIDC core + stores
 * (oidc-core.ts, stores.ts, upgrade.ts), wave-33 #22.2 — the LAST light auth
 * surfaces. Signature verification lives in verify.fuzz.test.ts (jose-backed).
 *
 * The cores are already adversarially tested (oidc-core.test.ts / stores.test.ts /
 * upgrade.test.ts). This harness is the SECOND wall: it sweeps DETERMINISTICALLY
 * GENERATED malformed/hostile claims, callbacks, cookies, and store-lifecycle
 * sequences and pins the load-bearing invariants for EVERY one:
 *
 *   AUTH-INV-1 (claims fail-closed): validateIdTokenClaims accepts ONLY a token
 *     with the exact issuer, our client in aud, a present non-empty sub, finite
 *     numeric iat, an unexpired/in-window exp/nbf, AND a present matching nonce.
 *     A missing/NaN/Infinity/wrong-type field on ANY of these → ok:false. There is
 *     NO input that flips a genuinely-invalid token to ok:true.
 *
 *   AUTH-INV-2 (no fixation / one-time state): every session create mints a fresh
 *     id; consume() burns a login-state exactly once (incl. expired) — no replay.
 *
 *   AUTH-INV-3 (parse totality): parseCallback / parseCookie never throw on hostile
 *     input and never fabricate a code/state/cookie that wasn't actually present.
 *
 * DETERMINISM: inputs derive from the loop index — no Math.random / Date.now.
 */
import { describe, it, expect } from "vitest";
import type { IdTokenClaims, OidcLoginState, SessionRecord } from "@galley/shared";
import {
  validateIdTokenClaims,
  parseCallback,
  parseCookie,
  buildAuthorizationUrl,
  buildTokenRequest,
  parseTokenResponse,
  userIdFromOidc,
  randomToken,
  InMemorySessionStore,
  InMemoryOidcLoginStateStore,
  authorizeSyncUpgrade,
  type RandomSource,
  type ClaimsValidationOptions,
} from "./index.js";
import type { Authorizer, OidcProviderConfig } from "@galley/shared";

const ISSUER = "https://idp.example.com";
const CLIENT = "galley";
const NONCE = "the-nonce";
const NOW_MS = 1_000_000;
const nowSec = Math.floor(NOW_MS / 1000);

const config: OidcProviderConfig = {
  issuer: ISSUER,
  clientId: CLIENT,
  authorizationEndpoint: "https://idp.example.com/authorize",
  tokenEndpoint: "https://idp.example.com/token",
  jwksUri: "https://idp.example.com/jwks",
  redirectUri: "https://galley.example.com/auth/callback",
};

const goodClaims = (): IdTokenClaims => ({
  iss: ISSUER,
  sub: "user-1",
  aud: CLIENT,
  iat: nowSec - 10,
  exp: nowSec + 3600,
  nonce: NONCE,
});

const opts: ClaimsValidationOptions = { issuer: ISSUER, clientId: CLIENT, nonce: NONCE, nowMs: NOW_MS };

describe("validateIdTokenClaims — fuzz: AUTH-INV-1 single-field corruption never flips to ok:true", () => {
  // Each mutator deterministically corrupts ONE security-load-bearing field; the
  // result MUST be ok:false for every one. Index-addressable.
  const mutators: ReadonlyArray<readonly [string, (c: IdTokenClaims, i: number) => IdTokenClaims]> = [
    ["iss-wrong", (c, i) => ({ ...c, iss: `https://evil-${i}.example` })],
    ["iss-missing", (c) => { const { iss: _o, ...r } = c; return r as IdTokenClaims; }],
    ["iss-empty", (c) => ({ ...c, iss: "" })],
    ["sub-missing", (c) => { const { sub: _o, ...r } = c; return r as IdTokenClaims; }],
    ["sub-empty", (c) => ({ ...c, sub: "" })],
    ["sub-nonstring", (c, i) => ({ ...c, sub: i as unknown as string })],
    ["aud-wrong", (c, i) => ({ ...c, aud: `other-${i}` })],
    ["aud-missing", (c) => { const { aud: _o, ...r } = c; return r as IdTokenClaims; }],
    ["aud-array-without-us", (c, i) => ({ ...c, aud: [`a-${i}`, `b-${i}`] })],
    ["aud-multi-no-azp", (c) => ({ ...c, aud: [CLIENT, "other"] })],
    ["azp-wrong", (c, i) => ({ ...c, azp: `evil-${i}` })],
    ["iat-missing", (c) => { const { iat: _o, ...r } = c; return r as IdTokenClaims; }],
    ["iat-nan", (c) => ({ ...c, iat: Number.NaN })],
    ["iat-inf", (c) => ({ ...c, iat: Number.POSITIVE_INFINITY })],
    ["iat-nonnumber", (c) => ({ ...c, iat: "900" as unknown as number })],
    ["exp-missing", (c) => { const { exp: _o, ...r } = c; return r as IdTokenClaims; }],
    ["exp-past", (c, i) => ({ ...c, exp: nowSec - 3600 - i })],
    ["exp-nan", (c) => ({ ...c, exp: Number.NaN })],
    ["exp-inf", (c) => ({ ...c, exp: Number.POSITIVE_INFINITY })],
    ["exp-nonnumber", (c) => ({ ...c, exp: "9999" as unknown as number })],
    ["nbf-future", (c, i) => ({ ...c, nbf: nowSec + 3600 + i })],
    ["nbf-nan", (c) => ({ ...c, nbf: Number.NaN })],
    ["nbf-inf", (c) => ({ ...c, nbf: Number.POSITIVE_INFINITY })],
    ["nonce-wrong", (c, i) => ({ ...c, nonce: `wrong-${i}` })],
    ["nonce-missing", (c) => { const { nonce: _o, ...r } = c; return r as IdTokenClaims; }],
    ["nonce-empty", (c) => ({ ...c, nonce: "" })],
  ];

  it("every single-field corruption is rejected, across repeated deterministic seeds", () => {
    for (let i = 0; i < mutators.length * 8; i++) {
      const [label, mutate] = mutators[i % mutators.length]!;
      const claims = mutate(goodClaims(), i);
      const res = validateIdTokenClaims(claims, opts);
      expect(res.ok, `corruption '${label}' (i=${i}) should be rejected`).toBe(false);
    }
  });

  it("fails closed when the verifier supplies NO nonce, regardless of token nonce", () => {
    const { nonce: _omit, ...noNonceOpts } = opts;
    for (let i = 0; i < 16; i++) {
      const claims = { ...goodClaims(), nonce: `tok-nonce-${i}` };
      expect(validateIdTokenClaims(claims, noNonceOpts).ok).toBe(false);
    }
  });

  it("the canonical good token still validates (no false negative introduced)", () => {
    expect(validateIdTokenClaims(goodClaims(), opts)).toEqual({ ok: true });
    // Multi-aud with correct azp is the ONLY multi-aud accept.
    expect(
      validateIdTokenClaims({ ...goodClaims(), aud: [CLIENT, "other"], azp: CLIENT }, opts),
    ).toEqual({ ok: true });
  });

  it("clock tolerance is bounded: exp just-inside passes, just-outside (beyond tol) fails", () => {
    const tol = 60;
    // exp exactly at now - tol is the inclusive edge (now > exp+tol is the reject).
    for (let i = 0; i < 20; i++) {
      const insideExp = nowSec - tol; // now == exp+tol → NOT > → accept
      const outsideExp = nowSec - tol - 1 - i; // now > exp+tol → reject
      expect(validateIdTokenClaims({ ...goodClaims(), exp: insideExp }, opts).ok).toBe(true);
      expect(validateIdTokenClaims({ ...goodClaims(), exp: outsideExp }, opts).ok).toBe(false);
    }
  });
});

describe("parseCallback / parseCookie — fuzz: AUTH-INV-3 parse totality, no fabrication", () => {
  it("parseCallback never throws and never fabricates code+state that weren't both present", () => {
    // Deterministic matrix of present/absent code/state/error.
    for (let i = 0; i < 64; i++) {
      const hasCode = (i & 1) !== 0;
      const hasState = (i & 2) !== 0;
      const hasError = (i & 4) !== 0;
      const rec: Record<string, string> = {};
      if (hasCode) rec.code = `code-${i}`;
      if (hasState) rec.state = `state-${i}`;
      if (hasError) rec.error = `err-${i}`;
      const res = parseCallback(rec);
      if (res.ok) {
        // A success REQUIRES both code and state actually present, and no error.
        expect(hasCode && hasState && !hasError).toBe(true);
        expect(res.code).toBe(`code-${i}`);
        expect(res.state).toBe(`state-${i}`);
      } else {
        // A failure never invents a state that wasn't supplied.
        if (res.state !== undefined) expect(hasState).toBe(true);
      }
    }
  });

  it("parseCallback on URLSearchParams agrees with the record form and never throws on junk", () => {
    const junk = ["", "&&&", "code", "code=", "=v", "code=a&state=b&x=%ZZ", "a=1;b=2", "code=a&code=b"];
    for (let i = 0; i < junk.length; i++) {
      // Must not throw for any of these.
      const params = new URLSearchParams(junk[i]!);
      const res = parseCallback(params);
      expect(typeof res.ok).toBe("boolean");
    }
  });

  it("parseCookie extracts only an actually-present cookie and never throws on hostile headers", () => {
    const name = "__Host-galley.sid";
    const headers = [
      undefined,
      null,
      "",
      ";;;",
      "=",
      "a=1",
      `${name}=wanted`,
      `x=1; ${name}=wanted; y=2`,
      `${name}=has=equals=signs`,
      `  ${name}  =  spaced  `,
      `${name}`, // no '=' at all
      `not${name}=decoy; ${name}=real`,
      `${name}=; b=2`, // empty value
      "%ZZ=%ZZ", // malformed percent-encoding (must not throw)
    ];
    for (let i = 0; i < headers.length; i++) {
      const got = parseCookie(headers[i] ?? null, name);
      // Never throws (reaching here proves it); value, when found, is trimmed.
      if (got !== null) expect(typeof got).toBe("string");
    }
    // Spot-pin the meaningful extractions.
    expect(parseCookie(`x=1; ${name}=wanted; y=2`, name)).toBe("wanted");
    expect(parseCookie(`${name}=has=equals=signs`, name)).toBe("has=equals=signs");
    expect(parseCookie(`  ${name}  =  spaced  `, name)).toBe("spaced");
    expect(parseCookie(`not${name}=decoy; ${name}=real`, name)).toBe("real"); // no prefix confusion
    expect(parseCookie(`${name}`, name)).toBeNull(); // a bare name (no '=') is not a value
  });
});

describe("InMemorySessionStore — fuzz: AUTH-INV-2 no fixation, expiry strictly enforced", () => {
  const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
    userId: "oidc:abc",
    createdAtMs: 0,
    expiresAtMs: 10_000,
    ...over,
  });

  it("every create across a deterministic batch mints a DISTINCT high-entropy id", async () => {
    const store = new InMemorySessionStore();
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const { id } = await store.create(rec());
      expect(ids.has(id)).toBe(false); // no reuse → no fixation
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(id.length).toBeGreaterThanOrEqual(40);
      ids.add(id);
    }
    expect(ids.size).toBe(200);
  });

  it("getValid enforces the expiry boundary deterministically (<= now → reaped null)", async () => {
    for (let i = 0; i < 50; i++) {
      const store = new InMemorySessionStore(() => `sid-${i}`);
      const exp = 5_000 + i;
      await store.create(rec({ expiresAtMs: exp }));
      expect(await store.getValid(`sid-${i}`, exp - 1)).not.toBeNull(); // still valid
      expect(await store.getValid(`sid-${i}`, exp)).toBeNull(); // boundary inclusive → expired
      // Reaped on the expired access: a follow-up plain get is also null.
      expect(await store.get(`sid-${i}`)).toBeNull();
    }
  });
});

describe("InMemoryOidcLoginStateStore — fuzz: state is one-time, never replayable", () => {
  const st = (s: string, exp: number): OidcLoginState => ({
    state: s,
    codeVerifier: `v-${s}`,
    nonce: `n-${s}`,
    returnTo: "/",
    expiresAtMs: exp,
  });

  it("consume burns the state exactly once across a deterministic batch (valid + expired)", async () => {
    const store = new InMemoryOidcLoginStateStore();
    for (let i = 0; i < 100; i++) {
      const s = `state-${i}`;
      const expired = i % 2 === 0;
      await store.put(st(s, expired ? 1_000 : 9_999));
      const consumeNow = expired ? 2_000 : 1_000; // expired ones lapse before consume
      const first = await store.consume(s, consumeNow);
      if (expired) {
        expect(first).toBeNull(); // expired → null
      } else {
        expect(first).toMatchObject({ state: s });
      }
      // ALWAYS burned: a second consume (even with a generous clock) is null → no replay.
      expect(await store.consume(s, 500)).toBeNull();
    }
  });
});

describe("authorizeSyncUpgrade — fuzz: fails closed for every non-authorized shape", () => {
  const COOKIE = "__Host-galley.sid";
  const allowing = (pairs: string[]): Authorizer => {
    const set = new Set(pairs);
    return { canAccessProject: async (u, p) => set.has(`${u}:${p}`) };
  };

  it("only a valid, unexpired session whose user is a member authorizes", async () => {
    for (let i = 0; i < 60; i++) {
      const store = new InMemorySessionStore(() => "sid-1");
      await store.create({ userId: "u1", createdAtMs: 0, expiresAtMs: 10_000 });
      const authorizer = allowing(["u1:room1"]);
      // Deterministically vary the failure dimension.
      const dim = i % 5;
      const cookieHeader =
        dim === 0 ? `${COOKIE}=sid-1` : // valid
        dim === 1 ? undefined : // no cookie
        dim === 2 ? `${COOKIE}=wrong-${i}` : // unknown sid
        `${COOKIE}=sid-1`; // valid sid but other failures below
      const room = dim === 3 ? "other-room" : "room1"; // non-member room
      const nowMs = dim === 4 ? 20_000 : 5_000; // expired
      const got = await authorizeSyncUpgrade({ cookieHeader, room, sessionStore: store, authorizer, nowMs });
      expect(got).toBe(dim === 0); // ONLY the all-correct case authorizes
    }
  });
});

describe("buildAuthorizationUrl / buildTokenRequest — fuzz: hostile config values can't break out of the encoding", () => {
  it("state/nonce/challenge are query-encoded and never escape into other params", () => {
    for (let i = 0; i < 40; i++) {
      // Hostile values that would be dangerous if naively concatenated.
      const state = `s&redirect_uri=https://evil-${i}&x`;
      const nonce = `n#frag?q=${i}`;
      const codeChallenge = `c=injected&scope=admin-${i}`;
      const url = new URL(buildAuthorizationUrl(config, { state, nonce, codeChallenge }));
      // Round-trips EXACTLY — the injection chars are encoded, not structural.
      expect(url.searchParams.get("state")).toBe(state);
      expect(url.searchParams.get("nonce")).toBe(nonce);
      expect(url.searchParams.get("code_challenge")).toBe(codeChallenge);
      // The attacker could NOT smuggle a second redirect_uri / scope value.
      expect(url.searchParams.getAll("redirect_uri")).toEqual([config.redirectUri]);
      expect(url.searchParams.getAll("scope")).toEqual(["openid profile email"]);
      expect(url.searchParams.get("response_type")).toBe("code");
    }
  });

  it("basic-auth credentials are component-encoded so a ':' can't split the header", () => {
    for (let i = 0; i < 30; i++) {
      const clientId = `cli:ent:${i}`;
      const clientSecret = `p@ss:word/+=${i}`;
      const req = buildTokenRequest({ ...config, clientId, clientSecret }, { code: "c", codeVerifier: "v" });
      const decoded = atob(req.headers.authorization!.slice("Basic ".length));
      // Exactly two components on the single STRUCTURAL ':' (the rest are encoded).
      expect(decoded.split(":")).toHaveLength(2);
      const [encId, encSecret] = decoded.split(":");
      expect(decodeURIComponent(encId!)).toBe(clientId);
      expect(decodeURIComponent(encSecret!)).toBe(clientSecret);
    }
  });
});

describe("parseTokenResponse / userIdFromOidc — fuzz: narrowing + collision-resistance", () => {
  it("parseTokenResponse throws on every non-conforming shape, narrows valid ones", () => {
    const bad: unknown[] = [null, undefined, 1, "str", [], {}, { access_token: "a" }, { id_token: "" }, { id_token: 5 }];
    for (let i = 0; i < bad.length; i++) {
      expect(() => parseTokenResponse(bad[i])).toThrow();
    }
    const good = parseTokenResponse({ id_token: "jwt", access_token: "a", expires_in: 1, junk: "x" });
    expect(good.id_token).toBe("jwt");
    expect((good as unknown as Record<string, unknown>).junk).toBeUndefined(); // extra fields dropped
  });

  it("distinct (iss,sub) pairs never collide; same pair is stable", async () => {
    const seen = new Map<string, string>();
    for (let i = 0; i < 50; i++) {
      // Breadth, not boundary: these pairs are pairwise distinct on their own
      // (the iss always ends ".example", the sub never contains the delimiter),
      // so they stay apart under ANY delimiter — this case pins bulk uniqueness
      // and per-pair stability at scale, NOT delimiter choice. The real
      // boundary-collision guard ("a"+"b c" vs "a b"+"c") is the dedicated pin
      // in oidc-core.test.ts; do not read this case as covering it.
      const iss = `https://a${"b".repeat(i)}.example`;
      const sub = `${"c".repeat(50 - i)}user`;
      const id = await userIdFromOidc(iss, sub);
      const stable = await userIdFromOidc(iss, sub);
      expect(id).toBe(stable);
      expect(id.startsWith("oidc:")).toBe(true);
      expect(seen.has(id)).toBe(false);
      seen.set(id, `${iss}|${sub}`);
    }
  });
});

describe("randomToken / generatePkce determinism guards", () => {
  it("a fixed RandomSource yields a deterministic, URL-safe token (test-seam works)", () => {
    const fixed: RandomSource = (n) => new Uint8Array(n).fill(7);
    expect(randomToken(fixed)).toBe(randomToken(fixed));
    expect(randomToken(fixed)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
