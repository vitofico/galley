/**
 * Wires `@galley/compiler` to this app's first-party worker entry and its
 * locally-served WASM assets (copied into public/ by scripts/copy-wasm.mjs —
 * never a CDN). The worker URL is local to this app so Vite bundles it.
 *
 * Opt-in (roadmap #3, ADR-0015): with `?serverCompile=1` the compiler is a
 * `RemoteCompilerClient` pointed at an `apps/compile` service instead of the Web
 * Worker — same `Compiler` interface, so preview / agent / diff are unchanged. The
 * service URL comes from `?compileUrl=` (e2e-controllable), else
 * `VITE_GALLEY_COMPILE_URL`, else a localhost default. Default (no flag) is the
 * worker, byte-for-byte as before.
 *
 * Enabler E2 (server-compile made reachable) promotes that path to a proper
 * feature without changing the default. The additions here are ADDITIVE and
 * backward-compatible:
 *   - `initCompiler()` with NO argument is byte-for-byte the historical behaviour
 *     (worker, unless the legacy `?serverCompile=1` flag is set). Both existing
 *     shells (App.tsx, ProjectApp.tsx) and useAgent / FigurePanel keep working
 *     unchanged.
 *   - `initCompiler("server" | "auto" | "local")` lets the new mode toggle pick a
 *     transport. "server"/"auto" build the SAME `RemoteCompilerClient` against the
 *     SAME (already-configured) URL — no new egress surface.
 *   - `createServerCompiler()` is the seam the one-shot auto-fallback uses to spin
 *     up the remote client after a local-worker failure.
 */
import { connectCompilerWorker, RemoteCompilerClient } from "@galley/compiler";
import type { Compiler, CompilerWorkerHandle } from "@galley/compiler";
import {
  type CompileMode,
  type ServerUrlInputs,
  resolveServerCompileUrl,
  resolveTransport,
  serverConfigured,
} from "./components/compiler-mode.js";

/**
 * The minimal window surface {@link gatherServerUrlInputs} reads. Matches the
 * real `Window` (location.search + the optional serve-time config global) and is
 * trivially fakeable in node-environment unit tests.
 */
export interface UrlInputsWindow {
  readonly location: { readonly search: string };
  /** `unknown` on purpose: the global's SHAPE is read defensively. */
  readonly __GALLEY_CONFIG__?: unknown;
}

/**
 * Read the serve-time compile URL out of the `window.__GALLEY_CONFIG__` global
 * (injected by apps/web-server's same-origin /config.js — slice 5). DEFENSIVE:
 * anything but a non-empty string in the expected slot is treated as absent.
 * This only EXTRACTS the value; SSRF validation happens downstream in
 * `validateCompileUrl` exactly as for the build-time env.
 */
function runtimeConfigUrl(config: unknown): string | null {
  if (typeof config !== "object" || config === null) return null;
  const url = (config as { compileUrl?: unknown }).compileUrl;
  return typeof url === "string" && url.trim() !== "" ? url : null;
}

/**
 * Gather the URL-resolution inputs from an explicit window + build-time env —
 * the PURE, unit-testable core of {@link readServerUrlInputs}.
 *
 * Precedence of the TRUSTED operator URL (slice 5): serve-time runtime config
 * (`window.__GALLEY_CONFIG__.compileUrl`, set per-DEPLOY) wins over the
 * build-time `VITE_GALLEY_COMPILE_URL` (baked per-IMAGE) — when an operator sets
 * the deploy-time value it overrides the baked one outright (no silent fallback
 * to a stale baked URL if the deploy value fails validation: fail closed).
 * Both flow into `ServerUrlInputs.envUrl`, so `resolveServerCompileUrl` applies
 * the IDENTICAL trust rules as before — `validateCompileUrl` on every candidate,
 * and the untrusted `?compileUrl=` query param honoured ONLY behind the legacy
 * `?serverCompile=1` dev/e2e hatch (where it outranks both, unchanged). Net
 * order: `?compileUrl=` (legacy flag only) > runtime config > build-time env >
 * localhost default (legacy flag only). A plain shared link can still NEVER
 * widen egress: the query param's reach is byte-for-byte what it was.
 */
export function gatherServerUrlInputs(
  win: UrlInputsWindow,
  buildEnvUrl: string | null | undefined,
): ServerUrlInputs {
  const params = new URLSearchParams(win.location.search);
  return {
    compileUrlParam: params.get("compileUrl"),
    envUrl: runtimeConfigUrl(win.__GALLEY_CONFIG__) ?? buildEnvUrl ?? null,
    serverCompileFlag: params.get("serverCompile") === "1",
  };
}

/**
 * Read the URL-resolution inputs from the live `window` (query params + the
 * serve-time `__GALLEY_CONFIG__` global) and the build env. PURE of the
 * decision (delegated to compiler-mode), this just gathers the raw values using
 * the SAME precedence the legacy flag used (see {@link gatherServerUrlInputs}
 * for the slice-5 runtime-config precedence). Returns empty inputs in
 * non-browser contexts.
 */
export function readServerUrlInputs(): ServerUrlInputs {
  if (typeof window === "undefined") return {};
  return gatherServerUrlInputs(
    window,
    (import.meta.env as Record<string, string | undefined>).VITE_GALLEY_COMPILE_URL ?? null,
  );
}

/**
 * The legacy resolver, preserved for the no-argument default path: returns a URL
 * ONLY when the `?serverCompile=1` flag is set (unchanged from before E2), else
 * null → worker.
 */
function legacyServerCompileUrl(): string | null {
  const inputs = readServerUrlInputs();
  if (!inputs.serverCompileFlag) return null;
  return resolveServerCompileUrl(inputs);
}

/** Build the local Web Worker compiler (the historical default). */
function createWorkerCompiler(): Promise<Compiler> {
  // A worker FACTORY (not a single worker) so the compiler can respawn a wedged
  // worker on the timeout path. Each call builds a fresh first-party worker the
  // bundler can see.
  const createWorker = (): CompilerWorkerHandle =>
    new Worker(new URL("./typst.worker.ts", import.meta.url), {
      type: "module",
    }) as unknown as CompilerWorkerHandle;
  return connectCompilerWorker(createWorker, {
    wasmUrl: "/typst_ts_web_compiler_bg.wasm",
    rendererUrl: "/typst_ts_renderer_bg.wasm",
    // typst.ts bundles no fonts; the default text set is served locally under
    // /fonts/ (staged by scripts/copy-wasm.mjs, never a CDN) so text renders.
    fontAssetPrefix: "/fonts/",
  });
}

/**
 * Build the remote (server) compiler against the configured URL. Returns null
 * (FAIL CLOSED) when no compile service is configured — callers must handle the
 * null rather than invent an endpoint. `inputs` is injectable for tests; it
 * defaults to the live window/env.
 */
export function createServerCompiler(inputs?: ServerUrlInputs): Compiler | null {
  const url = resolveServerCompileUrl(inputs ?? readServerUrlInputs());
  if (!url) return null;
  return new RemoteCompilerClient({ url });
}

/**
 * Whether a server-capable (package-resolving) compiler can be built right now —
 * i.e. a TRUSTED compile URL is configured (serve-time runtime config, the
 * build-time env, or the legacy `?serverCompile=1` dev/e2e hatch with
 * `?compileUrl=`). Used by the shells to
 * gate FigurePanel's `verifyCompilerFactory`: the verify step needs a server
 * compiler to resolve the CeTZ `@preview` package, so we only offer it when one
 * is reachable. Reads the live window/env each call (cheap, render-time safe).
 */
export function serverCompileReachable(): boolean {
  return serverConfigured(readServerUrlInputs());
}

/**
 * Build a SERVER-capable verify compiler for FigurePanel (#8): a remote client
 * against the configured (trusted) compile service, which CAN resolve `@preview`
 * packages (unlike the fail-closed browser worker). Throws if no server is
 * configured — callers MUST gate on {@link serverCompileReachable} first (the
 * factory's contract is to RESOLVE a compiler, not return null). No new egress
 * source: same trusted URL the preview server path uses.
 */
export function createVerifyCompiler(): Promise<Compiler> {
  const remote = createServerCompiler();
  if (!remote) {
    // Defensive: only reachable if a caller ignored serverCompileReachable().
    return Promise.reject(new Error("no server compiler configured for verify"));
  }
  return Promise.resolve(remote);
}

/**
 * Initialise the compiler.
 *
 * BACKWARD COMPATIBLE: `initCompiler()` with no argument reproduces the exact
 * historical behaviour — the local worker, unless the legacy `?serverCompile=1`
 * flag is set (in which case the remote client, as before E2).
 *
 * With an explicit `mode`:
 *   - "local" → always the worker.
 *   - "server" → the remote client when configured; else FAIL CLOSED to the
 *     worker (resolveTransport decides; the visible reason is surfaced by the
 *     hook, not here).
 *   - "auto" → the worker first (the hook handles the one-shot fallback to the
 *     server compiler after a local failure).
 */
export function initCompiler(mode?: CompileMode): Promise<Compiler> {
  // No-argument path: byte-for-byte the historical behaviour.
  if (mode === undefined) {
    const url = legacyServerCompileUrl();
    if (url) return Promise.resolve(new RemoteCompilerClient({ url }));
    return createWorkerCompiler();
  }

  const { transport } = resolveTransport(mode, readServerUrlInputs());
  if (transport === "remote") {
    const remote = createServerCompiler();
    // resolveTransport only returns "remote" when serverConfigured is true, so
    // this is non-null; the guard keeps us fail-closed defensively.
    if (remote) return Promise.resolve(remote);
  }
  return createWorkerCompiler();
}
