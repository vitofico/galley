/**
 * Main-thread side of the compiler: correlates request/response by job id and
 * supports cancellation of stale jobs (the live preview supersedes in-flight
 * compiles). The Worker is injected as a `WorkerTransport`, so the full
 * round-trip is node-testable with a simulated in-process worker.
 */

import type { CheckResult, CompileInput, ExportResult, RenderResult } from "@galley/shared";
import type { CompileRequest, WorkerRequest, WorkerResponse } from "./worker-protocol.js";

/**
 * The public compiler handle (docs/compiler.md). Each method takes a
 * `CompileInput` — a bare source `string` (single-file, unchanged) or a
 * `ProjectInput` (multi-file, roadmap #2).
 */
export interface Compiler {
  check(input: CompileInput): Promise<CheckResult>;
  /**
   * Render the input to preview SVG. `opts.sourceMap` (#11.3, default off) opts
   * into the best-effort forward source→preview index on the result. ADDITIVE +
   * optional: the historical 1-arg `render(input)` call is unchanged, and an
   * implementation that ignores `opts` (e.g. {@link RemoteCompilerClient}) still
   * satisfies the type — preview-sync just degrades gracefully (no map) there.
   */
  render(input: CompileInput, opts?: { sourceMap?: boolean }): Promise<RenderResult>;
  export(input: CompileInput): Promise<ExportResult>;
  /** Cancel any in-flight job (stale preview, aborted agent run). */
  cancel(): void;
  /** Tear down the worker. */
  dispose(): void;
}

export interface WorkerTransport {
  post(message: WorkerRequest): void;
  onMessage(handler: (message: WorkerResponse) => void): void;
  terminate(): void;
}

export class CompileCancelledError extends Error {
  constructor() {
    super("compile cancelled");
    this.name = "CompileCancelledError";
  }
}

export class CompileTimeoutError extends Error {
  constructor(ms: number) {
    super(`compile timed out after ${ms}ms`);
    this.name = "CompileTimeoutError";
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface CompilerClientOptions {
  /**
   * Per-job timeout. A compile that exceeds it rejects with
   * `CompileTimeoutError` so the caller never hangs. 0 disables it.
   */
  timeoutMs?: number;
  /**
   * Worker-factory seam. When provided, a timed-out (or cancel-abandoned) job
   * leaves the worker running a stuck sync compile — a JS timeout can't preempt
   * it — so the client `terminate()`s that wedged worker and spins a fresh one
   * via this factory. The next compile then starts clean instead of queueing
   * behind the wedged job. Each call must return a brand-new, ready transport.
   *
   * Omitted (the default) keeps the legacy single-transport behavior exactly:
   * the injected `transport` is never torn down or replaced by the client.
   */
  createTransport?: () => WorkerTransport;
  /**
   * Whether a normal superseded `cancel()` (with an in-flight job) respawns the
   * worker. Default false: the live preview supersedes in-flight compiles on
   * every edit, so respawning here would terminate + reload WASM on every
   * keystroke on large docs — a severe regression. The TIMEOUT path still
   * respawns a genuinely wedged worker regardless of this flag.
   */
  respawnOnCancel?: boolean;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class CompilerClient implements Compiler {
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly timeoutMs: number;
  private readonly createTransport: (() => WorkerTransport) | undefined;
  private readonly respawnOnCancel: boolean;
  /** The live worker. Replaced wholesale on respawn (factory mode only). */
  private transport: WorkerTransport;
  /** Once disposed, no further respawns (dispose tears the worker down for good). */
  private disposed = false;

  constructor(transport: WorkerTransport, options: CompilerClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.createTransport = options.createTransport;
    this.respawnOnCancel = options.respawnOnCancel ?? false;
    this.transport = transport;
    transport.onMessage((msg) => this.receive(msg));
  }

  /**
   * Terminate the wedged worker and bind a fresh one (factory mode only). Caller
   * must have already settled all pending jobs — the new worker starts with an
   * empty correlation map, so any late message from the dead worker is dropped.
   */
  private respawn(): void {
    if (!this.createTransport || this.disposed) return;
    this.transport.terminate();
    this.transport = this.createTransport();
    this.transport.onMessage((msg) => this.receive(msg));
  }

  private settle(jobId: number): Pending | undefined {
    const p = this.pending.get(jobId);
    if (!p) return undefined;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(jobId);
    return p;
  }

  private receive(msg: WorkerResponse): void {
    if (msg.type === "ready" || msg.type === "init_error") return;
    const p = this.settle(msg.jobId);
    if (!p) return; // superseded, cancelled, or already timed out — ignore
    if (msg.type === "error") p.reject(new Error(msg.message));
    else p.resolve(msg.result);
  }

  private submit<T>(make: (jobId: number) => CompileRequest): Promise<T> {
    const jobId = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve: resolve as (v: unknown) => void, reject };
      if (this.timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          // Still pending? (Not already settled by a result/cancel/sibling drain.)
          if (!this.pending.has(jobId)) return;
          if (this.createTransport) {
            // The worker is wedged on a sync WASM compile a `cancel` can't
            // preempt. Terminating it aborts EVERY job running on it — so drain
            // all pending entries (clearing their now-defunct timers so a stale
            // one can't later terminate the fresh worker), then respawn once. The
            // timed-out job rejects with CompileTimeoutError; its siblings were
            // aborted by the teardown, so they reject with CompileCancelledError.
            this.settle(jobId);
            for (const [otherId, other] of this.pending) {
              if (other.timer) clearTimeout(other.timer);
              this.pending.delete(otherId);
              other.reject(new CompileCancelledError());
            }
            this.respawn();
            reject(new CompileTimeoutError(this.timeoutMs));
          } else if (this.settle(jobId)) {
            // No factory: best-effort cancel, single worker kept.
            this.transport.post({ type: "cancel", jobId });
            reject(new CompileTimeoutError(this.timeoutMs));
          }
        }, this.timeoutMs);
      }
      this.pending.set(jobId, entry);
      this.transport.post(make(jobId));
    });
  }

  check(input: CompileInput): Promise<CheckResult> {
    return this.submit((jobId) => ({ type: "check", jobId, input }));
  }
  render(input: CompileInput, opts?: { sourceMap?: boolean }): Promise<RenderResult> {
    // Forward the optional #11.3 flag via conditional spread so the message OMITS
    // the key (never `sourceMap: undefined`) when not requested — keeping the
    // historical render message shape byte-for-byte (exactOptionalPropertyTypes).
    return this.submit((jobId) => ({
      type: "render",
      jobId,
      input,
      ...(opts?.sourceMap ? { sourceMap: true } : {}),
    }));
  }
  export(input: CompileInput): Promise<ExportResult> {
    return this.submit((jobId) => ({ type: "export", jobId, input }));
  }

  cancel(): void {
    const hadInFlight = this.pending.size > 0;
    for (const [jobId, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      this.transport.post({ type: "cancel", jobId });
      p.reject(new CompileCancelledError());
    }
    this.pending.clear();
    // An abandoned job may have left the worker mid-compile (a stale preview the
    // user superseded). With a factory AND opt-in, respawn so the wedged job
    // can't queue ahead of the next compile; by default (live preview) we keep
    // the worker so a normal supersede doesn't churn it / reload WASM. The
    // timeout path always respawns a genuinely wedged worker regardless.
    if (hadInFlight && this.createTransport && this.respawnOnCancel) this.respawn();
  }

  dispose(): void {
    // Set first so cancel()'s respawn is a no-op — we kill the worker for good.
    this.disposed = true;
    this.cancel();
    this.transport.terminate();
  }
}
