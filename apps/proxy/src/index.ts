/**
 * @galley/proxy — thin, stateless, optional model-API forward-proxy (ADR-0004,
 * docs/providers.md). It does EXACTLY ONE thing: relay a model-API request from
 * the browser to a NAMED upstream, inject the API key server-side, and stream
 * the response back verbatim.
 *
 * Non-negotiables (enforced + tested):
 *   - Named upstreams only, resolved from env; the client selects one by id via
 *     the `x-galley-upstream` header — never a URL. No SSRF / open relay.
 *   - Never log bodies (document context) or keys (auth header).
 *   - Stream the response through unbuffered (the agent loop streams).
 *   - CORS allowlist from env (ALLOWED_ORIGINS).
 *   - Stateless: no DB, no disk, no sessions.
 */

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { GALLEY_UPSTREAM_HEADER } from "@galley/shared";
import type { UpstreamConfig } from "@galley/shared";

/**
 * Resolve configured upstreams from env. Pattern per id:
 *   UPSTREAM_<ID>_URL  (required)
 *   UPSTREAM_<ID>_AUTH_HEADER  (default "Authorization")
 *   UPSTREAM_<ID>_KEY  (the literal header value to inject, e.g. "Bearer sk-...")
 *
 * The stored id is the lowercased `<ID>` (what the client references). An entry
 * missing its URL is skipped.
 */
export function loadUpstreams(
  env: Record<string, string | undefined>,
): Map<string, UpstreamConfig> {
  const out = new Map<string, UpstreamConfig>();
  for (const [key, value] of Object.entries(env)) {
    const m = /^UPSTREAM_(.+)_URL$/.exec(key);
    if (!m || !value) continue;
    const ENV_ID = m[1]!;
    const id = ENV_ID.toLowerCase();
    out.set(id, {
      id,
      url: value,
      authHeader: env[`UPSTREAM_${ENV_ID}_AUTH_HEADER`] ?? "Authorization",
      key: env[`UPSTREAM_${ENV_ID}_KEY`] ?? "",
    });
  }
  return out;
}

export interface ProxyOptions {
  /** Browser origins allowed by CORS (the web app). */
  allowedOrigins: string[];
  /**
   * Hard ceiling (bytes) on a forwarded request body. A generous default
   * ({@link DEFAULT_MAX_BODY_BYTES}) far above any legitimate model-API request
   * but far below what would OOM the process. Enforced two ways on `/forward/*`:
   * a `Content-Length` pre-check (reject before opening the upstream socket) and
   * a streaming byte counter that aborts a chunked/length-less body the moment it
   * crosses the cap. An over-cap request gets a clean 413, never a hang or OOM.
   * Override for an upstream that legitimately accepts larger uploads.
   */
  maxBodyBytes?: number;
  /**
   * OPTIONAL defense-in-depth shared secret. When set, every `/forward/*`
   * request must carry `Authorization: Bearer <accessToken>` (constant-time
   * compared) or it is refused `401` BEFORE the upstream key is injected — so a
   * deployment that exposes the proxy but forgets to wire the edge auth
   * (oauth2-proxy / ingress auth annotation) fails CLOSED instead of leaking the
   * operator's upstream key to any caller. Unset (the default) → no gate and the
   * behavior is unchanged: the proxy stays localhost-only / CORS-gated. CORS does
   * not stop a non-browser client (curl ignores it), which is exactly the gap
   * this closes. An empty/whitespace token is treated as unset.
   */
  accessToken?: string;
}

/** Constant-time string compare (length-leak is acceptable; value is not). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Default forwarded-body cap: 16 MiB. Defense-in-depth (#22.2) against a
 * large-body OOM DoS (`curl -T /dev/zero http://proxy/forward/…`). The proxy
 * STREAMS bodies, so without a cap a single client could push unbounded bytes
 * through the process. 16 MiB clears any realistic chat/completions or
 * multimodal request (images are usually base64 ≤ a few MiB) while bounding the
 * blast radius. The web-server accepts no bodies (mutating methods → 405), so
 * this cap lives only on the proxy.
 */
export const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Request headers we must never forward upstream (client-supplied auth/host). */
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "authorization",
  "x-api-key",
  "origin",
  "referer",
  GALLEY_UPSTREAM_HEADER,
]);

/** Response headers we must not pass back (we re-stream the decoded body). */
const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  // Defense-in-depth: a 3xx is already refused below, but never leak a redirect
  // target (internal hostname) even if one slips through on a non-3xx response.
  "location",
]);

function joinUrl(base: string, subpath: string, search: string): string {
  return base.replace(/\/+$/, "") + subpath + search;
}

/**
 * Parse a `Content-Length` header value STRICTLY per RFC 9110 (#22.2 SEC-22.2-WEB-1).
 * Returns the byte count, or `null` for any value that is not a single run of
 * ASCII digits (after an optional surrounding-whitespace trim). This deliberately
 * rejects everything `Number()` would over-accept — `0x10`, `1e3`, `+5`, `-5`,
 * ` 5 ` with interior junk, the empty string, and a multi-value `"5, 5"` header
 * (Hono joins duplicates with a comma) — so a malformed declaration cannot slip
 * the size pre-check. A value over `Number.MAX_SAFE_INTEGER` still parses to a
 * finite number well above any realistic cap, so the caller's `> maxBodyBytes`
 * comparison rejects it; we cap the digit length to avoid pathological bignums.
 */
export function parseContentLength(raw: string): number | null {
  const trimmed = raw.trim();
  // Reject empty and over-long digit strings (a 64-bit byte count is ≤ 20 digits;
  // anything longer is hostile/nonsensical — fail closed).
  if (trimmed.length === 0 || trimmed.length > 20) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the proxy as a Hono app. Forwards `POST|GET /forward/*` to the selected
 * upstream, preserving the API path after `/forward`.
 */
export function createProxyHandler(
  upstreams: Map<string, UpstreamConfig>,
  options: ProxyOptions,
): Hono {
  const app = new Hono();
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  // Empty/whitespace token = no gate (treated as unset), so a blank env var can't
  // silently lock everyone out OR accept an empty bearer.
  const accessToken = options.accessToken?.trim() || undefined;

  app.use(
    "*",
    cors({
      origin: (origin) => (options.allowedOrigins.includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["content-type", "accept", GALLEY_UPSTREAM_HEADER],
      maxAge: 600,
    }),
  );

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.all("/forward/*", async (c) => {
    // Defense-in-depth shared-secret gate (opt-in). Checked BEFORE the upstream
    // key is ever injected, so a forgotten edge-auth annotation fails closed.
    if (accessToken) {
      const auth = c.req.header("authorization") ?? "";
      const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
      if (!presented || !safeEqual(presented, accessToken)) {
        return c.json({ error: "unauthorized" }, 401);
      }
    }

    const id = c.req.header(GALLEY_UPSTREAM_HEADER)?.toLowerCase();
    const upstream = id ? upstreams.get(id) : undefined;
    if (!upstream) {
      // Unknown id (or a client-supplied URL masquerading as one) → refuse.
      return c.json({ error: "unknown upstream" }, 400);
    }

    const reqUrl = new URL(c.req.url);
    const subpath = reqUrl.pathname.slice("/forward".length);
    const target = joinUrl(upstream.url, subpath, reqUrl.search);

    const headers = new Headers();
    c.req.raw.headers.forEach((v, k) => {
      if (!STRIP_REQUEST_HEADERS.has(k.toLowerCase())) headers.set(k, v);
    });
    headers.set(upstream.authHeader, upstream.key); // inject key server-side

    const method = c.req.method;
    const hasBody = method !== "GET" && method !== "HEAD";

    // Resource-limit defense-in-depth (#22.2): reject an over-cap body. First a
    // cheap Content-Length pre-check — refuse BEFORE opening the upstream socket
    // when the client declares an oversized body. Then, for chunked / length-less
    // uploads, wrap the stream so it aborts the moment it crosses the cap. Either
    // way the client gets a clean 413, never a hang or an OOM.
    if (hasBody) {
      const declared = c.req.header("content-length");
      if (declared !== undefined) {
        // #22.2 SEC-22.2-WEB-1: parse Content-Length STRICTLY per HTTP. `Number()`
        // is lenient (accepts `0x..`, `1e3`, leading/trailing space, `+5`, ``),
        // which could let a malformed declaration slip the pre-check. Accept ONLY
        // a run of ASCII digits (one optional surrounding-whitespace trim). A
        // syntactically-invalid / multi-value CL is rejected 400 here; the
        // streaming byte-counter below still fails-closed regardless.
        const parsed = parseContentLength(declared);
        if (parsed === null) {
          return c.json({ error: "invalid content-length" }, 400);
        }
        if (parsed > maxBodyBytes) {
          return c.json({ error: "request body too large" }, 413);
        }
      }
    }

    let body: ReadableStream<Uint8Array> | null = null;
    let overCap = false;
    if (hasBody && c.req.raw.body) {
      // The capped stream errors when cumulative bytes exceed the cap; that error
      // surfaces as a fetch rejection, which we map to 413 (not 502) via the flag.
      const raw = c.req.raw.body as ReadableStream<Uint8Array>;
      const cap = maxBodyBytes;
      let seen = 0;
      body = raw.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            seen += chunk.byteLength;
            if (seen > cap) {
              overCap = true;
              controller.error(new Error("request body exceeds the configured limit"));
              return;
            }
            controller.enqueue(chunk);
          },
        }),
      );
    }

    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(target, {
        method,
        headers,
        ...(hasBody && body ? { body, duplex: "half" } : {}),
        redirect: "manual",
      } as RequestInit);
    } catch {
      // An over-cap streamed body aborted the fetch → 413; anything else → 502.
      // Never include the body or key in the error.
      if (overCap) return c.json({ error: "request body too large" }, 413);
      return c.json({ error: "upstream request failed" }, 502);
    }

    // Model APIs never legitimately redirect. With `redirect: "manual"` an
    // upstream 3xx surfaces here verbatim; forwarding its `Location` would leak
    // an internal hostname to the client (and could drive an open-redirect). Fail
    // closed: refuse any 3xx outright rather than relay it.
    if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
      return c.json({ error: "upstream redirect not supported" }, 502);
    }

    const resHeaders = new Headers();
    upstreamRes.headers.forEach((v, k) => {
      if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) resHeaders.set(k, v);
    });
    // Stream the body through unbuffered.
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: resHeaders,
    });
  });

  return app;
}
