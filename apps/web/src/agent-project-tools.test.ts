/**
 * Roadmap #3 — web ProjectToolsSeam tests: call-time freshness (the seam reads
 * the LIVE project, never a captured copy), path-slash tolerance, and search
 * delegation to the existing `searchProjectFiles` semantics.
 */
import { describe, it, expect } from "vitest";
import { buildProjectToolsSeam } from "./agent-project-tools.js";
import type { SearchInputFile } from "./project-search.js";

const FILES: SearchInputFile[] = [
  { fileId: "f1", path: "/main.typ", text: "= Intro\nSee the appendix.\n" },
  { fileId: "f2", path: "/appendix.typ", text: "= Appendix\nDetails live here.\n" },
];

describe("buildProjectToolsSeam", () => {
  it("lists file identities only (no contents ride along)", () => {
    const seam = buildProjectToolsSeam(() => FILES);
    expect(seam.listFiles()).toEqual([
      { fileId: "f1", path: "/main.typ" },
      { fileId: "f2", path: "/appendix.typ" },
    ]);
  });

  it("reads a file by exact path, tolerating a missing leading slash", () => {
    const seam = buildProjectToolsSeam(() => FILES);
    expect(seam.readFile("/appendix.typ")).toBe("= Appendix\nDetails live here.\n");
    expect(seam.readFile("appendix.typ")).toBe("= Appendix\nDetails live here.\n");
    expect(seam.readFile("/nope.typ")).toBeNull();
    // No fuzzy matching: a partial path is NOT a hit.
    expect(seam.readFile("/appendix")).toBeNull();
  });

  it("reads the project as it exists AT CALL TIME (multi-file awareness)", () => {
    const live = [...FILES];
    const seam = buildProjectToolsSeam(() => live);
    expect(seam.listFiles()).toHaveLength(2);
    expect(seam.readFile("/glossary.typ")).toBeNull();
    // A file added (or changed) AFTER the seam was built is visible: the seam
    // holds a reader, not a snapshot.
    live.push({ fileId: "f3", path: "/glossary.typ", text: "= Glossary\n" });
    live[0] = { ...live[0]!, text: "= Intro v2\n" };
    expect(seam.listFiles()).toHaveLength(3);
    expect(seam.readFile("/glossary.typ")).toBe("= Glossary\n");
    expect(seam.readFile("/main.typ")).toBe("= Intro v2\n");
  });

  it("searches with searchProjectFiles semantics (literal, case-insensitive)", () => {
    const seam = buildProjectToolsSeam(() => FILES);
    const result = seam.search("APPENDIX");
    expect(result.totalMatches).toBe(2);
    expect(result.files.map((f) => f.path)).toEqual(["/main.typ", "/appendix.typ"]);
    // Literal: a regex metacharacter is taken verbatim, never compiled.
    expect(seam.search("a.pendix").totalMatches).toBe(0);
    expect(seam.search("   ").totalMatches).toBe(0);
  });
});
