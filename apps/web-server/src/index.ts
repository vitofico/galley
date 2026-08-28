/**
 * @galley/web-server — the self-host runtime web service (roadmap #5).
 *
 * A tiny Hono app that serves the built `@galley/web` SPA bundle (a static
 * `dist/` directory) over HTTP, offline-first (no CDN). It is the *runtime*
 * counterpart to `apps/web`'s build: `vite build` produces `dist/`, this serves
 * it. The browser still reaches the optional `proxy`/`sync`/`compile` services
 * the same opt-in way (query params / settings), so the served app is fully
 * standalone by default.
 *
 * The file source is INJECTED as a `StaticFiles` seam so the routing contract
 * (exact-asset serving, content types, SPA navigation fallback, path-traversal
 * rejection) is unit-testable offline with an in-memory fake — no disk, no
 * network. `server.ts` wires a disk-backed provider rooted at the dist dir and
 * binds the Node socket (the core↔wiring seam).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { GroupStore, ProjectStore } from "@galley/shared";
import type { ServiceTokenVerifier } from "@galley/auth";
import { createInternalMembershipRouter } from "./internal-membership-router.js";

/**
 * The bytes source behind the server. `relPath` is an already-validated SAFE
 * relative path (no leading slash, no `.`/`..` segments, no NUL/backslash) — the
 * app does all normalization before calling this, so a disk-backed
 * implementation can `join(root, relPath)` without re-deriving safety (it still
 * verifies containment as defense-in-depth). Returns the file bytes, or null if
 * the file is absent.
 */
export interface StaticFiles {
  read(relPath: string): Promise<Uint8Array | null>;
}

export interface WebServerAppOptions {
  files: StaticFiles;
  /**
   * Content-Security-Policy header value. Defaults to `DEFAULT_CSP` (WASM-/worker-
   * safe defense-in-depth). Pass `null` to omit the header, or a string to override
   * it (operator control via the `CSP` env in `server.ts`).
   */
  csp?: string | null;
  /**
   * Optional OIDC auth router (roadmap #4). When provided it is mounted at `/auth`
   * (before the SPA wildcard). Omitted by default → no auth endpoints, the static
   * SPA path is byte-for-byte unchanged (the no-auth local mode).
   *
   * 14-E: mounting it ALSO sets `auth: true` in the served runtime config — the
   * SPA's boot gate trusts that flag (and only that flag) to decide whether to
   * check `/auth/me`. It must mirror the mount exactly: when auth is off,
   * `/auth/me` falls through to the SPA wildcard and answers index.html 200, so
   * client-side probing would mis-detect.
   */
  authRouter?: Hono;
  /**
   * Serve-time runtime config (roadmap #5 slice 5): the server-compile service
   * URL, sourced from the `GALLEY_COMPILE_URL` env in `server.ts`. When set
   * (non-empty after trimming), the server (a) serves `GET /config.js` declaring
   * `window.__GALLEY_CONFIG__ = {"compileUrl": …};` and (b) injects
   * `<script src="/config.js"></script>` into the served `index.html` head,
   * BEFORE the bundle script — same-origin, so it works under the strict
   * `script-src 'self'` CSP with NO inline script and NO CSP weakening.
   *
   * Unset / empty / whitespace → absent: no `compileUrl` key, so a web-only
   * deploy never advertises a dead compile server — and when auth is off too,
   * no /config.js at all (404) and no tag injection: the served bytes are
   * byte-for-byte today's behavior.
   *
   * TRUST: this is OPERATOR config (trusted like env). It is still emitted with
   * full JS-string escaping (see {@link renderRuntimeConfigScript}) so even a
   * hostile env value cannot break out of the string literal, and the SPA still
   * passes it through `validateCompileUrl` before use.
   */
  compileUrl?: string | null | undefined;
  /**
   * Serve-time collaboration sync-relay URL, sourced from `GALLEY_SYNC_URL` in
   * `server.ts`. Same mechanism and trust model as {@link compileUrl}: when set
   * (non-empty after trimming) it is emitted into `/config.js` as `syncUrl`, and
   * the SPA prefers it over the build-time `VITE_GALLEY_SYNC_URL` (and over the
   * `ws(s)://<host>:1234` derivation). This lets a single shared image point at a
   * per-deploy relay address (e.g. a `wss://…/sync` ingress path) WITHOUT a
   * deployment-specific rebuild. Unset/empty → absent (no `syncUrl` key; the SPA
   * derivation is byte-for-byte unchanged).
   */
  syncUrl?: string | null | undefined;
  /**
   * Service-authenticated internal membership-read wiring (Wave 13 cloud enabler).
   * When present, a `/internal/projects/:projectId/membership/:userId` route is
   * mounted (BEFORE the SPA wildcard) that answers a project-access query for a
   * service caller bearing a valid EdDSA token — see `internal-membership-router.ts`.
   * Absent by default → no `/internal` surface, the static SPA path byte-for-byte
   * unchanged. Unlike `authRouter`/`compileUrl` this is a purely server-to-server
   * surface with NO browser-visible effect, so it is deliberately NOT reflected in
   * `/config.js`.
   */
  internalMembership?: {
    verify: ServiceTokenVerifier;
    projects: ProjectStore;
    groups: GroupStore;
  };
}

/**
 * A defense-in-depth CSP for the first-party SPA. It MUST keep the typst WASM and
 * the compile/agent Web Worker working, and MUST NOT lock `connect-src` to `'self'`
 * — the proxy/sync/compile services are opt-in at operator-chosen origins (any
 * http/https/ws). Everything else is tight. No COOP/COEP (the typst WASM needs
 * none; COEP can break it). Security-Analyst (GPT) reviewed (ADR-0017).
 *
 * `script-src` needs BOTH `'wasm-unsafe-eval'` (compile the WASM) AND `'unsafe-eval'`:
 * typst.ts 0.7's WASM init evaluates a JS string, so without `'unsafe-eval'` the
 * compiler throws in the worker and the UI hangs on "Loading compiler…". This is a
 * deliberate, verified relaxation — the cost of running the compiler in-browser.
 * `vite preview` sets no CSP, so only the runtime web-server exercises this; the
 * `e2e/web-server-csp.spec.ts` regression test serves the real bundle under this
 * policy and asserts the compiler initializes and renders real glyphs.
 */
export const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https: http: ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

/** Extension → content-type. Conservative; unknown types fall back to octet-stream. */
const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  wasm: "application/wasm",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  ico: "image/x-icon",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain; charset=utf-8",
  webmanifest: "application/manifest+json",
};

function extensionOf(relPath: string): string {
  const last = relPath.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  return dot < 0 ? "" : last.slice(dot + 1).toLowerCase();
}

function contentTypeFor(relPath: string): string {
  return CONTENT_TYPES[extensionOf(relPath)] ?? "application/octet-stream";
}

/**
 * Normalize a URL pathname to a SAFE relative path, or return null to reject.
 * Rejects any `..` segment (traversal), NUL bytes, and backslashes; collapses
 * `.` and empty segments. Returns "" for the site root.
 *
 * NB: in real HTTP the WHATWG URL parser already resolves `..` (and `%2e%2e`)
 * dot-segments to an in-root path before this runs, so the `..` rejection here is
 * belt-and-suspenders — but it is the precise, directly-tested guarantee, and the
 * disk-backed `StaticFiles` in `server.ts` adds a third containment check. Exported
 * so the normalization contract is unit-tested independent of the URL parser.
 */
export function toSafeRelPath(urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const out: string[] = [];
  for (const seg of decoded.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null; // traversal — reject outright
    out.push(seg);
  }
  return out.join("/");
}

/** A route with no file extension is treated as an SPA client-side navigation. */
function isNavigation(relPath: string): boolean {
  return extensionOf(relPath) === "";
}

const INDEX = "index.html";

/** The same-origin path the runtime config is served under (CSP: `script-src 'self'`). */
export const RUNTIME_CONFIG_PATH = "/config.js";

/** The tag injected into index.html's head when runtime config is present. */
export const RUNTIME_CONFIG_TAG = `<script src="${RUNTIME_CONFIG_PATH}"></script>`;

/**
 * Render the /config.js body: exactly `window.__GALLEY_CONFIG__ = {…};` with the
 * present values (the compile URL and/or the 14-E auth flag). SECURITY: the
 * values are operator env, but they are emitted with full JS-string escaping so
 * a hostile value can never break out of the literal:
 *   - `JSON.stringify` escapes quotes, backslashes, newlines and control chars;
 *   - `<`/`>` are escaped to `<`/`>` so the byte sequence `</script>`
 *     can never appear (defense-in-depth should the payload ever be inlined);
 *   - U+2028/U+2029 are escaped (legacy JS-source line terminators).
 * The result is a single statement whose evaluation assigns the EXACT original
 * string — round-trip pinned in runtime-config.test.ts.
 */
export interface RuntimeConfigValues {
  /** The browser-reachable server-compile URL (slice 5). */
  compileUrl?: string;
  /** The browser-reachable `ws(s)://` collaboration sync-relay URL. */
  syncUrl?: string;
  /** OIDC auth is active — mirrors the auth-router mount exactly (14-E). */
  auth?: true;
}

export function renderRuntimeConfigScript(values: RuntimeConfigValues): string {
  // Explicit key order (compileUrl, then syncUrl, then auth) keeps the emitted
  // bytes deterministic: a body without a given key is byte-for-byte the one
  // before that key existed. Keys are emitted ONLY when present — an absent
  // capability never appears as a key at all.
  const config: Record<string, unknown> = {};
  if (values.compileUrl !== undefined) config["compileUrl"] = values.compileUrl;
  if (values.syncUrl !== undefined) config["syncUrl"] = values.syncUrl;
  if (values.auth === true) config["auth"] = true;
  const json = JSON.stringify(config)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `window.__GALLEY_CONFIG__ = ${json};\n`;
}

/**
 * Inject the runtime-config script tag into the SPA shell HTML, in the head and
 * BEFORE the (Vite) bundle script so `window.__GALLEY_CONFIG__` is defined when
 * the app boots. Injection points, in order of preference:
 *   1. immediately after the opening `<head…>` tag (the normal Vite shell);
 *   2. before the first `<script` (a head-less build);
 *   3. prepended (no head, no script — degenerate, still correct).
 */
export function injectRuntimeConfigTag(html: string): string {
  const headOpen = /<head(\s[^>]*)?>/i.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + RUNTIME_CONFIG_TAG + html.slice(at);
  }
  const firstScript = html.search(/<script\b/i);
  if (firstScript >= 0) {
    return html.slice(0, firstScript) + RUNTIME_CONFIG_TAG + html.slice(firstScript);
  }
  return RUNTIME_CONFIG_TAG + html;
}

/**
 * Normalize an operator-supplied runtime-config URL: trim, and treat
 * empty/whitespace (or unset) as ABSENT — a web-only `docker compose up` passes
 * `GALLEY_COMPILE_URL=` / `GALLEY_SYNC_URL=` (empty) and must not advertise a
 * dead server or relay.
 */
function normalizeRuntimeUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function createWebServerApp(options: WebServerAppOptions): Hono {
  const { files } = options;
  const csp = options.csp === undefined ? DEFAULT_CSP : options.csp;
  const compileUrl = normalizeRuntimeUrl(options.compileUrl);
  const syncUrl = normalizeRuntimeUrl(options.syncUrl);
  // 14-E: the served auth flag mirrors the router mount EXACTLY — same option,
  // same process, so the SPA gate can trust it without probing /auth/me.
  const authEnabled = options.authRouter !== undefined;
  const runtimeConfig: RuntimeConfigValues | null =
    compileUrl !== null || syncUrl !== null || authEnabled
      ? {
          ...(compileUrl !== null ? { compileUrl } : {}),
          ...(syncUrl !== null ? { syncUrl } : {}),
          ...(authEnabled ? { auth: true as const } : {}),
        }
      : null;
  const app = new Hono();

  // Defense-in-depth security headers on every response. These never depend on
  // the served path, so a single middleware covers assets, the SPA shell, 404s,
  // and /healthz alike. `nosniff` is also (re)set per-file in `serve`.
  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("x-content-type-options", "nosniff");
    c.res.headers.set("x-frame-options", "DENY");
    c.res.headers.set("referrer-policy", "no-referrer");
    c.res.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), browsing-topics=()");
    if (csp !== null) c.res.headers.set("content-security-policy", csp);
  });

  // Health = "can I actually serve the SPA?" — a misconfigured WEB_ROOT or a
  // missing index.html reports 503, so readiness/orchestration won't route to a
  // pod that would only 404. (The Code-Reviewer's no-false-healthy guard.)
  app.get("/healthz", async (c) => {
    const ok = (await files.read(INDEX)) !== null;
    return c.json({ ok }, ok ? 200 : 503);
  });

  // OIDC auth endpoints (default OFF). Mounted BEFORE the SPA wildcard so
  // `/auth/*` is handled here rather than falling back to index.html.
  if (options.authRouter) app.route("/auth", options.authRouter);

  // Service-authenticated internal membership read (Wave 13 cloud enabler,
  // default OFF). Mounted BEFORE the SPA wildcard so `/internal/*` is answered by
  // the token-auth gate (a constant 401 for an unauthenticated caller) rather
  // than falling through to the index.html shell — the mount order is
  // security-load-bearing, pinned by internal-membership-router.test.ts.
  if (options.internalMembership) {
    app.route("/internal", createInternalMembershipRouter(options.internalMembership));
  }

  // Serve-time runtime config (slice 5 + 14-E). Registered BEFORE the SPA
  // wildcard and ONLY when a compile URL is configured or auth is on —
  // otherwise /config.js falls through to the static handler and 404s exactly
  // like any missing asset (byte-for-byte today's behavior). The body is
  // rendered ONCE at startup (the env can't change mid-process) and served
  // no-cache to match the index.html revalidation posture: a redeploy with a
  // new URL must take effect on reload.
  if (runtimeConfig !== null) {
    const configBody = renderRuntimeConfigScript(runtimeConfig);
    app.on(["GET", "HEAD"], RUNTIME_CONFIG_PATH, (c) => {
      const headers: Record<string, string> = {
        "content-type": "application/javascript; charset=utf-8",
        "x-content-type-options": "nosniff",
        "cache-control": "no-cache",
      };
      if (c.req.method === "HEAD") return c.body(null, 200, headers);
      return c.body(configBody, 200, headers);
    });
  }

  // Serve a resolved file with the right headers, or null if absent. The caching
  // policy is by path (hashed assets are immutable; index.html must revalidate).
  async function serve(c: Context, relPath: string, head: boolean): Promise<Response | null> {
    let bytes = await files.read(relPath);
    if (bytes === null) return null;
    // Runtime config injection (slice 5 + 14-E): ONLY the SPA shell (index.html
    // — root, explicit, or SPA fallback) and ONLY when configured. Other files
    // (assets, any other .html) are never rewritten; unconfigured, the shell
    // bytes are byte-for-byte the build output.
    if (runtimeConfig !== null && relPath === INDEX) {
      bytes = new TextEncoder().encode(injectRuntimeConfigTag(new TextDecoder().decode(bytes)));
    }
    const headers: Record<string, string> = {
      "content-type": contentTypeFor(relPath),
      "x-content-type-options": "nosniff",
      "cache-control": cacheControlFor(relPath),
    };
    if (head) {
      return c.body(null, 200, headers);
    }
    // Send EXACTLY the logical bytes. `readFile` returns a Node Buffer whose
    // `.buffer` is a shared pool (often 8 KiB) at a non-zero `byteOffset`, so
    // `bytes.slice().buffer` would ship the whole pool — corrupting small files
    // and leaking adjacent memory. `.set` copies just this view's range into a
    // fresh, exactly-sized ArrayBuffer (and dodges Buffer.slice's view semantics
    // + the `ArrayBufferLike`/SharedArrayBuffer typing of `bytes.buffer`).
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    return c.body(body.buffer, 200, headers);
  }

  const handler = async (c: Context) => {
    const head = c.req.method === "HEAD";
    const relPath = toSafeRelPath(new URL(c.req.url).pathname);
    if (relPath === null) return c.notFound();

    // Root or an explicit index request → index.html.
    const target = relPath === "" ? INDEX : relPath;

    const direct = await serve(c, target, head);
    if (direct !== null) return direct;

    // Missing file. If it looks like a client-side route (no extension), serve
    // the SPA shell so deep links work. A missing *asset* (extensioned) is a real
    // 404 — never masked by index.html (the Architect's missing-asset guard).
    if (relPath !== "" && isNavigation(relPath)) {
      const shell = await serve(c, INDEX, head);
      if (shell !== null) return shell;
    }
    return c.notFound();
  };

  app.on(["GET", "HEAD"], "*", handler);
  // A static file server only reads; reject mutating methods explicitly (405)
  // rather than letting them fall through to a generic 404.
  app.on(["POST", "PUT", "DELETE", "PATCH"], "*", (c) =>
    c.text("Method Not Allowed", 405, { allow: "GET, HEAD" }),
  );

  return app;
}

/** Hashed Vite assets (under assets/) are content-addressed → cache forever. */
function cacheControlFor(relPath: string): string {
  if (relPath === INDEX) return "no-cache";
  if (relPath.startsWith("assets/")) return "public, max-age=31536000, immutable";
  return "public, max-age=3600";
}
