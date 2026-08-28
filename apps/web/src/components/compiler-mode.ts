/**
 * Pure compile-mode logic (Enabler E2) — the reachable promotion of the
 * server-side compile path that previously only existed behind the
 * `?serverCompile=1` URL flag.
 *
 * Three user-selectable modes:
 *   - "local"  — the in-browser Web Worker compiler. THE DEFAULT, byte-for-byte
 *                the historical behaviour. No network egress.
 *   - "server" — the `RemoteCompilerClient` over HTTP against the configured
 *                compile service (apps/compile). Engages only when a service URL
 *                is configured (fail-closed; see {@link resolveServerCompileUrl}).
 *   - "auto"   — local worker is tried first; if it fails / is unavailable, fall
 *                back to the server compiler ONCE, VISIBLY. Never silent.
 *
 * This module is PURE: no React, no DOM beyond the small guarded localStorage
 * wrappers (mirroring `theme.ts` / `editor-prefs.ts` / `preview-zoom.ts`).
 * Importing it performs ZERO side effects — it touches no DOM and reads no
 * storage at module-evaluation time, so it cannot change behaviour until a
 * caller explicitly opts in. All seams are injectable for offline unit tests.
 *
 * SECURITY POSTURE (this branch gets an adversarial security review):
 *   - The DEFAULT stays "local"; nothing here changes the default compile path.
 *   - Server / auto can ONLY engage against an ALREADY-configured compile URL
 *     (the same precedence the historical `?serverCompile=1` flag used). There
 *     is NO new egress surface and NO new default endpoint: when no URL is
 *     configured, server/auto FAIL CLOSED back to local.
 *   - Fallback is ONE-SHOT and produces a visible reason string; it is never a
 *     silent retry loop and never silently downgrades the user's chosen mode.
 */

/** The user-selectable compile mode. */
export type CompileMode = "local" | "server" | "auto";

/** The default mode — the in-browser worker, unchanged historical behaviour. */
export const DEFAULT_MODE: CompileMode = "local";

/** The three modes in toggle/cycle order. */
export const COMPILE_MODES: readonly CompileMode[] = ["local", "server", "auto"] as const;

/** Stable, namespaced localStorage key the chosen mode persists under. */
export const COMPILE_MODE_KEY = "galley.compiler.mode";

/** True when `value` is one of the known modes. */
export function isCompileMode(value: unknown): value is CompileMode {
  return value === "local" || value === "server" || value === "auto";
}

/**
 * Resolve the mode to start in. PURE — performs no storage access; the caller
 * supplies the already-read stored value. A valid stored value wins; anything
 * else (null, corrupt, hostile) falls back to {@link DEFAULT_MODE}.
 */
export function resolveInitialMode(stored: string | null): CompileMode {
  return isCompileMode(stored) ? stored : DEFAULT_MODE;
}

/**
 * The minimal storage surface this module needs (a subset of `Storage`).
 * Injectable so the logic is exercisable under the Node test environment with a
 * plain double.
 */
export interface ModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** True when a usable `localStorage` is present (SSR / sandboxed = false). */
function defaultStorage(): ModeStorage | null {
  try {
    if (typeof globalThis !== "undefined" && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    // Accessing localStorage can throw (blocked by the browser).
  }
  return null;
}

/**
 * Load the persisted mode, falling back to {@link DEFAULT_MODE} when nothing is
 * stored, storage is unavailable, or the stored value is malformed. Storage is
 * injectable; omit it to use the guarded global.
 */
export function loadMode(storage?: ModeStorage | null): CompileMode {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return DEFAULT_MODE;
  try {
    return resolveInitialMode(store.getItem(COMPILE_MODE_KEY));
  } catch {
    return DEFAULT_MODE;
  }
}

/**
 * Persist the chosen mode. Best-effort: a failed write (quota, private mode,
 * unavailable storage) is swallowed and never throws.
 */
export function saveMode(mode: CompileMode, storage?: ModeStorage | null): void {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return;
  try {
    store.setItem(COMPILE_MODE_KEY, mode);
  } catch {
    // Best-effort: a failed persist must not break compilation.
  }
}

/** The next mode in {@link COMPILE_MODES} order (wraps). Used by the toggle. */
export function cycleMode(mode: CompileMode): CompileMode {
  const i = COMPILE_MODES.indexOf(mode);
  return COMPILE_MODES[(i + 1) % COMPILE_MODES.length] ?? DEFAULT_MODE;
}

/**
 * Inputs to {@link resolveServerCompileUrl}: the resolved query param, env, and
 * the legacy `?serverCompile=1` flag. PURE so it is testable without a `window`.
 */
export interface ServerUrlInputs {
  /**
   * `?compileUrl=` query value. SECURITY: an untrusted, shared-link-controllable
   * value. It is honoured ONLY as a dev/e2e escape hatch behind the legacy
   * `?serverCompile=1` flag (see {@link resolveServerCompileUrl}); for the
   * user-facing `server`/`auto` toggle it is IGNORED to prevent SSRF /
   * document-egress to an attacker endpoint.
   */
  compileUrlParam?: string | null;
  /** `VITE_GALLEY_COMPILE_URL` build-time env, if set. The trusted source. */
  envUrl?: string | null;
  /** Whether the legacy `?serverCompile=1` flag is set (enables the default URL). */
  serverCompileFlag?: boolean;
}

/** The localhost default the legacy flag used. NOT used unless explicitly opted in. */
export const DEFAULT_SERVER_COMPILE_URL = "http://localhost:3001/compile";

/**
 * Validate a candidate compile-service URL. Returns the normalized URL string
 * when safe, else `null` (FAIL CLOSED). Rejects:
 *   - anything `new URL()` cannot parse;
 *   - protocols other than http/https (no `file:`, `data:`, `javascript:`, …);
 *   - URLs carrying embedded credentials (`user:pass@host`), which can smuggle
 *     auth or confuse the origin.
 */
export function validateCompileUrl(candidate: string | null | undefined): string | null {
  if (!candidate || candidate.length === 0) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username.length > 0 || url.password.length > 0) return null;
  return url.toString();
}

/**
 * Resolve the compile service URL with a TRUST-AWARE precedence (SSRF defense).
 *
 *   - The TRUSTED source for the user-facing `server`/`auto` toggle is the
 *     build-time env `VITE_GALLEY_COMPILE_URL` ONLY.
 *   - The untrusted `?compileUrl=` query param is honoured ONLY as a dev/e2e
 *     escape hatch, gated behind the legacy `?serverCompile=1` flag — so a plain
 *     shared link (no legacy flag) can NEVER point compilation at an attacker
 *     endpoint. With the legacy flag, `?compileUrl=` > env > localhost default
 *     (preserving the historical dev/e2e behaviour).
 *
 * Every resolved candidate passes {@link validateCompileUrl} (http/https only,
 * no embedded credentials). Returns `null` when nothing trusted is configured —
 * the FAIL-CLOSED signal: server/auto must NOT invent an endpoint, so the caller
 * stays on / returns to the local worker.
 */
export function resolveServerCompileUrl(inputs: ServerUrlInputs): string | null {
  if (inputs.serverCompileFlag) {
    // Legacy dev/e2e path: the query-param override is allowed here ONLY.
    const fromParam = validateCompileUrl(inputs.compileUrlParam);
    if (fromParam) return fromParam;
    const fromEnv = validateCompileUrl(inputs.envUrl);
    if (fromEnv) return fromEnv;
    // The localhost default is ONLY reachable behind the explicit legacy flag.
    return validateCompileUrl(DEFAULT_SERVER_COMPILE_URL);
  }
  // User-facing server/auto: trust env ONLY. The untrusted query param is
  // deliberately NOT consulted here (SSRF / document-egress defense).
  return validateCompileUrl(inputs.envUrl);
}

/** Whether a server compiler can be constructed at all (a URL is configured). */
export function serverConfigured(inputs: ServerUrlInputs): boolean {
  return resolveServerCompileUrl(inputs) !== null;
}

/**
 * The effective transport the compiler hook should build for a given mode and
 * server availability. PURE decision; the hook turns this into an actual
 * Compiler instance.
 *
 *   - "local"  → always "worker".
 *   - "server" → "remote" when a URL is configured, else FAIL CLOSED to "worker"
 *                with a visible reason.
 *   - "auto"   → "worker" first (fallback handled separately, post-failure).
 */
export interface ResolvedTransport {
  /** Which client to build initially. */
  transport: "worker" | "remote";
  /**
   * When `transport` differs from what the mode literally asked for (server →
   * worker because unconfigured), a GENERIC human-readable reason; else null.
   * Like {@link FALLBACK_REASON} this is a fixed string with no error/URL detail.
   */
  downgradeReason: string | null;
}

/** Visible message when `server` is selected but no trusted URL is configured. */
export const SERVER_UNAVAILABLE_REASON =
  "Server unavailable — using the local compiler.";

export function resolveTransport(mode: CompileMode, inputs: ServerUrlInputs): ResolvedTransport {
  if (mode === "server") {
    if (serverConfigured(inputs)) return { transport: "remote", downgradeReason: null };
    return {
      transport: "worker",
      downgradeReason: SERVER_UNAVAILABLE_REASON,
    };
  }
  // "local" and "auto" both start on the worker. ("auto" may fall back later.)
  return { transport: "worker", downgradeReason: null };
}

/**
 * Visible message when `auto` mode routes a package-importing document to the
 * server because the in-browser worker cannot resolve Universe (`@preview/…`)
 * packages. SECURITY: a fixed, classified string — it names the *category* of
 * cause (packages) but NEVER the compile URL, host, or any document content. It
 * is the honest, visible signal that this specific compile leaves the browser.
 */
export const PACKAGES_ON_SERVER_REASON =
  "Uses @preview packages — compiling on the server.";

/**
 * Visible message when a document imports Universe (`@preview/…`) packages but NO
 * trusted server compile URL is configured: the document CANNOT compile (the
 * browser worker is fail-closed for packages, and there is no trusted server to
 * route to). SECURITY: GENERIC — it never reveals that a server *could* exist,
 * never leaks a URL/host, and never echoes document content. This is the
 * fail-closed default: when in doubt, DO NOT egress.
 */
export const PACKAGES_UNAVAILABLE_REASON =
  "This document imports @preview packages, which can't be compiled here.";

/**
 * Package-aware transport decision (Wave-2 Lane A, #2/E2). PURE; ADDITIVE — it
 * does NOT change {@link resolveTransport}, it composes on top of it.
 *
 * The in-browser worker is fail-closed for Universe (`@preview/…`) packages, but
 * a trusted-configured server compile service CAN resolve them. This helper is
 * the ONLY place a package-importing document is allowed to be promoted to the
 * server — and only under the conservative document-egress rules below.
 *
 * Decision table (given `importsPackages`, the result of the PURE detector in
 * `compile-input-packages.ts`):
 *
 *   - `importsPackages === false`
 *       → identical to {@link resolveTransport} (no behaviour change at all).
 *
 *   - `local` (ALWAYS, packages or not)
 *       → "worker". `local` is an explicit, honest user choice to NEVER egress;
 *         we respect it even though the package import will then fail in the
 *         worker. We do NOT silently upgrade `local` to the server. No reason is
 *         attached: the worker surfaces the package error itself, honestly.
 *
 *   - `server`
 *       → unchanged: {@link resolveTransport}("server", …). If a trusted URL is
 *         configured it is already "remote" (packages resolve there); if not it
 *         already fails closed to the worker with {@link SERVER_UNAVAILABLE_REASON}.
 *
 *   - `auto` + packages + trusted server URL configured
 *       → "remote" with {@link PACKAGES_ON_SERVER_REASON} (VISIBLE egress).
 *
 *   - `auto` + packages + NO trusted URL
 *       → FAIL CLOSED to a `packagesUnavailable` state on the worker with the
 *         GENERIC {@link PACKAGES_UNAVAILABLE_REASON}. We never invent an endpoint
 *         and never leak that a server could have helped.
 *
 * The returned `transport`/`downgradeReason` keep the {@link ResolvedTransport}
 * shape (so existing callers are unaffected), with one additive field:
 * `packagesUnavailable` — true ONLY in the last case, so the hook can render a
 * blocked-compile affordance instead of attempting a doomed worker compile.
 */
export interface PackageAwareTransport extends ResolvedTransport {
  /**
   * True ONLY when the document imports packages, mode is `auto`, and no trusted
   * server URL is configured — the fail-closed "can't compile here" state. The
   * hook should NOT attempt a (doomed) worker compile in this case; it should
   * surface {@link PACKAGES_UNAVAILABLE_REASON}. Absent (omitted) otherwise, to
   * satisfy `exactOptionalPropertyTypes`.
   */
  packagesUnavailable?: true;
}

export function resolvePackageAwareTransport(
  mode: CompileMode,
  inputs: ServerUrlInputs,
  importsPackages: boolean,
): PackageAwareTransport {
  // No packages → the existing policy is unchanged, byte for byte.
  if (!importsPackages) return resolveTransport(mode, inputs);

  // `local` is an explicit never-egress choice: respected even with packages.
  // The worker surfaces the package failure honestly; we do NOT auto-upgrade.
  if (mode === "local") return { transport: "worker", downgradeReason: null };

  // `server` is unchanged: it is already remote (packages resolve) when a trusted
  // URL is configured, or already fails closed to the worker when it is not.
  if (mode === "server") return resolveTransport(mode, inputs);

  // mode === "auto" + packages: promote to the server ONLY under trusted config.
  if (serverConfigured(inputs)) {
    return { transport: "remote", downgradeReason: PACKAGES_ON_SERVER_REASON };
  }
  // No trusted server: FAIL CLOSED. No egress, no invented endpoint, generic reason.
  return {
    transport: "worker",
    downgradeReason: PACKAGES_UNAVAILABLE_REASON,
    packagesUnavailable: true,
  };
}

/**
 * One-shot fallback state machine for "auto" mode.
 *
 * The hook calls {@link shouldFallback} after a local-worker init/compile
 * failure. It returns true at most ONCE per state object (and only when a
 * server URL is configured). After {@link markFallbackActive} the fallback is
 * latched: subsequent failures do NOT trigger further fallback (no retry loop),
 * and {@link FALLBACK_REASON} (a generic string) is exposed for the UI.
 */
export interface FallbackState {
  /** True once the one-shot fallback has been consumed. */
  active: boolean;
  /** Visible reason the fallback engaged (null until it does). */
  reason: string | null;
}

/** A fresh, un-triggered fallback state. */
export function createFallbackState(): FallbackState {
  return { active: false, reason: null };
}

/**
 * Decide whether an "auto"-mode local failure should fall back to the server
 * compiler. True ONLY when: mode is "auto", a server URL is configured, and the
 * fallback has not already fired (one-shot). Any other mode never falls back —
 * "local" stays local, "server" is already remote.
 */
export function shouldFallback(
  mode: CompileMode,
  state: FallbackState,
  inputs: ServerUrlInputs,
): boolean {
  if (mode !== "auto") return false;
  if (state.active) return false;
  return serverConfigured(inputs);
}

/**
 * The single GENERIC, DOM-visible fallback message. SECURITY: this is a fixed,
 * classified string — it NEVER interpolates the underlying error, the compile
 * URL, or any response body. Raw `Error.message` can carry filesystem paths,
 * document snippets, or (later) service response bodies, so it must not reach
 * the badge. The original cause is still logged to the console for operators.
 */
export const FALLBACK_REASON = "Local compiler failed; using the server compiler.";

/**
 * Latch the one-shot fallback as active and record the GENERIC visible reason.
 * Returns a NEW state object (never mutates the input) so React state updates are
 * clean. The `cause` is intentionally NOT embedded in the visible reason (info-
 * leak defense); callers that want it should `console.error` it separately.
 */
export function markFallbackActive(): FallbackState {
  return {
    active: true,
    reason: FALLBACK_REASON,
  };
}
