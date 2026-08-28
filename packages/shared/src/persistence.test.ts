import { describe, it, expect } from "vitest";
import { isSafeProjectPath, isReservedProjectPath } from "./persistence.js";

describe("isReservedProjectPath (14-D)", () => {
  it("is true for the .galley namespace in canonical (leading-slash) form", () => {
    expect(isReservedProjectPath("/.galley/instructions")).toBe(true);
    expect(isReservedProjectPath("/.galley/project.json")).toBe(true);
    expect(isReservedProjectPath("/.galley")).toBe(true);
  });

  it("is true for the .galley namespace in relative (materialized) form", () => {
    expect(isReservedProjectPath(".galley/instructions")).toBe(true);
    expect(isReservedProjectPath(".galley/project.json")).toBe(true);
    expect(isReservedProjectPath(".galley")).toBe(true);
  });

  it("is false for ordinary user files (either form)", () => {
    expect(isReservedProjectPath("/main.typ")).toBe(false);
    expect(isReservedProjectPath("main.typ")).toBe(false);
    expect(isReservedProjectPath("/chapters/one.typ")).toBe(false);
    expect(isReservedProjectPath("/galley/notes.typ")).toBe(false); // not .galley
    expect(isReservedProjectPath("/a.galley/x")).toBe(false); // first segment differs
  });
});

describe("isSafeProjectPath stays unchanged (still rejects .galley + unsafe)", () => {
  it("rejects the reserved namespace and traversal/control-char paths", () => {
    expect(isSafeProjectPath("/.galley/instructions")).toBe(false);
    expect(isSafeProjectPath("/../escape.typ")).toBe(false);
    expect(isSafeProjectPath("/a\\b.typ")).toBe(false);
    expect(isSafeProjectPath("/a/b.typ")).toBe(false); // control char
  });

  it("accepts ordinary in-tree paths", () => {
    expect(isSafeProjectPath("/main.typ")).toBe(true);
    expect(isSafeProjectPath("/chapters/one.typ")).toBe(true);
  });
});
