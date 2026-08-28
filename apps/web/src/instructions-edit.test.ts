import { describe, it, expect } from "vitest";
import { parseInstructions } from "@galley/agent";
import {
  INSTRUCTIONS_SEED,
  INSTRUCTIONS_CANONICAL_PATH,
  findInstructionsFile,
  findAllInstructionsFiles,
  readInstructionsText,
  type InstructionsEditFile,
} from "./instructions-edit.js";

const file = (
  fileId: string,
  path: string,
  text: string,
  deleted = false,
): InstructionsEditFile => ({ fileId, path, text, deleted });

describe("instructions-edit helpers (14-D authoring)", () => {
  it("INSTRUCTIONS_SEED parses warning-free with real steering + a valid constraint", () => {
    const parsed = parseInstructions(INSTRUCTIONS_SEED);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.steering.length).toBeGreaterThan(0);
    expect(parsed.constraints?.maxWords).toBe(800);
  });

  it("the canonical path is the leading-slash reserved form", () => {
    expect(INSTRUCTIONS_CANONICAL_PATH).toBe("/.galley/instructions");
  });

  it("finds the live instructions file (canonical preferred over relative)", () => {
    const files = [
      file("m", "/main.typ", "x"),
      file("rel", ".galley/instructions", "relative"),
      file("can", "/.galley/instructions", "canonical"),
    ];
    expect(findInstructionsFile(files)).toEqual({ fileId: "can", path: "/.galley/instructions" });
    expect(readInstructionsText(files)).toBe("canonical");
  });

  it("falls back to the relative form when only it is live", () => {
    const files = [file("rel", ".galley/instructions", "relative")];
    expect(findInstructionsFile(files)).toEqual({ fileId: "rel", path: ".galley/instructions" });
    expect(readInstructionsText(files)).toBe("relative");
  });

  it("treats a tombstoned file as absent", () => {
    const files = [file("can", "/.galley/instructions", "gone", true)];
    expect(findInstructionsFile(files)).toBeUndefined();
    expect(readInstructionsText(files)).toBeUndefined();
  });

  it("returns undefined / empty when no instructions file exists", () => {
    const files = [file("m", "/main.typ", "x")];
    expect(findInstructionsFile(files)).toBeUndefined();
    expect(readInstructionsText(files)).toBeUndefined();
    expect(findAllInstructionsFiles(files)).toEqual([]);
  });

  it("lists ALL live instructions files in preference order (for duplicate coalescing)", () => {
    const files = [
      file("can1", "/.galley/instructions", "a"),
      file("can2", "/.galley/instructions", "b"),
      file("rel", ".galley/instructions", "c"),
      file("dead", "/.galley/instructions", "d", true), // tombstoned, excluded
    ];
    const all = findAllInstructionsFiles(files);
    expect(all.map((f) => f.fileId)).toEqual(["can1", "can2", "rel"]);
    // The reader / findInstructionsFile picks the first by preference order.
    expect(findInstructionsFile(files)!.fileId).toBe("can1");
  });
});
