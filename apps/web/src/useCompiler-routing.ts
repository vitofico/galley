/**
 * PURE routing decisions for {@link useCompiler}'s package-aware compile path
 * (Lane A + F, #2/E2). Extracted from the React hook so the SECURITY-CRITICAL
 * orchestration is node-testable without jsdom / a real worker:
 *
 *   - which compiler a compile/export must run on (worker / package-remote /
 *     blocked) given the document's package imports + trusted-server config;
 *   - whether a LOCAL-worker failure may one-shot fall back to the server
 *     (NEVER off a remote/package attempt — that would re-egress under a false
 *     "local failed" badge: review H1);
 *   - whether the worker render should request the #11.3 source map (worker
 *     path only; the remote path stays map-less).
 *
 * This composes on top of the already-tested pure core {@link
 * resolvePackageAwareTransport} — it adds no new trust source and makes no
 * network/DOM access. The hook turns a {@link RenderRoute} into concrete
 * compiler calls; everything that decides EGRESS lives here and is unit-tested.
 */
import {
  type CompileMode,
  type ServerUrlInputs,
  resolvePackageAwareTransport,
} from "./components/compiler-mode.js";

/** Where a single compile/export must run, and the egress-relevant flags. */
export interface RenderRoute {
  /**
   * - "worker"        — the in-browser fail-closed worker (default; no egress).
   * - "packageRemote" — the lazily-built server client, because the doc imports
   *                     `@preview/…` packages and (auto + a trusted URL) routes
   *                     them to the server. VISIBLE egress.
   * - "blocked"       — packages imported but no trusted server: FAIL CLOSED, do
   *                     NOT compile (no egress, no doomed worker compile).
   */
  kind: "worker" | "packageRemote" | "blocked";
  /**
   * True ONLY when the chosen route is the LOCAL worker in auto mode — the one
   * case a render failure may one-shot fall back to the server. False for the
   * package-remote route (H1: a remote failure must NOT trigger fallback) and for
   * every non-auto mode.
   */
  mayAutoFallback: boolean;
  /**
   * Whether this render should ask the engine for the #11.3 source map. Only on
   * the worker route (the remote/server path returns no map → preview-sync stays
   * inert there). Never on a blocked route (there is no render).
   */
  requestSourceMap: boolean;
  /** The generic, classified reason for a blocked / egress route (never a URL). */
  reason: string | null;
}

/**
 * Decide the render route for one compile. PURE: the same trusted `inputs` the
 * mode resolver uses, no new egress source.
 */
export function selectRenderRoute(
  mode: CompileMode,
  importsPackages: boolean,
  inputs: ServerUrlInputs,
): RenderRoute {
  const routed = resolvePackageAwareTransport(mode, inputs, importsPackages);

  if (routed.packagesUnavailable) {
    return { kind: "blocked", mayAutoFallback: false, requestSourceMap: false, reason: routed.downgradeReason };
  }

  // Package egress is scoped to auto: in `server` mode the mode-built compiler is
  // ALREADY remote (no separate package client / double badge), and `local`/no-
  // package cases keep transport === "worker".
  const packageEgress = mode === "auto" && importsPackages && routed.transport === "remote";
  if (packageEgress) {
    return { kind: "packageRemote", mayAutoFallback: false, requestSourceMap: false, reason: routed.downgradeReason };
  }

  // Worker route. Auto-mode local failures may one-shot fall back to the server;
  // the source map is requested here (worker builds it best-effort, #11.3).
  return {
    kind: "worker",
    mayAutoFallback: mode === "auto" && routed.transport === "worker",
    requestSourceMap: true,
    reason: null,
  };
}
