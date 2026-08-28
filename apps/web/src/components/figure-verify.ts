import type { AgentCompiler } from "@galley/agent";
import type { Diagnostic } from "@galley/shared";

/**
 * The injected-seam types + pure helpers for FigurePanel's OPTIONAL server-side
 * verify step (roadmap #8). Kept OUT of the component module so they unit-test in
 * the Node gate without dragging in React or WASM — the repo's house pattern
 * (cf. `import-repair.ts`).
 *
 * Why this seam exists: the figure generate loop uses the browser's fail-closed
 * compiler, which CANNOT resolve the `@preview/cetz` package, so an offline
 * generate can only ever say "could not verify". A server-capable compiler CAN
 * resolve packages — when the host injects one via `verifyCompilerFactory`, the
 * panel re-compiles the generated snippet for a REAL clean-or-diagnostics
 * verdict. The factory is injected (not a concrete import) so the panel stays
 * testable with a fake compiler and the Node gate never pulls in the typst.ts
 * worker. When the prop is OMITTED — today's shell call sites — the panel
 * behaves byte-for-byte as before.
 */

/**
 * A compiler instance the verify step can drive (diagnostics-only `check`), plus
 * an optional `dispose` the panel calls when finished (or on close / unmount).
 * Structurally a superset of the agent core's `AgentCompiler`, so the same
 * `@galley/compiler` `Compiler` the generate flow uses satisfies it directly.
 */
export interface VerifyCompiler extends AgentCompiler {
  dispose?: () => void;
}

/**
 * Builds a fresh server-capable compiler for the verify step. Created lazily on
 * first verify and disposed by the panel — the host never owns its lifecycle.
 * This is the FigurePanel's `verifyCompilerFactory` prop type: optional and
 * additive, mirroring ImportPanel's `repair.compilerFactory`.
 */
export type VerifyCompilerFactory = () => Promise<VerifyCompiler>;

/** The outcome of a verify round, once it has run. */
export interface FigureVerifyState {
  /** True iff the snippet compiled with no errors on the server compiler. */
  ok: boolean;
  /** Diagnostics from the verify compile (empty when `ok`). */
  diagnostics: Diagnostic[];
}

/**
 * The exact verify orchestration FigurePanel performs: compile the generated
 * snippet on the injected server-capable compiler and normalize to a plain
 * `{ ok, diagnostics }`. Extracted as a pure async helper (no React) so the Node
 * gate exercises the real interaction with a fake compiler.
 */
export async function runFigureVerify(
  snippet: string,
  compiler: AgentCompiler,
): Promise<FigureVerifyState> {
  const check = await compiler.check(snippet);
  return { ok: check.ok, diagnostics: check.diagnostics };
}

/**
 * Human-readable status for a finished verify, mirroring the panel's existing
 * status wording. Pure + exported so the Node gate asserts the phrasing without
 * a DOM.
 */
export function verifyStatusLabel(state: FigureVerifyState): string {
  if (state.ok) {
    return "Verified — compiles cleanly with package resolution (server compile).";
  }
  const n = state.diagnostics.length;
  return `Did not compile — ${n} diagnostic${n === 1 ? "" : "s"}; review before inserting.`;
}
