/**
 * Terminable isolation for runaway compiles (ADR-0015 §4 / STATUS slice 4), the
 * DEFAULT backend since the 2026-07 flip. Under the `inline` opt-out the real
 * WASM compile runs on the event loop, so an infinite Typst compile wedges the
 * whole service and a JS timeout can't preempt sync WASM. The isolated backend
 * instead runs each compile in a terminable `worker_thread` with a hard
 * per-compile timeout; on timeout the thread is `terminate()`d and the request
 * fails with `CompileUnavailableError` (-> HTTP 503), service stays alive.
 *
 * These tests inject a FAKE worker (a controllable in-process double) so the
 * timeout+terminate mechanism is proven deterministically, WITHOUT real
 * WASM-in-a-worker. NOTE the scope: the real-engine HTTP tests
 * (compile-server.test.ts) drive the INLINE engine, so they do not cover the
 * worker either. Real `compile-worker`-in-a-real-thread on the real WASM engine
 * is covered by isolated-real-worker.test.ts.
 */
import { describe, it, expect } from "vitest";
import type { CheckResult } from "@galley/shared";
import { createCompileApp } from "./index.js";
import {
  createIsolatedBackend,
  parseIsolationTimeoutMs,
  CompileUnavailableError,
  type IsolatedWorker,
} from "./isolated-backend.js";

const okCheck: CheckResult = { ok: true, diagnostics: [], pageCount: 1, durationMs: 0 };

/**
 * A fake terminable worker. `mode` decides what it does with a posted job:
 *   - "resolve": reply with a successful result on the next tick.
 *   - "error": reply with an error message.
 *   - "hang": never reply (a runaway compile) — only `terminate()` stops it.
 */
function makeFakeWorker(mode: "resolve" | "error" | "hang") {
  let onMsg: ((m: { jobId: number; result?: unknown; error?: string }) => void) | null = null;
  let onErr: ((e: Error) => void) | null = null;
  const rec = {
    terminated: false,
    posted: [] as Array<{ jobId: number }>,
    worker: null as unknown as IsolatedWorker,
  };
  rec.worker = {
    post(msg: { jobId: number }) {
      rec.posted.push(msg);
      if (mode === "resolve") {
        queueMicrotask(() => onMsg?.({ jobId: msg.jobId, result: okCheck }));
      } else if (mode === "error") {
        queueMicrotask(() => onMsg?.({ jobId: msg.jobId, error: "boom in worker" }));
      }
      // "hang": deliberately never replies.
    },
    onMessage(cb) {
      onMsg = cb as typeof onMsg;
    },
    onError(cb) {
      onErr = cb;
    },
    async terminate() {
      rec.terminated = true;
    },
  };
  return rec;
}

describe("createIsolatedBackend: timeout + terminate", () => {
  it("terminates a runaway compile and throws CompileUnavailableError", async () => {
    const fake = makeFakeWorker("hang");
    const backend = createIsolatedBackend({
      createWorker: () => fake.worker,
      timeoutMs: 20,
    });
    await expect(backend.check("= Hi")).rejects.toBeInstanceOf(CompileUnavailableError);
    expect(fake.terminated).toBe(true);
  });

  it("stays alive after a timeout: the next compile uses a fresh worker", async () => {
    const workers: ReturnType<typeof makeFakeWorker>[] = [];
    const modes: Array<"hang" | "resolve"> = ["hang", "resolve"];
    const backend = createIsolatedBackend({
      createWorker: () => {
        const f = makeFakeWorker(modes[workers.length] ?? "resolve");
        workers.push(f);
        return f.worker;
      },
      timeoutMs: 20,
    });

    await expect(backend.check("= Hi")).rejects.toBeInstanceOf(CompileUnavailableError);
    // Service survives; a fresh worker handles the next request fine.
    const res = await backend.check("= Again");
    expect(res.ok).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[0]!.terminated).toBe(true);
  });

  it("returns a normal result for a fast compile and reaps its worker", async () => {
    const fake = makeFakeWorker("resolve");
    const backend = createIsolatedBackend({ createWorker: () => fake.worker, timeoutMs: 1000 });
    const res = await backend.check("= Hi");
    expect(res.ok).toBe(true);
    // Exactly one job posted, and the per-request worker is reaped afterward so
    // threads don't accumulate (terminate is the cleanup hook, not just the kill).
    expect(fake.posted).toHaveLength(1);
    expect(fake.terminated).toBe(true);
  });

  it("propagates a worker-reported compile error (not a 503)", async () => {
    const fake = makeFakeWorker("error");
    const backend = createIsolatedBackend({ createWorker: () => fake.worker, timeoutMs: 1000 });
    await expect(backend.check("= Hi")).rejects.toThrow("boom in worker");
    // A genuine compile error is NOT an availability failure.
    await expect(backend.check("= Hi")).rejects.not.toBeInstanceOf(CompileUnavailableError);
  });

  it("routes render and export through the worker too", async () => {
    const calls: string[] = [];
    let onMsg: ((m: { jobId: number; result: unknown }) => void) | null = null;
    const worker: IsolatedWorker = {
      post(msg: { jobId: number; op?: string }) {
        calls.push(msg.op ?? "?");
        queueMicrotask(() => onMsg?.({ jobId: msg.jobId, result: { ok: true, diagnostics: [] } }));
      },
      onMessage(cb) {
        onMsg = cb as typeof onMsg;
      },
      onError() {},
      async terminate() {},
    };
    const backend = createIsolatedBackend({ createWorker: () => worker, timeoutMs: 1000 });
    await backend.render("= Hi");
    await backend.export("= Hi");
    expect(calls).toEqual(["render", "export"]);
  });

  it("maps CompileUnavailableError to HTTP 503 (service stays up)", async () => {
    // A backend whose worker always times out: every compile is "unavailable".
    const backend = createIsolatedBackend({
      createWorker: () => makeFakeWorker("hang").worker,
      timeoutMs: 10,
    });
    const app = createCompileApp({ backend });
    const res = await app.request("/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "check", input: "= Hi" }),
    });
    expect(res.status).toBe(503);
    // The process is still alive — a normal liveness probe still answers.
    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
  });

  it("rejects with CompileUnavailableError if the worker thread crashes", async () => {
    let onErr: ((e: Error) => void) | null = null;
    let terminated = false;
    const worker: IsolatedWorker = {
      post() {
        queueMicrotask(() => onErr?.(new Error("thread died")));
      },
      onMessage() {},
      onError(cb) {
        onErr = cb;
      },
      async terminate() {
        terminated = true;
      },
    };
    const backend = createIsolatedBackend({ createWorker: () => worker, timeoutMs: 1000 });
    await expect(backend.check("= Hi")).rejects.toBeInstanceOf(CompileUnavailableError);
    expect(terminated).toBe(true);
  });
});

describe("timeout config validation (no silent no-timeout)", () => {
  const noopWorker = (): IsolatedWorker => ({
    post() {},
    onMessage() {},
    onError() {},
    async terminate() {},
  });

  it("parseIsolationTimeoutMs returns undefined when unset/blank", () => {
    expect(parseIsolationTimeoutMs(undefined)).toBeUndefined();
    expect(parseIsolationTimeoutMs("")).toBeUndefined();
    expect(parseIsolationTimeoutMs("  ")).toBeUndefined();
  });

  it("parseIsolationTimeoutMs accepts a positive integer", () => {
    expect(parseIsolationTimeoutMs("5000")).toBe(5000);
    expect(parseIsolationTimeoutMs(" 30000 ")).toBe(30000);
  });

  it("parseIsolationTimeoutMs throws on invalid values (would otherwise disable the timeout)", () => {
    for (const bad of ["bad", "0", "-1", "1.5", "20s", "1e3", "NaN"]) {
      expect(() => parseIsolationTimeoutMs(bad)).toThrow(/positive integer/);
    }
  });

  it("createIsolatedBackend throws on a non-positive / non-integer timeoutMs", () => {
    expect(() => createIsolatedBackend({ createWorker: noopWorker, timeoutMs: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => createIsolatedBackend({ createWorker: noopWorker, timeoutMs: -5 })).toThrow(
      /positive integer/,
    );
    expect(() => createIsolatedBackend({ createWorker: noopWorker, timeoutMs: 1.5 })).toThrow(
      /positive integer/,
    );
    expect(() => createIsolatedBackend({ createWorker: noopWorker, timeoutMs: NaN })).toThrow(
      /positive integer/,
    );
  });

  it("createIsolatedBackend uses the default timeout when timeoutMs is omitted", () => {
    // Omitted → DEFAULT_ISOLATION_TIMEOUT_MS (a valid positive integer), no throw.
    expect(() => createIsolatedBackend({ createWorker: noopWorker })).not.toThrow();
  });
});
