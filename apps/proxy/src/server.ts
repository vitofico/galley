/**
 * Node entry point for @galley/proxy. Reads config from the environment and
 * starts the Hono app on PORT. Kept separate from index.ts so the handler stays
 * unit-testable (via `app.request`) without binding a socket.
 */

import { Server as HttpServer } from "node:http";
import { serve } from "@hono/node-server";
import { createProxyHandler, loadUpstreams } from "./index.js";

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`PORT must be an integer 0-65535; got ${JSON.stringify(process.env.PORT)}`);
}
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const upstreams = loadUpstreams(process.env);
// Optional defense-in-depth bearer gate (fails closed if an exposed deployment
// forgets its edge auth). Unset/blank → no gate (default localhost-only posture).
const accessToken = process.env.PROXY_ACCESS_TOKEN?.trim() || undefined;
const app = createProxyHandler(upstreams, {
  allowedOrigins,
  ...(accessToken ? { accessToken } : {}),
});

// Warn (don't throw — the proxy is opt-in) when a configured upstream has no key:
// it would forward an empty Authorization header and the upstream would 401. List
// only the ids (never the key value).
const upstreamsMissingKey = [...upstreams.values()].filter((u) => u.key === "").map((u) => u.id);
if (upstreamsMissingKey.length > 0) {
  console.warn(
    `@galley/proxy: upstream(s) configured without a key (will fail auth upstream): [${upstreamsMissingKey.join(", ")}]`,
  );
}

// Log only non-sensitive startup facts: never keys, never request bodies.
console.log(
  `@galley/proxy listening on :${port} — upstreams: [${[...upstreams.keys()].join(", ")}], origins: [${allowedOrigins.join(", ")}], bearer-gate: ${accessToken ? "on" : "off"}`,
);

const server = serve({ fetch: app.fetch, port });

// Resource-limit hardening (#22.2 defense-in-depth, slow-loris): bound how long a
// single connection may take to deliver its request. `@hono/node-server` returns
// the underlying Node `http.Server`, so we set the timeouts on it directly. These
// are GENEROUS ceilings — a normal request (even a large model-API forward)
// completes well inside them; only a slow-trickle / never-finishing connection is
// dropped. `headersTimeout` < `requestTimeout` so the header phase is bounded
// first. The timeouts apply to the inbound REQUEST phase; Node's `requestTimeout`
// does not clock the upstream's long-lived streaming RESPONSE we relay back.
const HEADERS_TIMEOUT_MS = 30_000; // slow-loris: full request headers must arrive within 30s
const REQUEST_TIMEOUT_MS = 60_000; // whole request (incl. body upload) must arrive within 60s
// `serve()` returns a plain HTTP `http.Server` here (no http2 serverOptions); the
// instanceof narrows the `ServerType` union so the timeout setters typecheck.
if (server instanceof HttpServer) {
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
}

// Graceful shutdown on SIGTERM/SIGINT (k8s / `docker stop`): drain in-flight
// requests then exit; safety timeout forces exit if close hangs.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    setTimeout(() => process.exit(0), 10_000).unref();
    server.close(() => process.exit(0));
  });
}
