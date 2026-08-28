import { describe, expect, it } from "vitest";
import type { ServerUrlInputs } from "./components/compiler-mode.js";
import { selectRenderRoute } from "./useCompiler-routing.js";

/**
 * SECURITY-CRITICAL routing decisions for the package-aware compile path
 * (review H1/C1/C2). These prove, offline + deterministically, that:
 *   - auto + `@preview` packages + a TRUSTED server → exactly ONE packageRemote
 *     route, and it NEVER allows the local-worker auto-fallback (H1);
 *   - a no-package render then takes the worker route (no lingering egress);
 *   - auto + packages + NO trusted server → blocked (fail closed, no egress);
 *   - `local` always stays on the worker even with packages (never auto-upgrade);
 *   - `server` mode is already remote (handled by the mode compiler, not a second
 *     package client) — so the package route does NOT engage here;
 *   - the source map is requested ONLY on the worker route.
 */

/** Trusted env URL configured (the only trusted source for server/auto). */
const WITH_SERVER: ServerUrlInputs = { envUrl: "http://localhost:3001/compile" };
/** Nothing trusted configured → server/auto fail closed. */
const NO_SERVER: ServerUrlInputs = {};

describe("selectRenderRoute", () => {
  it("auto + packages + trusted server → packageRemote, no fallback, no source map", () => {
    const r = selectRenderRoute("auto", true, WITH_SERVER);
    expect(r.kind).toBe("packageRemote");
    expect(r.mayAutoFallback).toBe(false); // H1: never fall back off a remote attempt
    expect(r.requestSourceMap).toBe(false); // remote returns no map
    expect(r.reason).toBeTruthy(); // a visible egress reason
  });

  it("auto + packages + NO trusted server → blocked (fail closed, no egress)", () => {
    const r = selectRenderRoute("auto", true, NO_SERVER);
    expect(r.kind).toBe("blocked");
    expect(r.mayAutoFallback).toBe(false);
    expect(r.requestSourceMap).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it("auto + NO packages → worker route (with source map), fallback allowed", () => {
    // A subsequent no-package render must return to the worker — proving the
    // package remote does not linger as the active route.
    const r = selectRenderRoute("auto", false, WITH_SERVER);
    expect(r.kind).toBe("worker");
    expect(r.mayAutoFallback).toBe(true); // auto worker MAY one-shot fall back
    expect(r.requestSourceMap).toBe(true); // #11.3 only on the worker path
  });

  it("local + packages → worker (never auto-upgrade to the server)", () => {
    const r = selectRenderRoute("local", true, WITH_SERVER);
    expect(r.kind).toBe("worker");
    expect(r.mayAutoFallback).toBe(false); // local never falls back
    expect(r.requestSourceMap).toBe(true);
  });

  it("local + NO packages → worker, no fallback, source map requested", () => {
    const r = selectRenderRoute("local", false, NO_SERVER);
    expect(r.kind).toBe("worker");
    expect(r.mayAutoFallback).toBe(false);
    expect(r.requestSourceMap).toBe(true);
  });

  it("server mode + packages does NOT engage the package route (mode compiler is already remote)", () => {
    // In `server` mode the mode-built compiler is the remote client itself; the
    // package route must not spin a SECOND remote / double-badge → it is NOT
    // 'packageRemote'. With a trusted URL the worker route is taken here (the hook
    // already holds the remote as compilerRef), and crucially mayAutoFallback is
    // false (server mode never auto-falls-back).
    const r = selectRenderRoute("server", true, WITH_SERVER);
    expect(r.kind).not.toBe("packageRemote");
    expect(r.mayAutoFallback).toBe(false);
  });
});
