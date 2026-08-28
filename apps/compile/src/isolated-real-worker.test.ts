/**
 * Real-worker integration coverage for the terminable isolation backend.
 *
 * THE GAP THIS CLOSES: isolated-backend.test.ts proves the timeout+terminate
 * mechanism against a FAKE worker, and compile-server.test.ts proves real WASM on
 * the INLINE engine — so nothing ever loaded `compile-worker` in a real thread,
 * even though the shipped k8s deploy sets `GALLEY_COMPILE_ISOLATION=worker`.
 * These cases run the REAL `compile-worker` entry, in a REAL `worker_thread`,
 * driving the REAL WASM engine: no stub worker, no stub engine.
 *
 * WHY A GENERATED BOOTSTRAP ENTRY: a worker thread does NOT inherit tsx's loader
 * hooks from its parent (verified: a plain `.mjs` worker entry under a tsx main
 * still cannot resolve `./engine.js` → `engine.ts`), and `--import` in a worker's
 * `execArgv` is ignored by Node. A thread can, however, register the hooks
 * ITSELF — so we write a tiny bootstrap that calls tsx's `register()` and then
 * imports the real `.ts` entry. tsx is already a declared dependency of this
 * package; nothing new is added.
 *
 * SCOPE — read this before trusting a green run: these cases deliberately pass an
 * explicit `workerUrl`, so they cover the worker PROTOCOL and in-thread WASM init,
 * NOT `realWorkerFactory`'s default entry resolution. A green run here does NOT
 * mean the shipped worker-isolation path works — that default once resolved a
 * `./compile-worker.js` that does not exist under tsx, 503ing every compile while
 * this file stayed green. The default is now pinned by isolated-default-entry.test.ts;
 * keep these cases explicit and leave that pin to cover production's zero-arg call.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import type { CheckResult } from "@galley/shared";
import {
  createIsolatedBackend,
  realWorkerFactory,
  CompileUnavailableError,
} from "./isolated-backend.js";

// Unique per process so a concurrent run can't race on the same path.
const bootUrl = new URL(`./__real-worker-boot.${process.pid}.mjs`, import.meta.url);

beforeAll(() => {
  // Lives beside the source on purpose: `tsx/esm/api` and `./compile-worker.ts`
  // both resolve naturally from this package.
  writeFileSync(
    bootUrl,
    [
      'import { register } from "tsx/esm/api";',
      "register();",
      'await import("./compile-worker.ts");',
      "",
    ].join("\n"),
  );
});

afterAll(() => {
  rmSync(bootUrl, { force: true });
});

describe("isolated backend — REAL worker_thread + REAL WASM engine", () => {
  it("compiles a document through a real worker thread", async () => {
    // Proves the entry loads AND the WASM engine initialises INSIDE the thread.
    const backend = createIsolatedBackend({
      createWorker: realWorkerFactory(bootUrl),
      timeoutMs: 60_000,
    });
    const res = (await backend.check("= Hello\nBody.")) as CheckResult;
    expect(res.ok).toBe(true);
    expect(res.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(res.pageCount).toBe(1);
  }, 60_000);

  it("terminates a real worker mid-compile and reports unavailable on timeout", async () => {
    // A genuinely EXPENSIVE document (~7s here): varied content per page defeats
    // Typst's comemo memoization, so the thread is really wedged in sync WASM —
    // the one thing a JS timer cannot preempt, which is why terminate() exists.
    // Sized deliberately: much larger wedges the wasm32 heap into a panic (a
    // FAULT, not a timeout), which would test the wrong path.
    const runaway = "#for i in range(20000) [ #str(i) #lorem(40) #pagebreak() ]";
    const backend = createIsolatedBackend({
      createWorker: realWorkerFactory(bootUrl),
      timeoutMs: 1_000,
    });
    const err = await backend.check(runaway).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CompileUnavailableError);
    // Assert the TIMEOUT message specifically. `CompileUnavailableError` is ALSO
    // how a thread-level FAULT surfaces, so a bare instanceof check passes even
    // when the worker never loaded — the exact false green that hid the
    // unreachable-entry bug. The 1s budget is what gives this teeth: it is long
    // enough that a broken entry faults FIRST (~84ms) and fails this assertion,
    // and ~7x short of the real compile, so a fast host cannot race it green.
    expect((err as CompileUnavailableError).message).toContain("worker terminated");
  }, 60_000);
});
