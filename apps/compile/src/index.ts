/**
 * @galley/compile — the optional server-side Typst compile service (ADR-0015).
 *
 * A thin Hono app: `POST /compile` runs one operation (check/render/export) over
 * one `CompileInput` against an injected backend (the Node `TypstEngine`), and
 * returns the same result shapes the in-browser worker produces — so the browser
 * can swap a `RemoteCompilerClient` for its Web Worker behind the SAME `Compiler`
 * interface (slice 2). PDF bytes are base64-encoded on the way out.
 *
 * The backend is INJECTED so the handler is unit-testable with a fake. Request
 * validation here is the first line of defense; size/resource caps (CompileLimits)
 * and an in-flight CONCURRENCY cap (maxConcurrentCompiles → 503 Retry-After when
 * full) bound memory/CPU. Killing a runaway WASM compile is a separate concern
 * handled by the isolated worker-thread backend.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bytesToBase64 } from "@galley/compiler";
import { isProjectInput } from "@galley/shared";
import { CompileUnavailableError } from "./isolated-backend.js";
import type {
  CheckResult,
  CompileInput,
  CompileServiceRequest,
  ExportResult,
  ExportResultWire,
  RenderResult,
} from "@galley/shared";

/** What the service needs from a compiler — the engine satisfies this structurally. */
export interface CompileBackend {
  check(input: CompileInput): Promise<CheckResult>;
  render(input: CompileInput): Promise<RenderResult>;
  export(input: CompileInput): Promise<ExportResult>;
}

/**
 * DoS guard: cap the size + shape of an untrusted compile request (ADR-0015 §4,
 * "build now: request/output caps"). These bound memory + parse cost; *killing* a
 * runaway WASM compile is a separate concern that needs worker-thread / container
 * isolation, deferred to deployment (see ADR-0015 + STATUS slice 4).
 */
export interface CompileLimits {
  /** Max raw request body bytes (rejected before JSON.parse). */
  maxRequestBytes: number;
  /** Max files in a ProjectInput. */
  maxFiles: number;
  /** Max bytes for any single file's text (and for a single-file source). */
  maxFileBytes: number;
  /** Max total source bytes across a project. */
  maxTotalBytes: number;
}

export const DEFAULT_COMPILE_LIMITS: CompileLimits = {
  maxRequestBytes: 8 * 1024 * 1024,
  maxFiles: 256,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
};

/**
 * Default ceiling on compiles running CONCURRENTLY (SEC: /compile DoS). Since the
 * 2026-07 flip the default backend is terminable worker isolation
 * (`GALLEY_COMPILE_ISOLATION` unset = worker); `inline` is the opt-out and is
 * required for registry packages (see server-config.ts). Under EITHER backend a
 * burst of slow documents exhausts memory and OOMKills the pod without a bound,
 * and under worker isolation each /compile additionally spins a fresh
 * worker_thread (V8 reuses the process-wide compiled WASM module, so this costs
 * a thread + module instantiate, ~1–2 ms over inline, not a fresh WASM compile).
 * ~2–4 × replica CPU is the recommended range; 4 is a safe single-replica
 * default. Tune via `maxConcurrentCompiles`.
 */
export const DEFAULT_MAX_CONCURRENT_COMPILES = 4;

/**
 * Parse the `GALLEY_COMPILE_MAX_CONCURRENCY` env var into a concurrency cap, or
 * `undefined` when unset (caller then uses `DEFAULT_MAX_CONCURRENT_COMPILES`).
 *
 * THROWS on an invalid value rather than falling through to the default — a
 * silent fallthrough on a typo (`"4 "`, `"four"`, `"0"`) would hide a
 * misconfigured cap. Mirrors `parseIsolationTimeoutMs`: a clean positive integer
 * only, failing loud at startup.
 */
export function parseMaxConcurrentCompiles(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const trimmed = raw.trim();
  const n = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `GALLEY_COMPILE_MAX_CONCURRENCY must be a positive integer; got "${raw}"`,
    );
  }
  return n;
}

export interface CompileAppOptions {
  backend: CompileBackend;
  /** Browser origins allowed by CORS (the web app). Empty = same-origin only. */
  allowedOrigins?: string[];
  /** Request size/shape caps (defaults to `DEFAULT_COMPILE_LIMITS`). */
  limits?: Partial<CompileLimits>;
  /**
   * Backend READINESS probe for `/readyz` (L7-OPS4): resolves `true` when the
   * backend can complete a compile, `false` when it can't. Distinct from
   * `/healthz` (process liveness). When omitted, `/readyz` reports ready (the
   * unit harness and any deployment that doesn't wire a probe are unchanged).
   * Wire `createCachedReadiness(backend)` in production.
   */
  checkReadiness?: () => Promise<boolean>;
  /**
   * Max compiles allowed to run CONCURRENTLY before the service sheds load with
   * `503 Retry-After` (SEC: /compile DoS). Defaults to
   * `DEFAULT_MAX_CONCURRENT_COMPILES`. Set ~2–4 × the replica's CPU count.
   */
  maxConcurrentCompiles?: number;
}

/**
 * A cached backend-readiness probe for `/readyz` (L7-OPS4). It runs a SYNTHETIC
 * trivial compile (a `check` of an empty document) at most once per `ttlMs` and
 * caches the verdict.
 *
 * Why synthetic + cached, not "deepen /healthz":
 *   - Probing with OUR OWN trivial input (never a user's document) means one
 *     user's runaway/huge compile can't flip readiness — exactly the failure
 *     mode that got the earlier "/healthz reflects backend health" attempt
 *     reverted (a single bad input must not report the process dead).
 *   - A wedged/faulted backend surfaces as the probe REJECTING (the isolated
 *     backend maps a per-compile timeout to `CompileUnavailableError`) or the
 *     soft `timeoutMs` firing → `ready:false` → the HTTP layer returns 503.
 *   - The TTL bounds probe cost (one trivial compile per window) so a tight
 *     k8s `periodSeconds` can't storm the backend.
 *
 * `/healthz` stays pure liveness; `/readyz` is the readiness signal an
 * orchestrator/load-balancer should gate traffic on.
 */
export function createCachedReadiness(
  backend: CompileBackend,
  opts: { ttlMs?: number; timeoutMs?: number } = {},
): () => Promise<boolean> {
  const ttlMs = opts.ttlMs ?? 5_000;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  let cached: { at: number; ready: boolean } | null = null;
  let inflight: Promise<boolean> | null = null;

  const probe = async (): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`readiness probe timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      });
      // The probe input is a fixed empty source — never user-controlled. Success
      // = the backend completed a compile (diagnostics don't matter); a throw =
      // the backend is unavailable.
      await Promise.race([backend.check(""), timeout]);
      return true;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return async () => {
    const now = Date.now();
    if (cached && now - cached.at < ttlMs) return cached.ready;
    // Coalesce concurrent callers onto a single in-flight probe.
    if (!inflight) {
      inflight = probe().then((ready) => {
        cached = { at: Date.now(), ready };
        inflight = null;
        return ready;
      });
    }
    return inflight;
  };
}

const OPS = new Set(["check", "render", "export"]);
const utf8 = new TextEncoder();

/** Validate an untrusted request body into a CompileServiceRequest, or return a reason. */
function parseRequest(body: unknown): { req: CompileServiceRequest } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be a JSON object" };
  const { op, input } = body as Record<string, unknown>;
  if (typeof op !== "string" || !OPS.has(op)) return { error: "op must be one of check|render|export" };
  if (typeof input === "string") {
    return { req: { op: op as CompileServiceRequest["op"], input } };
  }
  // Only treat `input` as a possible ProjectInput when it is a plain object:
  // `isProjectInput` dereferences fields, so passing null / a number / an array
  // (e.g. {op:"check",input:null}) would throw a TypeError. Guard the shape here
  // so anything that isn't a string or a non-array object yields the clean 400
  // below instead of an unhandled 500.
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    if (isProjectInput(input as CompileInput)) {
      return { req: { op: op as CompileServiceRequest["op"], input: input as CompileInput } };
    }
  }
  return { error: "input must be a source string or a ProjectInput" };
}

/** Enforce per-input size caps. Returns an error reason, or null if within caps. */
function checkInputLimits(input: CompileInput, limits: CompileLimits): string | null {
  if (typeof input === "string") {
    if (utf8.encode(input).length > limits.maxFileBytes) return "source exceeds size cap";
    return null;
  }
  if (input.files.length > limits.maxFiles) return "too many files";
  let total = 0;
  for (const f of input.files) {
    const bytes = utf8.encode(f.text).length;
    if (bytes > limits.maxFileBytes) return `file ${f.path} exceeds size cap`;
    total += bytes;
    if (total > limits.maxTotalBytes) return "project exceeds total size cap";
  }
  return null;
}

export function createCompileApp(options: CompileAppOptions): Hono {
  const { backend, allowedOrigins = [], checkReadiness } = options;
  const limits: CompileLimits = { ...DEFAULT_COMPILE_LIMITS, ...options.limits };
  const maxConcurrent = Math.max(1, options.maxConcurrentCompiles ?? DEFAULT_MAX_CONCURRENT_COMPILES);
  // In-flight compile counter for the concurrency cap (SEC: /compile DoS). The
  // check-then-increment below has no `await` between the test and the bump, so
  // it is atomic on the single JS thread — no lock needed.
  let inFlight = 0;
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: ["content-type"],
      maxAge: 600,
    }),
  );

  // /healthz is a process-LIVENESS probe: 200 while the server is up and able to
  // answer, independent of whether any single compile is failing. (A killed
  // runaway compile returns 503 on /compile but must NOT make the service report
  // itself dead — see isolated-backend.test.ts.) A backend-READINESS probe that
  // reflects compile health belongs on a separate /readyz endpoint — see the
  // production-readiness audit's L7-OPS4 follow-up; deepening /healthz conflates
  // liveness with readiness and would flap a healthy process on one bad input.
  app.get("/healthz", (c) => c.json({ ok: true }));

  // /readyz is the backend-READINESS probe (L7-OPS4): it reflects whether the
  // backend can actually complete a compile, via a cached synthetic probe (see
  // createCachedReadiness). 503 when not ready so an orchestrator/load-balancer
  // stops routing traffic, while /healthz keeps the pod alive. With no probe
  // wired, it reports ready (contract-preserving default).
  app.get("/readyz", async (c) => {
    if (!checkReadiness) return c.json({ ready: true });
    const ready = await checkReadiness();
    return ready ? c.json({ ready: true }) : c.json({ ready: false }, 503);
  });

  app.post("/compile", async (c) => {
    // Cap the raw body BEFORE parsing, so a huge payload can't exhaust memory.
    let raw: string;
    try {
      raw = await c.req.text();
    } catch {
      return c.json({ error: "could not read body" }, 400);
    }
    if (utf8.encode(raw).length > limits.maxRequestBytes) {
      return c.json({ error: "request too large" }, 413);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const parsed = parseRequest(body);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);

    const { op, input } = parsed.req;
    const limitError = checkInputLimits(input, limits);
    if (limitError) return c.json({ error: limitError }, 413);

    // Concurrency cap (SEC: /compile DoS). Every compile does WASM work — in a
    // fresh worker_thread under the default backend (worker isolation), or inline
    // on the event loop when `GALLEY_COMPILE_ISOLATION=inline` is set. Without a
    // bound, a burst of slow documents exhausts memory and OOMKills the pod either
    // way. Shed load EARLY — reject with 503 +
    // Retry-After rather than queue unboundedly (a queue is itself a memory
    // sink). This mirrors the CompileUnavailableError→503 retry contract, so an
    // existing client already knows to back off and retry. Acquire the slot only
    // after the cheap validation above so a malformed request never holds one.
    if (inFlight >= maxConcurrent) {
      c.header("Retry-After", "1");
      return c.json({ error: "server busy" }, 503);
    }
    inFlight++;
    try {
      if (op === "check") return c.json(await backend.check(input));
      if (op === "render") return c.json(await backend.render(input));
      const result = await backend.export(input);
      const wire: ExportResultWire = {
        ok: result.ok,
        diagnostics: result.diagnostics,
        pdfBase64: result.pdf === null ? null : bytesToBase64(result.pdf),
      };
      return c.json(wire);
    } catch (err) {
      // A killed/faulted isolated worker (timeout or thread crash) is an
      // availability failure, not a bad document → 503 so clients can retry while
      // the service stays up. Everything else is an opaque 500 (never leak the
      // document body or a stack into the response).
      if (err instanceof CompileUnavailableError) {
        return c.json({ error: "compile unavailable" }, 503);
      }
      return c.json({ error: "compile failed" }, 500);
    } finally {
      // Release the slot whether the compile resolved, threw, or the worker was
      // killed — otherwise a faulting backend would permanently leak capacity.
      inFlight--;
    }
  });

  return app;
}
