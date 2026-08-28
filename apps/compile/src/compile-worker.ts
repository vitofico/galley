/**
 * The `worker_thread` entry for terminable compile isolation (see
 * isolated-backend.ts). Runs the real Node `TypstEngine` inside a worker thread:
 * load WASM once, then serve one compile job per message, posting the result (or
 * a compile-level error) back to the main thread.
 *
 * Why a worker_thread: a runaway/infinite Typst compile is synchronous WASM that
 * the event loop can't interrupt. Running it here lets the main thread `terminate()`
 * the whole thread on timeout — the only reliable way to stop wedged sync WASM.
 *
 * Results cross the thread boundary by structured clone: diagnostics/pages are
 * plain objects/strings, and PDF bytes are a `Uint8Array` (clone-safe). The HTTP
 * layer base64-encodes the PDF on the wire; that is not this thread's concern.
 *
 * HOW THIS ENTRY IS REACHED: a worker thread does not inherit tsx's loader hooks,
 * so it cannot import this `.ts` file directly. When the service runs from TS
 * source (the runtime image / k8s deploy: `tsx src/server.ts`), `realWorkerFactory`
 * spawns `compile-worker-boot.mjs`, which registers tsx inside the thread and then
 * imports this module; a compiled `tsc` build spawns the emitted sibling `.js`
 * instead. That choice is deterministic — see `defaultWorkerEntry` in
 * isolated-backend.ts.
 *
 * Coverage: the timeout+terminate mechanism is proven against a fake worker in
 * isolated-backend.test.ts, the inline engine's real-WASM behavior in
 * compile-server.test.ts, and THIS entry — loaded in a real thread running the
 * real WASM engine, including a genuine mid-compile terminate — in
 * isolated-real-worker.test.ts (via its own explicit bootstrap, covering the
 * worker protocol). The zero-arg DEFAULT resolution that production actually uses
 * is pinned separately in isolated-default-entry.test.ts; that pin is what stops
 * this entry from silently becoming unreachable again.
 */
import { parentPort } from "node:worker_threads";
import type { TypstEngine } from "@galley/compiler";
import { createNodeEngine } from "./engine.js";
import type { IsolatedJob, IsolatedReply } from "./isolated-backend.js";

if (!parentPort) {
  throw new Error("compile-worker must be run as a worker_thread");
}
const port = parentPort;

// One engine per thread (WASM init is expensive; the thread is per-compile, so
// this runs once before the single job it will serve). Packages stay fail-closed
// here — registry-aware isolation is a later composition (see package-compile.ts).
let enginePromise: Promise<TypstEngine> | null = null;
function engine(): Promise<TypstEngine> {
  enginePromise ??= createNodeEngine();
  return enginePromise;
}

port.on("message", async (job: IsolatedJob) => {
  try {
    const eng = await engine();
    let result: unknown;
    switch (job.op) {
      case "check":
        result = await eng.check(job.input);
        break;
      case "render":
        result = await eng.render(job.input);
        break;
      case "export":
        result = await eng.export(job.input);
        break;
      default: {
        // Exhaustiveness: a new CompileOp must be handled here or this won't compile.
        const _x: never = job.op;
        throw new Error(`unknown compile op: ${String(_x)}`);
      }
    }
    const reply: IsolatedReply = { jobId: job.jobId, result };
    port.postMessage(reply);
  } catch (err) {
    const reply: IsolatedReply = {
      jobId: job.jobId,
      error: err instanceof Error ? err.message : String(err),
    };
    port.postMessage(reply);
  }
});
