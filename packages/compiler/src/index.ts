/**
 * @galley/compiler — the typst.ts wrapper (docs/compiler.md, ADR-0001).
 *
 * Framework-agnostic: no React, no app state. The actual WASM compile runs OFF
 * the UI thread in a Web Worker. `connectCompilerWorker()` spins the worker, loads
 * the WASM behind a loading state, and exposes check/render/export with stale-job
 * cancellation.
 *
 * Layering:
 *   - TypstEngine        — the typst.ts binding (also runs in Node, so it's unit
 *                          tested with real compilation).
 *   - worker-protocol    — the pure main⇄worker message dispatcher (node-tested).
 *   - CompilerClient     — main-thread correlation + cancellation (node-tested).
 *   - worker.ts          — the browser Worker entry (e2e-tested).
 */

import { CompilerClient } from "./compiler-client.js";
import type { Compiler, WorkerTransport } from "./compiler-client.js";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol.js";

// Pure source-position mapping (Typst UTF-8 byte offsets <-> UTF-16 line/col).
export { SourceMapper } from "./offset-map.js";
// Forward source→preview index (#11.3): pure builder + cursor lookup. Opt-in;
// the index is attached to a render result only when explicitly requested.
export {
  buildPreviewSourceMap,
  lookupPreviewRegion,
  parseAstTextLeaves,
  parseSvgTextRuns,
  parseTransform,
} from "./preview-source-map.js";
export type { AstTextLeaf, SvgTextRun } from "./preview-source-map.js";
// Inverse source map (#11.3): preview pixel point -> source line/col (click-to-jump).
export { lookupSourceAtPoint } from "./preview-source-map.js";
export type { PreviewPoint } from "./preview-source-map.js";
// typst.ts diagnostics -> the shared `Diagnostic` shape (single-file + project).
export {
  normalizeDiagnostics,
  normalizeProjectDiagnostics,
} from "./diagnostics.js";
// Package-resolver seam (offline-first; fail-closed in the browser). ADR-0014.
export {
  parsePackageSpec,
  packageSpecString,
  parsePackageImports,
  resolvePackagePaths,
  FakeRegistry,
  PackageValidationError,
  DEFAULT_PACKAGE_LIMITS,
} from "./package-resolver.js";
export type {
  PackageSpec,
  PackageResolver,
  PackageLimits,
} from "./package-resolver.js";
// Bridges the resolver seam to typst.ts's package-registry callback (roadmap #3).
export { packageRegistryBeforeBuild } from "./package-registry-bridge.js";
// The framework-agnostic typst.ts binding (runs in Node tests + the Web Worker).
export { TypstEngine } from "./typst-engine.js";
export type { ModuleSource, TypstEngineOptions } from "./typst-engine.js";
// The main-thread compiler handle + its worker transport seam.
export {
  CompilerClient,
  CompileCancelledError,
  CompileTimeoutError,
} from "./compiler-client.js";
export type {
  Compiler,
  CompilerClientOptions,
  WorkerTransport,
} from "./compiler-client.js";
// Remote (server-side) compiler over HTTP — same Compiler interface (ADR-0015).
export { RemoteCompilerClient } from "./remote-compiler-client.js";
export type { RemoteCompilerOptions } from "./remote-compiler-client.js";
// base64 for PDF bytes on the compile-service wire.
export { bytesToBase64, base64ToBytes } from "./base64.js";
export type { WorkerRequest, WorkerResponse } from "./worker-protocol.js";
// The worker handler (installed on a first-party worker entry by the app).
export { serveWorker } from "./worker.js";
export type { WorkerScope } from "./worker.js";

/**
 * Asset URLs the worker fetches (all served locally by the app, never a CDN).
 * `fontAssetPrefix` is where the default text fonts live (e.g. `/fonts/`);
 * typst.ts bundles none, so without it text renders with empty glyphs.
 */
export interface CompilerAssets {
  wasmUrl: string;
  rendererUrl: string;
  fontAssetPrefix?: string;
}

/**
 * A worker handle `connectCompilerWorker` drives. The browser `Worker` satisfies
 * it structurally. The APP creates the worker (from a first-party entry that the
 * bundler can see) and hands it here, keeping this package free of any static
 * worker-URL the bundler would try to resolve.
 */
export interface CompilerWorkerHandle {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    handler: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    handler: (event: MessageEvent) => void,
  ): void;
  terminate(): void;
}

/** A `WorkerTransport` over a single `CompilerWorkerHandle`. */
function transportFor(worker: CompilerWorkerHandle): WorkerTransport {
  return {
    post: (message) => worker.postMessage(message),
    onMessage: (handler) =>
      worker.addEventListener("message", (event: MessageEvent) =>
        handler(event.data as WorkerResponse),
      ),
    terminate: () => worker.terminate(),
  };
}

/**
 * Initialize a compiler over app-created workers. Takes a worker FACTORY (not a
 * single worker) so a genuinely wedged worker — stuck on a sync WASM compile a
 * `cancel` can't preempt — can be terminated and respawned on the TIMEOUT path.
 * Resolves once the FIRST worker + its WASM are ready (callers show a loading
 * state until then). Browser-only — Node tests use `TypstEngine`/`CompilerClient`
 * directly.
 *
 * A normal superseded `cancel()` does NOT respawn (respawnOnCancel left false):
 * the live preview supersedes in-flight compiles constantly, and churning the
 * worker per edit would reload WASM on large docs.
 */
export async function connectCompilerWorker(
  createWorker: () => CompilerWorkerHandle,
  assets: CompilerAssets,
  options: { timeoutMs?: number } = {},
): Promise<Compiler> {
  const init: WorkerRequest = {
    type: "init",
    wasmUrl: assets.wasmUrl,
    rendererUrl: assets.rendererUrl,
    // Omit (not `undefined`) when absent — `exactOptionalPropertyTypes`.
    ...(assets.fontAssetPrefix !== undefined
      ? { fontAssetPrefix: assets.fontAssetPrefix }
      : {}),
  };

  const first = createWorker();
  await new Promise<void>((resolve, reject) => {
    const onReady = (event: MessageEvent) => {
      const data = event.data as WorkerResponse;
      if (data.type === "ready") {
        first.removeEventListener("message", onReady);
        resolve();
      } else if (data.type === "init_error") {
        first.removeEventListener("message", onReady);
        reject(new Error(data.message));
      }
    };
    first.addEventListener("message", onReady);
    first.postMessage(init);
  });

  // Respawn factory: spin a fresh worker and post the SAME init. Safe to return
  // the transport synchronously even though WASM init is async — `serveWorker`
  // assigns its `enginePromise` synchronously in the `init` branch before
  // awaiting WASM, and worker messages are FIFO, so a compile posted right after
  // init queues behind it and awaits readiness inside the worker.
  const createTransport = (): WorkerTransport => {
    const worker = createWorker();
    worker.postMessage(init);
    return transportFor(worker);
  };

  return new CompilerClient(transportFor(first), {
    createTransport,
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
  });
}
