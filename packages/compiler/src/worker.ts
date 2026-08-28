/**
 * The Web Worker handler (docs/compiler.md). `serveWorker(scope)` installs the
 * message loop on a worker global: load WASM behind a ready/loading handshake,
 * then serve compile requests off the UI thread. Thin glue over `TypstEngine` +
 * the protocol dispatcher (the testable logic lives elsewhere).
 *
 * The worker *entry file* is first-party to the app that bundles it (so the
 * bundler can see it); that entry is one line: `serveWorker(self)`.
 */

import { TypstEngine } from "./typst-engine.js";
import { handleCompile } from "./worker-protocol.js";
import type { CompileRequest, WorkerRequest, WorkerResponse } from "./worker-protocol.js";

/** The slice of a worker global scope `serveWorker` needs. */
export interface WorkerScope {
  onmessage: ((event: { data: WorkerRequest }) => void | Promise<void>) | null;
  postMessage(message: WorkerResponse): void;
}

export function serveWorker(scope: WorkerScope): void {
  let enginePromise: Promise<TypstEngine> | null = null;

  const fetchBytes = async (url: string): Promise<Uint8Array> => {
    const res = await fetch(url);
    return new Uint8Array(await res.arrayBuffer());
  };

  scope.onmessage = async ({ data }) => {
    if (data.type === "init") {
      enginePromise = (async () => {
        const [compilerModule, rendererModule] = await Promise.all([
          fetchBytes(data.wasmUrl),
          fetchBytes(data.rendererUrl),
        ]);
        return TypstEngine.create({
          compilerModule,
          rendererModule,
          // Omit (not `undefined`) when absent — `exactOptionalPropertyTypes`.
          ...(data.fontAssetPrefix !== undefined ? { fontAssetPrefix: data.fontAssetPrefix } : {}),
        });
      })();
      try {
        await enginePromise;
        scope.postMessage({ type: "ready" });
      } catch (err) {
        enginePromise = null;
        scope.postMessage({ type: "init_error", message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // MVP runs one job at a time; cancellation is handled main-side by ignoring
    // superseded results, so there is nothing to abort mid-flight here.
    if (data.type === "cancel") return;

    if (!enginePromise) {
      scope.postMessage({ type: "error", jobId: data.jobId, message: "compiler not initialized" });
      return;
    }
    const engine = await enginePromise;
    scope.postMessage(await handleCompile(engine, data as CompileRequest));
  };
}
