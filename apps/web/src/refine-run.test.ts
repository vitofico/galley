import { describe, it, expect } from "vitest";
import { buildRefineRun } from "./refine-run.js";

describe("buildRefineRun (11.8c refine the pending proposal)", () => {
  it("feeds the pending proposal's finalSource back as the new base", () => {
    const pending = "= Title\n\nBody with a Demo Section.\n";
    const args = buildRefineRun(pending, "make it shorter");
    expect(args).toEqual({ request: "make it shorter", baseSource: pending });
  });

  it("trims the instruction", () => {
    const args = buildRefineRun("doc", "  more formal  ");
    expect(args).toEqual({ request: "more formal", baseSource: "doc" });
  });

  it("returns null for an empty / whitespace-only instruction (no-op)", () => {
    expect(buildRefineRun("doc", "")).toBeNull();
    expect(buildRefineRun("doc", "   ")).toBeNull();
    expect(buildRefineRun("doc", "\n\t")).toBeNull();
  });

  it("is chain-safe: re-refining uses the LATEST proposal as the base", () => {
    const first = buildRefineRun("v1", "shorter");
    expect(first?.baseSource).toBe("v1");
    // The next refine starts from the latest proposal's final source ("v2"),
    // not the original — so the chain's base keeps moving forward.
    const second = buildRefineRun("v2", "more formal");
    expect(second?.baseSource).toBe("v2");
    expect(second?.request).toBe("more formal");
  });
});
