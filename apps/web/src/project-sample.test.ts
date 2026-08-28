import { describe, it, expect } from "vitest";
import {
  BLANK_STARTER_FILES,
  BLANK_STARTER_MAIN,
  SAMPLE_PROJECT_FILES,
  SAMPLE_PROJECT_MAIN,
} from "./project-sample.js";
import { DEMO_FILES, DEMO_MAIN } from "./demo/einstein-1905.js";

/**
 * #20.2 seed flip: the default seed IS the "Annus Mirabilis" demo workspace.
 * Pins the indirection so a future edit can't silently fork the fresh-boot
 * content from the demo module (compile-gated in einstein-1905.compile.test.ts).
 */
describe("project-sample (#20.2 seed flip)", () => {
  it("re-exports the Einstein demo workspace as the default seed", () => {
    expect(SAMPLE_PROJECT_FILES).toBe(DEMO_FILES);
    expect(SAMPLE_PROJECT_MAIN).toBe(DEMO_MAIN);
  });

  it("seeds the styleable 1905 tree with /main.typ as the entry file", () => {
    // Eight files: the desk plus the swappable `/style.typ` that makes the demo
    // conforming for the Style Library (styles Phase 1.5).
    expect(SAMPLE_PROJECT_FILES).toHaveLength(8);
    expect(SAMPLE_PROJECT_MAIN).toBe("/main.typ");
    expect(SAMPLE_PROJECT_FILES.map((f) => f.path)).toEqual([
      "/main.typ",
      "/style.typ",
      "/photoelectric.typ",
      "/brownian.typ",
      "/relativity.typ",
      "/spacetime.typ",
      "/marginalia.typ",
      "/refs.bib",
    ]);
    expect(SAMPLE_PROJECT_FILES[0]!.text).toContain("Annus Mirabilis");
  });
});

describe("blank starter (project-model redesign §1)", () => {
  it("is a single /main.typ file", () => {
    expect(BLANK_STARTER_FILES).toHaveLength(1);
    expect(BLANK_STARTER_MAIN).toBe("/main.typ");
    expect(BLANK_STARTER_FILES[0]!.path).toBe("/main.typ");
  });

  it("uses a valid leading-slash path", () => {
    expect(BLANK_STARTER_FILES[0]!.path.startsWith("/")).toBe(true);
  });

  it("has non-empty main content so it compiles immediately", () => {
    expect(BLANK_STARTER_FILES[0]!.text.trim().length).toBeGreaterThan(0);
  });
});
