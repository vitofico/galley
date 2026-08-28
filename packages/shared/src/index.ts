/**
 * @galley/shared — cross-package types and contracts.
 *
 * This package contains ONLY types and pure constants. No runtime logic, no
 * framework imports, no I/O. If something needs a dependency, it belongs in
 * `compiler`, `agent`, or `web`, not here.
 */

export * from "./diagnostics.js";
export * from "./compile.js";
export * from "./edits.js";
export * from "./document.js";
export * from "./provider.js";
export * from "./proxy.js";
export * from "./agent-events.js";
export * from "./author.js";
export * from "./persistence.js";
export * from "./groups.js";
export * from "./auth.js";
export * from "./capability-rooms.js";

/** Default cap on agent self-correction iterations (see docs/agent-loop.md). */
export const DEFAULT_MAX_ITERS = 5;
