/**
 * Pure startup config resolution for the compile service — NO side-effectful
 * imports, so it is unit-testable without booting a server or a worker.
 *
 * Isolation default (2026-07 FLIP, operator-decided): `GALLEY_COMPILE_ISOLATION`
 * UNSET now means `worker` — every compile runs in a terminable `worker_thread`
 * with a hard timeout, so a runaway document is killed (503) instead of wedging
 * the service. The old default was `inline` (WASM on the event loop); the flip is
 * behaviour-changing by design. The steady-state cost is ~1–2 ms over inline
 * because V8 compiles the WASM module once per process and reuses it across
 * threads; the one-time module compile (~106 ms) is paid once per process, not
 * per request. See `isolated-backend.ts`.
 *
 * Registry packages are the one path that still needs `inline`: the per-request
 * worker thread has no package-resolver holder, so a registry-aware worker is not
 * supported yet. Combining `REGISTRY_BASE_URL` with worker isolation fails loud at
 * startup (below) rather than silently degrading.
 */

export type CompileIsolation = "worker" | "inline";

/**
 * Resolve `GALLEY_COMPILE_ISOLATION` into a concrete backend selector.
 *
 * Strict tri-state:
 *   - unset / blank        → `"worker"` (the default since the 2026-07 flip)
 *   - `"worker"`           → `"worker"`
 *   - `"inline"`           → `"inline"`
 *   - ANY other value      → THROW
 *
 * THROWS on an unrecognised value rather than falling through to the default: a
 * typo (`"inlien"`, `"off"`, `"WORKER"`) would otherwise silently resolve to the
 * worker default and quietly override an operator who meant something else — the
 * exact silent-misconfiguration failure the sibling `GALLEY_COMPILE_MAX_CONCURRENCY`
 * / `GALLEY_COMPILE_TIMEOUT_MS` parsers reject. Surrounding whitespace is trimmed
 * (matching those parsers) so a quoting artifact isn't mistaken for a typo.
 */
export function resolveCompileIsolation(raw: string | undefined): CompileIsolation {
  if (raw === undefined || raw.trim() === "") return "worker";
  const value = raw.trim();
  if (value === "worker") return "worker";
  if (value === "inline") return "inline";
  throw new Error(
    `GALLEY_COMPILE_ISOLATION must be "worker" or "inline" (or unset for the "worker" ` +
      `default); got "${raw}"`,
  );
}

/**
 * The exact startup error when a registry is combined with worker isolation.
 * Operators grep on this text, and `server-config.test.ts` pins it verbatim —
 * do not reword without updating the pin.
 */
export const REGISTRY_WORKER_INCOMPATIBLE_MESSAGE =
  "REGISTRY_BASE_URL requires GALLEY_COMPILE_ISOLATION=inline; unset defaults to worker, " +
  "and registry-aware workers are not supported yet";

/**
 * Fail loud when `REGISTRY_BASE_URL` is configured AND the resolved isolation is
 * `worker`: the per-request worker thread has no package-resolver holder, so a
 * registry-aware worker cannot work today. A blank/whitespace base URL counts as
 * "no registry" (mirrors `server.ts`, which trims before selecting a backend).
 */
export function assertRegistryIsolationCompatible(
  isolation: CompileIsolation,
  registryBaseUrl: string | undefined,
): void {
  const baseUrl = registryBaseUrl?.trim();
  if (baseUrl && isolation === "worker") {
    throw new Error(REGISTRY_WORKER_INCOMPATIBLE_MESSAGE);
  }
}
