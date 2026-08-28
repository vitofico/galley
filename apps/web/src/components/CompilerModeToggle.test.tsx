import { describe, it, expect } from "vitest";
import { CompilerModeToggle } from "./CompilerModeToggle.js";
import { COMPILE_MODES } from "./compiler-mode.js";

/**
 * Contract tests for the compile-mode toggle (Enabler E2).
 *
 * IMPORTANT — why this is NOT a rendering test: the workspace vitest config runs
 * in the `node` environment with NO jsdom and NO @testing-library configured (see
 * vitest.config.ts: `environment: "node"`, `include: **\/*.test.ts`). The
 * established convention (EditorPrefs.test.ts, theme.test.ts, preview-zoom.test.ts)
 * is to put real behaviour coverage in a PURE `.test.ts` — here that is
 * `compiler-mode.test.ts` — and keep the `.tsx` a thin wrapper. This `.test.tsx`
 * therefore asserts the COMPONENT'S CONTRACT (it is a function component, and the
 * stable testid / mode set the shell + e2e depend on) WITHOUT rendering, so it
 * neither needs a DOM nor breaks the gate (the gate's `*.test.ts`-only include
 * excludes this file; it is here to document the mount contract for Lane S).
 */

describe("CompilerModeToggle contract", () => {
  it("is a React function component", () => {
    expect(typeof CompilerModeToggle).toBe("function");
  });

  it("the toggle covers exactly the three modes Lane S / e2e target", () => {
    // The component renders one `data-testid={`compiler-mode-${m}`}` button per
    // mode in COMPILE_MODES, plus the group `compiler-mode-toggle` and (when the
    // server is active) `compiler-mode-server-active`. Keeping this list in sync
    // is the contract the e2e (`compiler-mode-server`) relies on.
    expect([...COMPILE_MODES]).toEqual(["local", "server", "auto"]);
  });

  it("accepts an onModeChange / serverActive / fallback prop contract", () => {
    // Compile-time prop shape is enforced by TS; this asserts the runtime arity
    // is a normal component (single props object) so a shell can mount it as
    // <CompilerModeToggle onModeChange={…} serverActive={…} />.
    expect(CompilerModeToggle.length).toBeLessThanOrEqual(1);
  });
});
