/**
 * Node entry for the static web server. Serves the built `@galley/web` bundle
 * from a directory on disk and binds `PORT` (default 8080).
 *   pnpm --filter @galley/web-server start
 *
 * Env:
 *   - `PORT`       — listen port (default 8080).
 *   - `WEB_ROOT`   — directory holding the built SPA (default: the installed
 *                    `@galley/web/dist`, resolved relative to this file in the
 *                    runtime image; override for local runs).
 *   - `CSP`        — Content-Security-Policy override. Unset → the WASM-safe
 *                    `DEFAULT_CSP`; `off` → omit the header; any other value →
 *                    use it verbatim.
 *   - `GALLEY_COMPILE_URL` — serve-time runtime config (roadmap #5 slice 5): the
 *                    BROWSER-REACHABLE URL of the server-compile service. Set →
 *                    the server serves `/config.js` and injects its script tag
 *                    into index.html so the SPA's Server/Auto compile toggle can
 *                    reach the service without a per-deploy image rebuild.
 *                    Unset/empty → absent (no /config.js, no injection — the SPA
 *                    bytes are byte-for-byte the build output).
 *
 * OIDC auth (default OFF — preserves the no-auth single-user local mode):
 *   - `GALLEY_AUTH_MODE=oidc`        — opt in. Anything else → no auth endpoints.
 *                    Opting in ALSO adds `auth: true` to the served runtime
 *                    config (/config.js — 14-E): the SPA's boot gate trusts that
 *                    flag (never a probe) to require a session before rendering.
 *   - `GALLEY_OIDC_ISSUER`           — IdP issuer (discovery: <issuer>/.well-known/…).
 *   - `GALLEY_OIDC_CLIENT_ID`        — OAuth client id.
 *   - `GALLEY_OIDC_CLIENT_SECRET`    — optional (confidential client).
 *   - `GALLEY_PUBLIC_BASE_URL`       — public origin; redirect_uri = <base>/auth/callback.
 *   - `GALLEY_OIDC_SCOPES`           — optional, space-separated (default openid profile email).
 *   - `GALLEY_INSECURE_COOKIES=1`    — dev/loopback only: drop Secure + __Host- (HTTP).
 *   - `GALLEY_OIDC_ALLOW_HTTP=1`     — dev/local only: let discovery accept a plain-
 *                                      http issuer and THAT issuer's http endpoints
 *                                      (a local IdP with no TLS). An https issuer
 *                                      never gets http endpoints. Default OFF →
 *                                      https-only, unchanged. Gives up IdP
 *                                      AUTHENTICATION: on plain http an on-path
 *                                      attacker serves their own discovery doc +
 *                                      JWKS and forges a login as any user, so the
 *                                      remaining checks are no defense there. Trusted
 *                                      paths only. Pairs with GALLEY_INSECURE_COOKIES=1.
 *   - `GALLEY_SESSION_DIR`           — REQUIRED under OIDC. Persist sessions/login-
 *                                      state to this dir (durable + shareable across
 *                                      containers via a mounted volume). Mount the
 *                                      SAME path into the sync container so it can
 *                                      validate web-minted sessions. Missing under
 *                                      OIDC → fail closed (see server-config.ts).
 *   - `GALLEY_DATA_DIR`              — the shared data volume (#1 slice 2). Under
 *                                      OIDC it additionally hosts the capability-room
 *                                      registry the Share/Agent-Access routes write
 *                                      and the sync relay reads. Unset → those routes
 *                                      are not mounted (registration fails closed;
 *                                      a loud startup warning is logged).
 *
 * Internal service membership read (default OFF — a self-host loses nothing without it):
 *   - `GALLEY_INTERNAL_SERVICE_PUBLIC_KEY`  — SPKI PEM (or whole-PEM base64) public
 *                                      key that verifies the calling service's EdDSA
 *                                      JWT. Set (with the two below) → mount
 *                                      `GET /internal/projects/:projectId/membership/:userId`.
 *   - `GALLEY_INTERNAL_SERVICE_ISSUER`      — required token `iss`.
 *   - `GALLEY_INTERNAL_SERVICE_AUDIENCE`    — required token `aud`.
 *                                      All three together enable the endpoint; a
 *                                      partial set (or those without `GALLEY_DATA_DIR`,
 *                                      whose projects/groups it reads) fails loud at
 *                                      startup. See server-config.ts.
 */
import { Server as HttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import type { OidcProviderConfig } from "@galley/shared";
import { remoteJwks, discoverOidcProvider, createServiceTokenVerifier } from "@galley/auth";
import { FsCapabilityRoomRegistry, FsProjectStore, FsGroupStore } from "@galley/persistence";
import { createWebServerApp, type StaticFiles, type WebServerAppOptions } from "./index.js";
import { createAuthRouter } from "./auth-router.js";
import {
  isOidcEnabled,
  isOidcHttpAllowed,
  resolveAuthStores,
  resolveInternalMembershipConfig,
} from "./server-config.js";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`PORT must be an integer 0-65535; got ${JSON.stringify(process.env.PORT)}`);
}

// Default to the workspace web build. In the runtime image the whole monorepo is
// present, so apps/web/dist sits two levels up from apps/web-server/src.
const here = fileURLToPath(new URL(".", import.meta.url));
const defaultRoot = resolve(here, "../../web/dist");
const root = resolve(process.env.WEB_ROOT ?? defaultRoot);

/**
 * Disk-backed `StaticFiles`. The app has already normalized `relPath` to a safe
 * relative path (no `..`), but we verify containment again as defense-in-depth:
 * the resolved absolute path must stay within `root`. A missing file (ENOENT) or
 * any read error resolves to null → a clean 404, never a thrown 500.
 */
const files: StaticFiles = {
  read: async (relPath) => {
    const abs = resolve(root, relPath);
    if (abs !== root && !abs.startsWith(root + sep)) return null; // escaped root
    try {
      return await readFile(abs);
    } catch {
      return null;
    }
  },
};

const cspEnv = process.env.CSP?.trim();
const csp = cspEnv === undefined || cspEnv === "" ? undefined : cspEnv === "off" ? null : cspEnv;

// Serve-time compile-URL runtime config. Passed through verbatim; the app
// normalizes (trim, empty → absent) and escapes it (see index.ts).
const compileUrl = process.env.GALLEY_COMPILE_URL ?? null;

// Serve-time sync-relay URL runtime config (browser-reachable `ws(s)://`). Lets a
// deploy that fronts the relay at a per-deploy address (e.g. a `wss://…/sync`
// ingress path) point the SPA there without baking a deployment-specific
// `VITE_GALLEY_SYNC_URL` into the shared image. Same passthrough as compileUrl.
const syncUrl = process.env.GALLEY_SYNC_URL ?? null;

/**
 * Build the OIDC auth router from env, or null when auth is OFF (the default).
 * Discovery runs once at startup. Sessions/login-state use the durable, cross-
 * container-shareable Fs stores; `resolveAuthStores` fails closed when OIDC is on
 * but no shared `GALLEY_SESSION_DIR` is configured (in-memory can't cross to the
 * sync container — see server-config.ts).
 */
async function buildAuthRouter(): Promise<Hono | null> {
  if (!isOidcEnabled(process.env)) return null;
  // Fail closed FIRST: refuse to start an OIDC web-server that can't share
  // sessions with sync, before any network discovery.
  const { sessionStore, loginStateStore } = resolveAuthStores(process.env);
  const issuer = required("GALLEY_OIDC_ISSUER");
  const clientId = required("GALLEY_OIDC_CLIENT_ID");
  const baseUrl = required("GALLEY_PUBLIC_BASE_URL").replace(/\/$/, "");
  const clientSecret = process.env.GALLEY_OIDC_CLIENT_SECRET?.trim();
  const scopes = process.env.GALLEY_OIDC_SCOPES?.trim().split(/\s+/).filter(Boolean);

  // Dev/local escape hatch, default OFF: `GALLEY_OIDC_ALLOW_HTTP=1` lets
  // discovery accept a plain-http IdP. Resolved ONCE here (so the dev-only
  // warning is logged exactly once at startup) and threaded explicitly into the
  // discovery call — @galley/auth stays pure and reads no env.
  const allowHttp = isOidcHttpAllowed(process.env);
  const disco = await discoverOidcProvider(issuer, undefined, { allowHttp });
  const config: OidcProviderConfig = {
    issuer: disco.issuer,
    clientId,
    authorizationEndpoint: disco.authorizationEndpoint,
    tokenEndpoint: disco.tokenEndpoint,
    jwksUri: disco.jwksUri,
    redirectUri: `${baseUrl}/auth/callback`,
    ...(clientSecret ? { clientSecret } : {}),
    ...(scopes && scopes.length > 0 ? { scopes } : {}),
  };
  // Capability-room registry (#1 slice 2): registration/revocation routes for
  // Share + Agent Access rooms under an auth-required sync relay. The registry
  // lives on the SHARED data volume (`GALLEY_DATA_DIR` — the same volume the
  // sync relay mounts to read it). Without the volume the routes are NOT
  // mounted and registration fails CLOSED at the client (Share / Agent Access
  // surface a clean error; no capability is ever minted server-side) — but a
  // deploy that requires sync auth should mount it, so warn loudly.
  const dataDir = process.env.GALLEY_DATA_DIR?.trim();
  if (!dataDir) {
    // eslint-disable-next-line no-console
    console.warn(
      "[galley/web-server] GALLEY_AUTH_MODE=oidc but GALLEY_DATA_DIR is unset: the " +
        "capability-room routes are disabled, so Share links and Agent Access pairing " +
        "will FAIL CLOSED against a GALLEY_SYNC_AUTH=required relay. Mount the same " +
        "data volume as the sync container and set GALLEY_DATA_DIR to enable them.",
    );
  }

  return createAuthRouter({
    config,
    sessionStore,
    loginStateStore,
    jwks: remoteJwks(config.jwksUri),
    cookie: { secure: process.env.GALLEY_INSECURE_COOKIES !== "1" },
    ...(dataDir ? { capabilityRooms: { store: new FsCapabilityRoomRegistry(dataDir) } } : {}),
  });
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required when GALLEY_AUTH_MODE=oidc`);
  return v;
}

/**
 * Build the service-authenticated internal membership-read wiring from env, or
 * `undefined` when the feature is OFF (the default). `resolveInternalMembershipConfig`
 * fails LOUD on a partial config (some but not all of the three
 * `GALLEY_INTERNAL_SERVICE_*` vars, or those without `GALLEY_DATA_DIR`). The
 * jose-backed verifier is built in @galley/auth (jose is only a devDependency
 * here) and its SPKI key is imported ONCE — a malformed key rejects at startup.
 * The project/group stores read the SAME shared `GALLEY_DATA_DIR` volume the sync
 * relay authorizes against.
 */
async function buildInternalMembership(): Promise<WebServerAppOptions["internalMembership"]> {
  const cfg = resolveInternalMembershipConfig(process.env);
  if (!cfg) return undefined;
  const verify = await createServiceTokenVerifier({
    publicKeyPem: cfg.publicKeyPem,
    issuer: cfg.issuer,
    audience: cfg.audience,
  });
  return {
    verify,
    projects: new FsProjectStore(cfg.dataDir),
    groups: new FsGroupStore(cfg.dataDir),
  };
}

Promise.all([buildAuthRouter(), buildInternalMembership()])
  .then(([authRouter, internalMembership]) => {
    const base =
      csp === undefined ? { files, compileUrl, syncUrl } : { files, csp, compileUrl, syncUrl };
    const app = createWebServerApp({
      ...base,
      ...(authRouter ? { authRouter } : {}),
      ...(internalMembership ? { internalMembership } : {}),
    });
    const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });

    // Resource-limit hardening (#22.2 defense-in-depth, slow-loris): the web-server
    // is the ONLY publicly-exposed service by default, so bound how long one
    // connection may take to deliver its request. `@hono/node-server` returns the
    // underlying Node `http.Server`; set the timeouts on it. GENEROUS ceilings — a
    // normal asset/SPA request completes in milliseconds, so only a slow-trickle
    // connection is dropped. `headersTimeout` < `requestTimeout` (header phase
    // bounded first). The server only reads (GET/HEAD; mutating methods → 405), so
    // there is no large-body path to cap here; the proxy carries the body cap.
    const HEADERS_TIMEOUT_MS = 30_000; // slow-loris: full request headers within 30s
    const REQUEST_TIMEOUT_MS = 60_000; // whole request must arrive within 60s
    // `serve()` returns a plain HTTP `http.Server` here; the instanceof narrows
    // the `ServerType` union so the timeout setters typecheck.
    if (server instanceof HttpServer) {
      server.headersTimeout = HEADERS_TIMEOUT_MS;
      server.requestTimeout = REQUEST_TIMEOUT_MS;
    }

    // Log only non-sensitive startup facts (never the client secret / tokens).
    // The compile URL is operator deploy config — fine to log.
    // eslint-disable-next-line no-console
    console.log(
      `[galley/web-server] serving ${root} on http://0.0.0.0:${port}${authRouter ? " (OIDC auth enabled)" : ""}${internalMembership ? " (internal membership read enabled)" : ""}${compileUrl?.trim() ? ` (compile URL: ${compileUrl.trim()})` : ""}${syncUrl?.trim() ? ` (sync URL: ${syncUrl.trim()})` : ""}`,
    );

    // Graceful shutdown on SIGTERM/SIGINT (k8s / `docker stop`): drain in-flight
    // requests then exit; safety timeout forces exit if close hangs.
    for (const sig of ["SIGTERM", "SIGINT"]) {
      process.on(sig, () => {
        setTimeout(() => process.exit(0), 10_000).unref();
        server.close(() => process.exit(0));
      });
    }
  })
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("[galley/web-server] failed to start:", err);
    process.exit(1);
  });
