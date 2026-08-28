/**
 * THE REGRESSION PIN for the production worker entry.
 *
 * THE BUG THIS EXISTS TO CATCH: `realWorkerFactory()`'s DEFAULT entry resolution
 * was unreachable from TS source. It resolved a sibling `./compile-worker.js`
 * that does not exist next to `compile-worker.ts`, and the runtime image runs the
 * service from TS via tsx with no tsc dist — so every compile faulted into
 * `CompileUnavailableError` → HTTP 503, on a deploy that ships
 * `GALLEY_COMPILE_ISOLATION=worker`.
 *
 * WHY THE EXISTING SUITES MISSED IT — and why this file must stay separate:
 *   - isolated-backend.test.ts injects a FAKE worker (no entry resolution at all).
 *   - compile-server.test.ts drives real WASM, but only on the INLINE engine.
 *   - isolated-real-worker.test.ts drives a real thread + real WASM, but passes an
 *     EXPLICIT `workerUrl` to a generated bootstrap — deliberately covering the
 *     worker protocol, NOT the default resolution.
 * So the one thing production actually does — call `realWorkerFactory()` with NO
 * arguments — was covered by nothing.
 *
 * THE RULE FOR THIS FILE: every case here calls `realWorkerFactory()` with ZERO
 * arguments. The default entry IS the subject. Do not add a `workerUrl` to these
 * cases to make them pass; that would restore the exact blind spot.
 */
import { describe, it, expect } from "vitest";
import type { CheckResult } from "@galley/shared";
import {
  assertIsolatedBackendUsable,
  createIsolatedBackend,
  realWorkerFactory,
  CompileUnavailableError,
  WorkerInitializationError,
} from "./isolated-backend.js";

describe("realWorkerFactory: the DEFAULT (production) worker entry", () => {
  it("compiles through a real thread + real WASM with NO explicit workerUrl", async () => {
    // This is the exact wiring server.ts uses under GALLEY_COMPILE_ISOLATION=worker.
    // A broken default entry faults here in ~50-100ms instead of compiling.
    const backend = createIsolatedBackend({
      createWorker: realWorkerFactory(),
      timeoutMs: 60_000,
    });
    const res = (await backend.check("= Hello\nBody.")) as CheckResult;
    expect(res.ok).toBe(true);
    expect(res.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(res.pageCount).toBe(1);
  }, 60_000);

  it("reports a broken entry as a FAULT, never masquerading as a timeout", async () => {
    // `CompileUnavailableError` is BOTH the legitimate timeout path and the
    // thread-fault path, so a bare `instanceof` assertion passes even when the
    // worker never loaded — the false green that let the 503 bug ship. Pin the
    // discriminant on a deliberately unloadable entry: an operator (and the
    // preflight below) must be able to tell "runaway document killed, service
    // healthy" from "the worker cannot run at all".
    const backend = createIsolatedBackend({
      createWorker: realWorkerFactory(new URL("./does-not-exist.mjs", import.meta.url)),
      timeoutMs: 60_000,
    });
    const err = await backend.check("= Hi").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CompileUnavailableError);
    expect((err as CompileUnavailableError).reason).toBe("fault");
  }, 60_000);
});

describe("assertIsolatedBackendUsable: fail loud instead of 503ing forever", () => {
  it("refuses to start when the worker entry cannot run a compile", async () => {
    // The startup path k8s takes when the entry is broken. Before this preflight
    // existed, a service in this state bound its port and answered every compile
    // with 503 — forever, and indistinguishably from load-shedding.
    const backend = createIsolatedBackend({
      createWorker: realWorkerFactory(new URL("./does-not-exist.mjs", import.meta.url)),
      timeoutMs: 60_000,
    });
    const err = await assertIsolatedBackendUsable(backend).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WorkerInitializationError);
    // The message must name the real cause, not just "unavailable" — this is the
    // whole diagnostic value of failing at startup.
    expect((err as Error).message).toContain("refusing to start");
    expect((err as Error).message).toContain("does-not-exist.mjs");
  }, 60_000);

  it("passes for the real default entry (the production wiring boots)", async () => {
    const backend = createIsolatedBackend({
      createWorker: realWorkerFactory(),
      timeoutMs: 60_000,
    });
    await expect(assertIsolatedBackendUsable(backend)).resolves.toBeUndefined();
  }, 60_000);
});
