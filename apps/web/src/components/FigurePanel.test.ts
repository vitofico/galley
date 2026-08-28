import { describe, it, expect } from "vitest";
import type { AgentCompiler } from "@galley/agent";
import type { CheckResult, Diagnostic } from "@galley/shared";
import type { VerifyCompiler, VerifyCompilerFactory } from "./figure-verify.js";
import { runFigureVerify, verifyStatusLabel } from "./figure-verify.js";

/**
 * FigurePanel's OPTIONAL server-side verify step (roadmap #8) is a thin shell
 * over (a) the pure `runFigureVerify` orchestration and (b) the pure
 * `verifyStatusLabel`, both driven through an injected `verifyCompilerFactory`.
 *
 * Per the repo's Node-env house pattern (cf. ImportPanel.test.ts, HistoryPanel,
 * doc-stats: no jsdom, no @testing-library/react) we test the exported helpers +
 * the exact injected interaction the panel performs, with a fake compiler. The
 * DOM-level surface — the "Verify compile" button visibility (only when the prop
 * is passed) and the verify-result status — is covered by Lane F's real e2e once
 * a server-capable compiler is wired.
 */

function errorAt(message: string, line = 1, column = 1): Diagnostic {
  return {
    severity: "error",
    message,
    span: { offset: 0, endOffset: 0, start: { line, column }, end: { line, column } },
  };
}

/**
 * A compiler + a `dispose` spy, matching the `VerifyCompiler` seam the panel
 * drives. `diagnose` decides whether a given source compiles clean (the real
 * server compiler resolves `@preview/cetz`; the fake just inspects the string).
 */
class FakeCompiler implements VerifyCompiler {
  calls = 0;
  disposed = 0;
  constructor(private readonly diagnose: (source: string) => Diagnostic[] = () => []) {}
  async check(source: string): Promise<CheckResult> {
    this.calls += 1;
    const diagnostics = this.diagnose(source);
    const ok = !diagnostics.some((d) => d.severity === "error");
    return { ok, diagnostics, pageCount: ok ? 1 : null, durationMs: 0 };
  }
  dispose() {
    this.disposed += 1;
  }
}

const CETZ = `#import "@preview/cetz:0.2.2"\n#cetz.canvas({ circle((0, 0)) })`;
const BROKEN = `#cetz.canvas({ BROKEN })`;
const brokenDiagnose = (src: string) =>
  src.includes("BROKEN") ? [errorAt("unexpected token BROKEN", 1, 1)] : [];

// ── verifyStatusLabel (pure wording the panel renders) ──────────────────────

describe("verifyStatusLabel (#8)", () => {
  it("reports a clean server-side compile", () => {
    const label = verifyStatusLabel({ ok: true, diagnostics: [] });
    expect(label).toContain("Verified");
    expect(label).toContain("compiles cleanly");
  });

  it("reports the diagnostic count when verification fails (pluralized)", () => {
    const label = verifyStatusLabel({ ok: false, diagnostics: [errorAt("a"), errorAt("b")] });
    expect(label).toContain("Did not compile");
    expect(label).toContain("2 diagnostics");
  });

  it("singularizes a single-diagnostic failure", () => {
    const label = verifyStatusLabel({ ok: false, diagnostics: [errorAt("a")] });
    expect(label).toContain("1 diagnostic");
    expect(label).not.toContain("1 diagnostics");
  });
});

// ── runFigureVerify — the panel's verify orchestration ──────────────────────

describe("runFigureVerify (#8)", () => {
  it("returns ok:true with no diagnostics when the server compiler resolves CeTZ cleanly", async () => {
    const compiler = new FakeCompiler(brokenDiagnose);
    const state = await runFigureVerify(CETZ, compiler);
    expect(state.ok).toBe(true);
    expect(state.diagnostics).toEqual([]);
    expect(compiler.calls).toBe(1);
    expect(verifyStatusLabel(state)).toContain("Verified");
  });

  it("surfaces diagnostics when the snippet does not compile", async () => {
    const compiler = new FakeCompiler(brokenDiagnose);
    const state = await runFigureVerify(BROKEN, compiler);
    expect(state.ok).toBe(false);
    expect(state.diagnostics.length).toBeGreaterThan(0);
    expect(verifyStatusLabel(state)).toContain("Did not compile");
  });

  it("compiles exactly the snippet it is given (no rewriting)", async () => {
    let seen = "";
    const compiler = new FakeCompiler((src) => {
      seen = src;
      return [];
    });
    await runFigureVerify(CETZ, compiler);
    expect(seen).toBe(CETZ);
  });
});

/**
 * The verify factory is lazy + single-shot per panel session, and the panel
 * disposes the compiler on close/unmount. We model that exact lifecycle here
 * (the component holds the same `verifyCompilerRef`-then-`dispose` discipline as
 * ImportPanel's repair compiler) so the contract is pinned without a DOM.
 */
describe("verify compiler lifecycle (#8)", () => {
  it("a factory builds one compiler that the panel can reuse across verifies and dispose once", async () => {
    const built: FakeCompiler[] = [];
    const factory: VerifyCompilerFactory = async () => {
      const c = new FakeCompiler(brokenDiagnose);
      built.push(c);
      return c;
    };

    // First verify lazily builds the compiler… (the factory's declared return is
    // the VerifyCompiler seam; narrow back to FakeCompiler to read its spy fields).
    const compiler = (await factory()) as FakeCompiler;
    await runFigureVerify(BROKEN, compiler);
    // …a second verify reuses the same instance (the panel caches it in a ref).
    await runFigureVerify(CETZ, compiler);

    expect(built).toHaveLength(1);
    expect(compiler.calls).toBe(2);

    // On close/unmount the panel disposes it; the dispose is null-guarded so a
    // compiler that never built (no verify ran) is a no-op.
    compiler.dispose?.();
    expect(compiler.disposed).toBe(1);
  });

  it("dispose is optional on the VerifyCompiler seam (null-guarded by the panel)", async () => {
    // A minimal AgentCompiler with NO dispose still satisfies the seam; the
    // panel's `verifyCompilerRef.current?.dispose?.()` must not throw.
    const minimal: AgentCompiler = {
      check: async (): Promise<CheckResult> => ({ ok: true, diagnostics: [], pageCount: 1, durationMs: 0 }),
    };
    const asVerify = minimal as VerifyCompiler;
    expect(() => asVerify.dispose?.()).not.toThrow();
    const state = await runFigureVerify(CETZ, asVerify);
    expect(state.ok).toBe(true);
  });
});

/**
 * Backward-compat proof. The verify step is purely additive: `runFigureVerify`
 * and the verify seam are ONLY exercised when the host passes the OPTIONAL
 * `verifyCompilerFactory` prop. The two existing shell call sites (App /
 * ProjectApp) pass only `{ open, onClose, model, currentSource, onInsert }`, so
 * the offline generate → "could not verify" → reviewable-diff flow is untouched.
 * The no-button-when-absent guard is the component reading
 * `verifyCompilerFactory && (…)`, asserted at the DOM level by Lane F's e2e.
 */
describe("FigurePanel backward-compat (#8)", () => {
  it("the verify helpers are inert until a compiler is actually supplied", async () => {
    // With no factory, the panel never calls runFigureVerify — modeled here by
    // simply not invoking it; the offline status string is the pre-#8 behavior.
    // We assert the helper itself is side-effect-free given a fresh compiler so a
    // first (optional) verify never carries stale state.
    const compiler = new FakeCompiler(brokenDiagnose);
    expect(compiler.calls).toBe(0);
    const state = await runFigureVerify(CETZ, compiler);
    expect(state).toEqual({ ok: true, diagnostics: [] });
  });
});
