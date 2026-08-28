/**
 * Node entry for the compile service. Binds `PORT` (default 3001) and stays up.
 *   pnpm --filter @galley/compile start
 *
 * Env:
 *   - `ALLOWED_ORIGINS` (comma-separated) — CORS allowlist for the web app.
 *   - `REGISTRY_BASE_URL` — opt in to Universe package resolution (off if unset).
 *   - `REGISTRY_INTEGRITY_FILE` — JSON `{ "@ns/name:version": { sha256, size } }`,
 *     REQUIRED when a base URL is set (fail closed — no hash, no fetch; ADR-0016).
 *   - `GALLEY_COMPILE_ISOLATION` — `worker` (the DEFAULT since 2026-07; unset =
 *     worker) runs each compile in a terminable worker_thread with a hard timeout,
 *     so a runaway compile returns 503 instead of wedging the service. Set
 *     `inline` to run WASM on the event loop (required for registry packages, see
 *     below). ANY other value THROWS at startup — a typo must never silently
 *     change isolation (see server-config.ts). `GALLEY_COMPILE_TIMEOUT_MS` tunes
 *     the hard timeout (default 20s). Worker isolation runs a real synthetic
 *     compile through a worker BEFORE binding the port and REFUSES to start if it
 *     fails — a worker that cannot run would otherwise 503 every request
 *     indefinitely, which is indistinguishable from healthy load-shedding (that
 *     ambiguity once hid a total outage).
 *     NOTE: worker isolation is incompatible with registry packages today (the
 *     per-request thread has no resolver holder); set `inline` when a registry is
 *     configured, or startup throws.
 *   - `GALLEY_COMPILE_MAX_CONCURRENCY` — max compiles running at once before the
 *     service sheds load with 503 Retry-After (default 4; set ~2–4 × replica CPU).
 *     An exposed compile endpoint should ALSO sit behind auth / an ingress
 *     rate-limit — this cap bounds the pod, not the spend.
 */
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import type { CompileBackend } from "./index.js";
import { createCachedReadiness, createCompileApp, parseMaxConcurrentCompiles } from "./index.js";
import { createNodeEngine } from "./engine.js";
import {
  assertIsolatedBackendUsable,
  createIsolatedBackend,
  parseIsolationTimeoutMs,
  realWorkerFactory,
} from "./isolated-backend.js";
import {
  MutablePackageResolver,
  createPackageAwareBackend,
  prewarmFromRegistry,
} from "./package-compile.js";
import { assertRegistryIsolationCompatible, resolveCompileIsolation } from "./server-config.js";
import type { IntegrityManifest } from "./registry-resolver.js";

const port = Number.parseInt(process.env.PORT ?? "3001", 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`PORT must be an integer 0-65535; got ${JSON.stringify(process.env.PORT)}`);
}
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Validate at startup so a typo'd cap fails loud rather than silently using the default.
const maxConcurrentCompiles = parseMaxConcurrentCompiles(process.env.GALLEY_COMPILE_MAX_CONCURRENCY);
// Resolve isolation at startup (mirrors the fail-loud validations above): unset =
// worker (the 2026-07 default), explicit worker/inline, ANY other value throws.
const compileIsolation = resolveCompileIsolation(process.env.GALLEY_COMPILE_ISOLATION);

async function buildBackend(): Promise<CompileBackend> {
  const baseUrl = process.env.REGISTRY_BASE_URL?.trim();
  // Fail loud if a registry is configured alongside worker isolation — the
  // per-request worker_thread has no package-resolver holder (unsupported today).
  assertRegistryIsolationCompatible(compileIsolation, baseUrl);

  if (compileIsolation === "worker") {
    // Validate at startup: an invalid value throws here rather than silently
    // disabling the hard timeout (which would let a runaway compile hang).
    const timeoutMs = parseIsolationTimeoutMs(process.env.GALLEY_COMPILE_TIMEOUT_MS);
    const backend = createIsolatedBackend({
      createWorker: realWorkerFactory(),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    // Prove a worker can really compile BEFORE we bind a port. A broken worker
    // otherwise 503s every request forever, which looks exactly like healthy
    // load-shedding — so it stays invisible. This throws → the .catch below logs
    // and exits non-zero, and the pod visibly fails to start instead.
    await assertIsolatedBackendUsable(backend);
    return backend;
  }

  // Inline isolation (WASM on the event loop). Registry packages resolve only on
  // this path.
  if (!baseUrl) {
    // No registry configured → packages fail closed (engine with no resolver).
    return createNodeEngine();
  }
  const integrityFile = process.env.REGISTRY_INTEGRITY_FILE?.trim();
  if (!integrityFile) {
    throw new Error("REGISTRY_BASE_URL is set but REGISTRY_INTEGRITY_FILE is missing (ADR-0016: no hash, no fetch)");
  }
  const integrity = JSON.parse(readFileSync(integrityFile, "utf8")) as IntegrityManifest;
  const holder = new MutablePackageResolver();
  const engine = await createNodeEngine(holder);
  return createPackageAwareBackend({
    engine,
    holder,
    prewarm: prewarmFromRegistry({ baseUrl, integrity }),
  });
}

buildBackend()
  .then((backend) => {
    // Wire the backend-readiness probe for /readyz (L7-OPS4). A cached synthetic
    // compile reflects real backend health without letting a user's bad input
    // flip readiness; /healthz stays liveness-only.
    const app = createCompileApp({
      backend,
      allowedOrigins,
      checkReadiness: createCachedReadiness(backend),
      ...(maxConcurrentCompiles !== undefined ? { maxConcurrentCompiles } : {}),
    });
    const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
    // eslint-disable-next-line no-console
    console.log(`[galley/compile] compile service listening on http://0.0.0.0:${port}`);

    // Graceful shutdown: stop accepting + drain in-flight requests before exit on
    // SIGTERM/SIGINT (k8s / `docker stop`). Safety timeout forces exit if close hangs.
    for (const sig of ["SIGTERM", "SIGINT"]) {
      // `once` so a second signal can't re-enter server.close() on an
      // already-closing server (ERR_SERVER_NOT_RUNNING fires the callback
      // synchronously, exiting early and bypassing the drain).
      process.once(sig, () => {
        setTimeout(() => process.exit(0), 10_000).unref();
        server.close(() => process.exit(0));
      });
    }
  })
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("[galley/compile] failed to start:", err);
    process.exit(1);
  });
