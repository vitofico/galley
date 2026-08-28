import { describe, it, expect } from "vitest";
import { ADJECTIVES, NOUNS, randomProjectName } from "./random-project-name.js";

describe("randomProjectName (project-model redesign §4)", () => {
  it("returns an adjective-noun slug (exactly one hyphen, no whitespace)", () => {
    const name = randomProjectName(() => 0);
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
    expect(name.split("-")).toHaveLength(2);
    expect(name).not.toMatch(/\s/);
    expect(name.length).toBeGreaterThan(0);
  });

  it("draws the adjective then the noun from the curated lists", () => {
    // RNG yields 0 → first element of each list.
    expect(randomProjectName(() => 0)).toBe(`${ADJECTIVES[0]}-${NOUNS[0]}`);
  });

  it("is deterministic for a given RNG (injectable for tests)", () => {
    const seq = [0.5, 0.9];
    const rng = () => seq.shift() ?? 0;
    const adj = ADJECTIVES[Math.floor(0.5 * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(0.9 * NOUNS.length)];
    expect(randomProjectName(rng)).toBe(`${adj}-${noun}`);
  });

  it("has non-trivial, hyphen-free, lowercase word lists", () => {
    expect(ADJECTIVES.length).toBeGreaterThanOrEqual(12);
    expect(NOUNS.length).toBeGreaterThanOrEqual(12);
    for (const w of [...ADJECTIVES, ...NOUNS]) {
      expect(w).toMatch(/^[a-z]+$/);
    }
  });

  it("produces a healthy spread of names over a sampled run (low collision)", () => {
    const names = new Set<string>();
    let s = 12345;
    // A small deterministic LCG so the sample is reproducible.
    const rng = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    for (let i = 0; i < 200; i++) names.add(randomProjectName(rng));
    // With 36*33 = 1188 combinations, 200 draws should yield many distinct names.
    expect(names.size).toBeGreaterThan(100);
  });
});
