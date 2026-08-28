/**
 * `RemoteCompilerClient` — the `Compiler` interface (check/render/export/cancel)
 * implemented over HTTP against the optional `apps/compile` service (roadmap #3,
 * ADR-0015), instead of the in-browser Web Worker. The app chooses one behind the
 * `?serverCompile=1` flag; everything downstream (preview, agent loop, diff) is
 * unchanged because both satisfy the same `Compiler`.
 *
 * `fetch` is injected (defaults to the global), so the full round-trip — including
 * cancellation and timeout — is unit-testable offline with a fake fetch, no real
 * server. Cancellation aborts the in-flight HTTP request(s) via `AbortController`,
 * mirroring the worker client's stale-job cancellation.
 */

import type {
  CheckResult,
  CompileInput,
  CompileOp,
  ExportResult,
  ExportResultWire,
  RenderResult,
} from "@galley/shared";
import type { Compiler } from "./compiler-client.js";
import { CompileCancelledError, CompileTimeoutError } from "./compiler-client.js";
import { base64ToBytes } from "./base64.js";

export interface RemoteCompilerOptions {
  /** The compile service endpoint (a single POST handler). */
  url: string;
  /** Injectable fetch (tests pass a fake); defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout; a slow compile rejects with `CompileTimeoutError`. 0 disables. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class RemoteCompilerClient implements Compiler {
  private readonly url: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly inflight = new Set<AbortController>();

  constructor(options: RemoteCompilerOptions) {
    this.url = options.url;
    // Bind the default to globalThis: the browser's `fetch` throws "Illegal
    // invocation" if called as a method (`this` would be this client). An injected
    // fetch (tests) is used as-is.
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async post<T>(op: CompileOp, input: CompileInput): Promise<T> {
    const controller = new AbortController();
    this.inflight.add(controller);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (this.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeoutMs);
    }
    try {
      const res = await this.doFetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op, input }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`compile service responded ${res.status}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      // An abort surfaces as the fake/real fetch rejecting; map it to our errors.
      if (controller.signal.aborted) {
        throw timedOut ? new CompileTimeoutError(this.timeoutMs) : new CompileCancelledError();
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      this.inflight.delete(controller);
    }
  }

  check(input: CompileInput): Promise<CheckResult> {
    return this.post<CheckResult>("check", input);
  }

  render(input: CompileInput): Promise<RenderResult> {
    return this.post<RenderResult>("render", input);
  }

  async export(input: CompileInput): Promise<ExportResult> {
    const wire = await this.post<ExportResultWire>("export", input);
    return {
      ok: wire.ok,
      diagnostics: wire.diagnostics,
      pdf: wire.pdfBase64 === null ? null : base64ToBytes(wire.pdfBase64),
    };
  }

  cancel(): void {
    for (const controller of this.inflight) controller.abort();
    this.inflight.clear();
  }

  dispose(): void {
    this.cancel();
  }
}
