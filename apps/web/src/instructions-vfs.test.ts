import { describe, expect, it } from "vitest";
import { readProjectInstructions, INSTRUCTIONS_PATHS } from "./instructions-vfs.js";

/** A minimal snapshot-file shape (the subset the helper reads). */
function f(path: string, text: string, deleted = false) {
  return { fileId: `id-${path}`, path, text, deleted };
}

describe("readProjectInstructions", () => {
  it("returns undefined when no .galley/instructions file exists", () => {
    const files = [f("/main.typ", "= Title\nbody"), f("/refs.bib", "@book{x}")];
    expect(readProjectInstructions(files)).toBeUndefined();
  });

  it("returns undefined for an empty file list", () => {
    expect(readProjectInstructions([])).toBeUndefined();
  });

  it("parses steering prose and constraints from the canonical leading-slash path", () => {
    const text = [
      "Write in a formal academic voice. Cite every claim.",
      "",
      "## Constraints",
      "max-words: 800",
      "required-section: Introduction",
      'forbidden-word: "utilize"',
    ].join("\n");
    const files = [f("/main.typ", "body"), f("/.galley/instructions", text)];

    const out = readProjectInstructions(files);
    expect(out).toBeDefined();
    expect(out!.steering).toContain("formal academic voice");
    expect(out!.constraints).toBeDefined();
    expect(out!.constraints!.maxWords).toBe(800);
    expect(out!.constraints!.requiredSections).toEqual(["Introduction"]);
    expect(out!.constraints!.forbiddenWords).toEqual(["utilize"]);
  });

  it("also accepts the relative (materialized) path form", () => {
    const text = "Steer me.\n\n## Constraints\nmax-words: 100";
    const files = [f(".galley/instructions", text)];
    const out = readProjectInstructions(files);
    expect(out).toBeDefined();
    expect(out!.constraints!.maxWords).toBe(100);
  });

  it("ignores a soft-deleted instructions file (tombstone => OFF)", () => {
    const text = "Steer me.\n\n## Constraints\nmax-words: 100";
    const files = [f("/.galley/instructions", text, true)];
    expect(readProjectInstructions(files)).toBeUndefined();
  });

  it("returns undefined for an empty / whitespace-only file (no steering, no constraints)", () => {
    expect(readProjectInstructions([f("/.galley/instructions", "")])).toBeUndefined();
    expect(readProjectInstructions([f("/.galley/instructions", "   \n\n  ")])).toBeUndefined();
  });

  it("does not throw on garbage; returns undefined when it yields no steering or constraints", () => {
    // A Constraints section with only malformed lines yields an inert (empty)
    // constraints object and no steering => OFF.
    const text = "## Constraints\nthis is not a key value line\nmax-words: not-a-number";
    expect(readProjectInstructions([f("/.galley/instructions", text)])).toBeUndefined();
  });

  it("returns instructions when ONLY steering prose is present (no constraints section)", () => {
    const files = [f("/.galley/instructions", "Always answer in British English.")];
    const out = readProjectInstructions(files);
    expect(out).toBeDefined();
    expect(out!.steering).toBe("Always answer in British English.");
    expect(out!.constraints).toBeUndefined();
  });

  it("drops an inert constraints object (a Constraints heading with no usable keys) when steering is present", () => {
    const text = "Steer prose here.\n\n## Constraints\n";
    const out = readProjectInstructions([f("/.galley/instructions", text)]);
    expect(out).toBeDefined();
    expect(out!.steering).toBe("Steer prose here.");
    expect(out!.constraints).toBeUndefined();
  });

  it("accepts a path->text map as input as well as a file array", () => {
    const out = readProjectInstructions({
      "/.galley/instructions": "Steer.\n\n## Constraints\nmin-words: 50",
    });
    expect(out).toBeDefined();
    expect(out!.constraints!.minWords).toBe(50);
  });

  it("prefers the first live match deterministically when both path forms exist", () => {
    const files = [
      f("/.galley/instructions", "## Constraints\nmax-words: 1"),
      f(".galley/instructions", "## Constraints\nmax-words: 2"),
    ];
    const out = readProjectInstructions(files);
    expect(out!.constraints!.maxWords).toBe(1);
  });

  it("exposes the canonical paths it looks for", () => {
    expect(INSTRUCTIONS_PATHS).toContain("/.galley/instructions");
    expect(INSTRUCTIONS_PATHS).toContain(".galley/instructions");
  });
});
