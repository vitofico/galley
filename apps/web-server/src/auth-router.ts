/**
 * The OIDC auth router (roadmap #4 slice 4c, ADR-0018 §3) — the live HTTP wiring
 * for the framework-agnostic `@galley/auth` core. Mounted at `/auth` in
 * `apps/web-server` ONLY when OIDC is configured (default OFF → the static SPA
 * path is byte-for-byte unchanged). Hono lives here, not in `@galley/auth`.
 *
 * Bakes in the slice-4a/4b Security-Analyst must-enforce list: signature-verified
 * ID tokens only, opaque server-side sessions in a `__Host-` HttpOnly/Secure/
 * SameSite=Lax cookie, one-time short-TTL login state, same-origin-only `returnTo`
 * (open-redirect guard), redirect_uri from configured base URL (never `Host`), and
 * no token/secret ever logged.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type {
  CapabilityRoomStore,
  OidcProviderConfig,
  OidcLoginStateStore,
  SessionRecord,
  SessionStore,
} from "@galley/shared";
import {
  generatePkce,
  randomToken,
  buildAuthorizationUrl,
  parseCallback,
  buildTokenRequest,
  parseTokenResponse,
  verifyIdToken,
  userIdFromOidc,
  registerCapabilityRoom,
  revokeCapabilityRoom,
  type JwksGetter,
  type RandomSource,
} from "@galley/auth";

export interface AuthRouterDeps {
  config: OidcProviderConfig;
  sessionStore: SessionStore;
  loginStateStore: OidcLoginStateStore;
  /** Trusted JWKS resolver — `remoteJwks(config.jwksUri)` in prod, a local set in tests. */
  jwks: JwksGetter;
  /** Injected for tests; defaults to global fetch (the IdP token endpoint call). */
  fetch?: typeof fetch;
  now?: () => number;
  random?: RandomSource;
  /** Absolute session lifetime (ms). Default 8h. */
  sessionTtlMs?: number;
  /** Login-transaction TTL (ms). Default 10min. */
  stateTtlMs?: number;
  cookie?: { name?: string; secure?: boolean };
  /**
   * Capability-room registry (#1 slice 2). When provided, the router mounts the
   * cookie-authenticated, same-origin-enforced registration/revocation routes
   * (`POST /capability-rooms`, `POST /capability-rooms/:roomId/revoke`). Omitted
   * (e.g. no `GALLEY_DATA_DIR` on the web-server) → the routes are absent and the
   * rest of the router is byte-for-byte unchanged.
   */
  capabilityRooms?: { store: CapabilityRoomStore };
}

/** Max accepted body for the capability-room routes ({roomId, kind, projectId?}). */
export const MAX_CAPABILITY_BODY_BYTES = 4096;

const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * A safe post-login redirect target: a same-origin absolute PATH only. Rejects
 * absolute URLs, protocol-relative `//host`, backslashes, and control chars
 * (open-redirect defense). Anything suspect → "/".
 */
export function safeReturnTo(raw: string | undefined | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (raw.includes("\\") || /[\u0000-\u001f]/.test(raw)) return "/";
  return raw;
}

interface CookieCfg {
  name: string;
  secure: boolean;
}

function resolveCookieCfg(cookie: AuthRouterDeps["cookie"]): CookieCfg {
  const secure = cookie?.secure ?? true;
  // The __Host- prefix REQUIRES Secure + Path=/ + no Domain; can't use it insecure.
  const name = cookie?.name ?? (secure ? "__Host-galley.sid" : "galley.sid");
  return { name, secure };
}

function setSessionCookie(cfg: CookieCfg, id: string, maxAgeSec: number): string {
  const attrs = [`${cfg.name}=${id}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${maxAgeSec}`];
  if (cfg.secure) attrs.push("Secure");
  return attrs.join("; ");
}

function clearSessionCookie(cfg: CookieCfg): string {
  const attrs = [`${cfg.name}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (cfg.secure) attrs.push("Secure");
  return attrs.join("; ");
}

/**
 * The human-readable identity to show in the account UI (14-E): the verified ID
 * token's `name`, else `email`, else nothing (the SPA falls back to the opaque
 * userId). Display only — authorization always uses `userId`.
 */
function displayFromClaims(claims: { name?: unknown; email?: unknown }): string | undefined {
  for (const value of [claims.name, claims.email]) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function createAuthRouter(deps: AuthRouterDeps): Hono {
  const { config, sessionStore, loginStateStore, jwks } = deps;
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const random = deps.random;
  const sessionTtlMs = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const stateTtlMs = deps.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
  const cookieCfg = resolveCookieCfg(deps.cookie);

  const app = new Hono();

  // Start login: mint PKCE + state + nonce, stash the transaction, redirect to the IdP.
  app.get("/login", async (c) => {
    const returnTo = safeReturnTo(c.req.query("returnTo"));
    const pkce = await generatePkce(random);
    const state = randomToken(random);
    const nonce = randomToken(random);
    await loginStateStore.put({ state, codeVerifier: pkce.codeVerifier, nonce, returnTo, expiresAtMs: now() + stateTtlMs });
    return c.redirect(buildAuthorizationUrl(config, { state, nonce, codeChallenge: pkce.codeChallenge }));
  });

  // IdP redirect-back: validate state, exchange code, verify the ID token, open a session.
  app.get("/callback", async (c) => {
    const parsed = parseCallback(c.req.query());
    if (!parsed.ok) return c.text("invalid callback", 400);
    const ls = await loginStateStore.consume(parsed.state, now()); // one-time, expiry-checked
    if (!ls) return c.text("unknown or expired login state", 400);

    let tokenJson: unknown;
    try {
      const tr = buildTokenRequest(config, { code: parsed.code, codeVerifier: ls.codeVerifier });
      const resp = await fetchImpl(tr.url, { method: tr.method, headers: tr.headers, body: tr.body });
      if (!resp.ok) return c.text("token exchange failed", 502);
      tokenJson = await resp.json();
    } catch {
      return c.text("token exchange error", 502);
    }

    let idToken: string;
    try {
      idToken = parseTokenResponse(tokenJson).id_token;
    } catch {
      return c.text("malformed token response", 502);
    }

    const verified = await verifyIdToken(idToken, {
      jwks,
      issuer: config.issuer,
      clientId: config.clientId,
      nonce: ls.nonce,
      nowMs: now(),
    });
    if (!verified.ok) return c.text("id token rejected", 401);

    const createdAtMs = now();
    const userId = await userIdFromOidc(verified.claims.iss, verified.claims.sub);
    const display = displayFromClaims(verified.claims);
    const { id } = await sessionStore.create({
      userId,
      createdAtMs,
      expiresAtMs: createdAtMs + sessionTtlMs,
      oidc: { iss: verified.claims.iss, sub: verified.claims.sub },
      ...(display !== undefined ? { display } : {}),
    });
    c.header("set-cookie", setSessionCookie(cookieCfg, id, Math.floor(sessionTtlMs / 1000)));
    return c.redirect(ls.returnTo); // already same-origin-validated at login
  });

  // Who am I? (the SPA polls this to know the auth state). `display` (14-E) is
  // the human-readable identity for the account chip; absent when the IdP sent
  // neither `name` nor `email`.
  //
  // CACHING: /me is the SPA boot gate's AUTHORITY, so EVERY response (200 and
  // 401 alike) is `no-store` — a cached `authenticated: true` could render the
  // app after logout/expiry (or mask a failure), and a cached 401 could lock a
  // fresh session out. `Vary: Cookie` is belt-and-suspenders for any shared
  // cache that ignores no-store: the answer is a pure function of the cookie.
  app.get("/me", async (c) => {
    c.header("cache-control", "no-store");
    c.header("vary", "Cookie");
    const id = readCookie(c.req.header("cookie"), cookieCfg.name);
    const session = id ? await sessionStore.getValid(id, now()) : null;
    if (!session) return c.json({ authenticated: false }, 401);
    return c.json({
      authenticated: true,
      userId: session.userId,
      ...(session.oidc !== undefined ? { oidc: session.oidc } : {}),
      ...(session.display !== undefined ? { display: session.display } : {}),
    });
  });

  // Logout: drop the server session AND clear the cookie.
  app.post("/logout", async (c) => {
    const id = readCookie(c.req.header("cookie"), cookieCfg.name);
    if (id) await sessionStore.delete(id);
    c.header("set-cookie", clearSessionCookie(cookieCfg));
    return c.body(null, 204);
  });

  // ---- Capability rooms (#1 slice 2) --------------------------------------
  // Registration/revocation for Share + Agent Access rooms under an
  // auth-required sync relay. The POLICY (validation, idempotency, tombstones,
  // caps, GC) lives in @galley/auth; these routes own only the HTTP guards:
  //
  //   1. SAME-ORIGIN: mutating routes require an `Origin` header EXACTLY equal
  //      to the deployment's public origin (derived from the configured
  //      redirect_uri — never from the untrusted Host header). Browsers always
  //      send Origin on POST, so this is a strict CSRF wall; absent/mismatched
  //      Origin → constant 403. (SameSite=Lax already blocks the cookie on
  //      cross-site POSTs; this is the explicit second wall.)
  //   2. COOKIE SESSION: the same expiry-enforcing `getValid` read /me uses;
  //      no/invalid/expired session → constant 401. The session also supplies
  //      `createdBy` and the control-room expiry — NEVER the request body.
  //   3. BODY BOUNDS: JSON only, ≤ MAX_CAPABILITY_BODY_BYTES. Content-Length
  //      is REQUIRED (411 when absent — security round M1: a chunked body has
  //      no declared length, so the pre-check alone could be bypassed and the
  //      server would buffer an unbounded stream). These are same-origin JSON
  //      POSTs from our own fetch() (which always sends CL for string bodies),
  //      so requiring it costs nothing. The post-read check measures BYTES
  //      (UTF-8), not UTF-16 chars, for the direct-invocation/lying-CL case.
  //
  // Every response is `no-store` and a constant `{ok}`/`{ok,code}` shape — no
  // roomId/userId echoes, no store internals (no enumeration/ownership oracle).
  if (deps.capabilityRooms !== undefined) {
    const store = deps.capabilityRooms.store;
    const expectedOrigin = new URL(config.redirectUri).origin;

    const sessionOf = async (c: Context): Promise<SessionRecord | null> => {
      const id = readCookie(c.req.header("cookie"), cookieCfg.name);
      return id ? sessionStore.getValid(id, now()) : null;
    };
    const constJson = (
      c: Context,
      status: 200 | 400 | 401 | 403 | 404 | 409 | 411 | 413,
      body: { ok: boolean; code?: string },
    ) => {
      c.header("cache-control", "no-store");
      return c.json(body, status);
    };
    const utf8 = new TextEncoder();

    app.post("/capability-rooms", async (c) => {
      if (c.req.header("origin") !== expectedOrigin) {
        return constJson(c, 403, { ok: false, code: "forbidden" });
      }
      const session = await sessionOf(c);
      if (!session) return constJson(c, 401, { ok: false, code: "unauthenticated" });
      // M1: Content-Length is mandatory — absent (e.g. a chunked request) → 411
      // BEFORE any body byte is read; malformed or over-cap → 413. Only then is
      // the (now declared-bounded) body read, and re-measured in UTF-8 BYTES as
      // defense-in-depth against a lying declaration.
      const declared = c.req.header("content-length")?.trim();
      if (declared === undefined) {
        return constJson(c, 411, { ok: false, code: "length-required" });
      }
      if (!/^\d{1,9}$/.test(declared) || Number(declared) > MAX_CAPABILITY_BODY_BYTES) {
        return constJson(c, 413, { ok: false, code: "too-large" });
      }
      const contentType = c.req.header("content-type") ?? "";
      if (!contentType.toLowerCase().includes("application/json")) {
        return constJson(c, 400, { ok: false, code: "invalid" });
      }
      let body: unknown;
      try {
        const text = await c.req.text();
        if (
          text.length > MAX_CAPABILITY_BODY_BYTES ||
          utf8.encode(text).byteLength > MAX_CAPABILITY_BODY_BYTES
        ) {
          return constJson(c, 413, { ok: false, code: "too-large" });
        }
        body = JSON.parse(text);
      } catch {
        return constJson(c, 400, { ok: false, code: "invalid" });
      }
      const result = await registerCapabilityRoom(store, {
        body,
        userId: session.userId,
        sessionExpiresAtMs: session.expiresAtMs,
        nowMs: now(),
      });
      return constJson(c, result.status, result.body);
    });

    app.post("/capability-rooms/:roomId/revoke", async (c) => {
      if (c.req.header("origin") !== expectedOrigin) {
        return constJson(c, 403, { ok: false, code: "forbidden" });
      }
      const session = await sessionOf(c);
      if (!session) return constJson(c, 401, { ok: false, code: "unauthenticated" });
      const result = await revokeCapabilityRoom(store, {
        roomId: c.req.param("roomId"),
        userId: session.userId,
        nowMs: now(),
      });
      return constJson(c, result.status, result.body);
    });
  }

  return app;
}
