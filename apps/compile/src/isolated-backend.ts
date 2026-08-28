/**
 * Terminable compile isolation (ADR-0015 §4, STATUS slice 4) — the DEFAULT
 * backend since the 2026-07 flip (`GALLEY_COMPILE_ISOLATION` unset = worker;
 * `inline` is the opt-out).
 *
 * The alternative INLINE backend runs the WASM compile on the event loop: a
 * runaway / infinite Typst compile wedges the whole service, and a JS
 * `setTimeout` can't preempt synchronous WASM. This backend instead runs each
 * compile in a terminable Node `worker_thread` guarded by a hard per-compile
 * timeout. On timeout the thread is `terminate()`d (the only thing that can stop
 * wedged sync WASM) and the request fails with `CompileUnavailableError`, which
 * the HTTP layer maps to 503 — the service itself stays alive.
 *
 * The worker is INJECTED via `createWorker` so the timeout+terminate mechanism is
 * unit-testable with a fake slow/runaway worker (no real WASM-in-a-worker needed
 * to prove the kill). `realWorkerFactory()` provides the production worker_thread.
 *
 * A fresh worker is spun per compile: after a `terminate()` there is no clean way
 * to reuse a thread, and a per-request thread guarantees the next compile starts
 * from a pristine engine. This is cheap enough to be the default: V8 compiles the
 * WASM module ONCE per process and reuses it across threads, so a fresh worker
 * pays a thread spawn + module instantiate (~1–2 ms over inline in steady state),
 * NOT a full WASM compile. The one-time module compile (~106 ms) is paid once per
 * process; the first compile after a runaway kill re-instantiates but does not
 * recompile. A warm pool is a later optimization and orthogonal to the kill
 * mechanism proven here.
 */
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type {
  CheckResult,
  CompileInput,
  CompileOp,
  ExportResult,
  RenderResult,
} from "@galley/shared";
import type { CompileBackend } from "./index.js";

export type { CompileOp };

/** A job handed to the worker: one operation over one input, correlated by id. */
export interface IsolatedJob {
  jobId: number;
  op: CompileOp;
  input: CompileInput;
}

/** A worker's reply: a result, or a (compile-level) error message. */
export interface IsolatedReply {
  jobId: number;
  result?: unknown;
  error?: string;
}

/**
 * The terminable worker seam. A real Node `worker_thread` satisfies this; tests
 * inject a fake. `onError` fires on a thread-level fault (crash/uncaught), which
 * is an availability failure distinct from a compile-level `error` reply.
 */
export interface IsolatedWorker {
  post(job: IsolatedJob): void;
  onMessage(handler: (reply: IsolatedReply) => void): void;
  onError(handler: (err: Error) => void): void;
  terminate(): Promise<unknown>;
}

export interface IsolatedBackendOptions {
  /** Mint a fresh terminable worker. Called once per compile. */
  createWorker: () => IsolatedWorker;
  /** Hard per-compile timeout (ms). Exceeding it terminates the thread → 503. */
  timeoutMs?: number;
}

export const DEFAULT_ISOLATION_TIMEOUT_MS = 20_000;

/**
 * Parse the `GALLEY_COMPILE_TIMEOUT_MS` env var into a hard-timeout (ms), or
 * `undefined` when unset (caller then uses `DEFAULT_ISOLATION_TIMEOUT_MS`).
 *
 * THROWS on an invalid value — a silent fallthrough would disable the kill
 * (`Number.parseInt("bad") === NaN`, and `NaN > 0` is false → no timeout → a
 * runaway compile hangs the request and leaks a thread, defeating the flag). We
 * require an explicit positive integer so misconfiguration fails loud at startup.
 */
export function parseIsolationTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const trimmed = raw.trim();
  // Reject anything that isn't a plain base-10 integer (parseInt would swallow
  // trailing junk like "20s" or accept "1e3"); demand a clean positive integer.
  const n = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `GALLEY_COMPILE_TIMEOUT_MS must be a positive integer (ms); got "${raw}"`,
    );
  }
  return n;
}

/**
 * Why a compile could not be completed. Both map to 503, but they mean opposite
 * things operationally: `timeout` is the isolation mechanism WORKING (a runaway
 * document was killed, service healthy), while `fault` means the worker itself
 * could not run (entry unloadable, WASM init failed, thread crashed) — usually a
 * total outage, not a per-document problem.
 */
export type CompileUnavailableReason = "timeout" | "fault";

/**
 * Signals that a compile could not be completed because its isolated worker was
 * killed (timeout) or faulted — an availability failure, not a bad document. The
 * HTTP layer maps this to 503 so clients know to retry, while the service stays up.
 *
 * `reason` exists because a bare `instanceof CompileUnavailableError` CANNOT tell
 * a healthy load-shed from a permanently broken service — every compile failing
 * looks exactly like every compile timing out. That ambiguity is what let a
 * 503-on-every-compile bug ship unnoticed. Discriminate on `reason`, not on the
 * message text.
 */
export class CompileUnavailableError extends Error {
  readonly reason: CompileUnavailableReason;

  constructor(message: string, reason: CompileUnavailableReason) {
    super(message);
    this.name = "CompileUnavailableError";
    this.reason = reason;
  }
}

/**
 * Build a `CompileBackend` (drop-in for the inline engine) that runs each compile
 * in a terminable worker under a hard timeout.
 */
export function createIsolatedBackend(options: IsolatedBackendOptions): CompileBackend {
  const { createWorker } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ISOLATION_TIMEOUT_MS;
  // Defensive: a non-finite / non-positive / non-integer timeout would silently
  // disable the hard kill (a runaway compile would then hang + leak a thread,
  // defeating the whole point of isolation). Fail loud instead.
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `createIsolatedBackend: timeoutMs must be a positive integer (got ${String(options.timeoutMs)})`,
    );
  }
  let seq = 0;

  function run<T>(op: CompileOp, input: CompileInput): Promise<T> {
    const jobId = ++seq;
    const worker = createWorker();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
      };
      const kill = (): void => {
        // Best-effort: a terminate() rejection must not mask the real outcome.
        void Promise.resolve(worker.terminate()).catch(() => {});
      };

      worker.onMessage((reply) => {
        if (settled || reply.jobId !== jobId) return;
        settled = true;
        cleanup();
        // Reap the per-request worker once its single job is done so threads
        // don't accumulate. `kill()` (terminate) is the cleanup hook here, not a
        // kill — the job already finished cleanly.
        kill();
        if (reply.error !== undefined) reject(new Error(reply.error));
        else resolve(reply.result as T);
      });

      worker.onError((err) => {
        if (settled) return;
        settled = true;
        cleanup();
        kill();
        reject(new CompileUnavailableError(`compile worker faulted: ${err.message}`, "fault"));
      });

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          // The thread is wedged on sync WASM a JS cancel can't preempt: kill it.
          kill();
          reject(
            new CompileUnavailableError(
              `compile exceeded ${timeoutMs}ms; worker terminated`,
              "timeout",
            ),
          );
        }, timeoutMs);
      }

      worker.post({ jobId, op, input });
    });
  }

  return {
    check: (input) => run<CheckResult>("check", input),
    render: (input) => run<RenderResult>("render", input),
    export: (input) => run<ExportResult>("export", input),
  };
}

/**
 * Resolve the DEFAULT worker entry from THIS module's own execution mode.
 *
 * A worker thread does not inherit tsx's ESM loader hooks from its parent (and
 * `--import` in a worker's `execArgv` is ignored), so a thread spawned while the
 * service runs from TS source cannot load a `.ts` entry directly. The two modes
 * therefore need two different entries:
 *   - running from `.ts` (tsx — the runtime image and the k8s deploy): the
 *     `compile-worker-boot.mjs` bootstrap, which registers tsx INSIDE the thread
 *     and then imports `compile-worker.ts`.
 *   - running from `.js` (a `tsc` build): the sibling `compile-worker.js` directly.
 *
 * The choice is made from `import.meta.url`'s extension — the mode we are ALREADY
 * running in, known for certain — NOT by probing the filesystem or by trying one
 * entry and falling back to the other. A fallback would create two paths that
 * regress independently, and would have MASKED the bug this replaced: the default
 * used to resolve a sibling `./compile-worker.js` that does not exist next to
 * `compile-worker.ts`, so under tsx every compile faulted into
 * `CompileUnavailableError` → HTTP 503. Pinned by isolated-default-entry.test.ts.
 */
function defaultWorkerEntry(): URL {
  const fromTypeScriptSource = /\.m?ts$/.test(new URL(import.meta.url).pathname);
  return fromTypeScriptSource
    ? new URL("./compile-worker-boot.mjs", import.meta.url)
    : new URL("./compile-worker.js", import.meta.url);
}

/**
 * The production worker factory: a real Node `worker_thread` running
 * `compile-worker`. Kept out of the core so unit tests never spin a real thread.
 *
 * `workerUrl` overrides the entry (tests use it to drive a deliberately broken or
 * purpose-built entry). Production passes NOTHING — see `defaultWorkerEntry` for
 * how the zero-arg default is resolved, and note that ONLY the zero-arg call is
 * what the deploy exercises.
 */
export function realWorkerFactory(workerUrl?: URL): () => IsolatedWorker {
  const entry = workerUrl ?? defaultWorkerEntry();
  return () => {
    const worker = new Worker(fileURLToPath(entry));
    return {
      post: (job) => worker.postMessage(job),
      onMessage: (handler) => worker.on("message", handler),
      onError: (handler) => worker.on("error", handler),
      terminate: () => worker.terminate(),
    };
  };
}

/**
 * Raised when worker isolation is selected but a worker cannot actually run a
 * compile. Startup refuses on this — see `assertIsolatedBackendUsable`.
 */
export class WorkerInitializationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkerInitializationError";
  }
}

/**
 * Startup preflight for worker isolation: prove a worker can REALLY compile
 * before the service binds a port, and refuse to start if it cannot.
 *
 * WHY THIS IS A REAL COMPILE, not a `stat()` of the entry: the failure modes that
 * matter are loader, import, WASM-init and message-protocol failures — a
 * file-exists check passes while every one of them is fatal, and would NOT have
 * caught the bug that motivated this (the entry file was genuinely absent, but the
 * NEXT such break may be an entry that exists and cannot load). So this drives the
 * whole path end to end: resolve the default entry, spawn the thread, init real
 * WASM in it, exchange a job message, and reap the thread.
 *
 * WHY IT EXISTS AT ALL: without it a broken worker is invisible — every compile
 * 503s, which is indistinguishable from healthy load-shedding, so the service
 * looks "up but busy" forever. Failing at startup converts a silent permanent
 * outage into a loud refusal with a diagnosable message.
 *
 * The input is a fixed trivial document, never user-controlled.
 */
export async function assertIsolatedBackendUsable(backend: CompileBackend): Promise<void> {
  try {
    await backend.check("= preflight");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new WorkerInitializationError(
      "GALLEY_COMPILE_ISOLATION=worker is set but the compile worker cannot run a " +
        `compile, so every request would fail with 503; refusing to start. Cause: ${detail}`,
      { cause: err },
    );
  }
}
