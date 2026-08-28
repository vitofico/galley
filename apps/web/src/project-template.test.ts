import { describe, it, expect } from "vitest";
import { CollabProject, materializeProject } from "@galley/collab";
import type { Author, VersionedFile } from "@galley/shared";
import { instantiateTemplate, type ProjectTemplate } from "./project-template.js";

/**
 * #2 instantiate-as-CRDT-transaction: applying a template onto a project creates
 * its files + sets main as explicit CRDT ops — cleanly SEEDING a fresh project,
 * and ADDITIVELY (never destructively) merging into a non-empty one. Offline +
 * deterministic (real yjs), mirroring restore-project.test.ts.
 */
const HUMAN: Author = { kind: "human", userId: "me" };

const TEMPLATE: ProjectTemplate = {
  files: [
    { path: "/main.typ", text: "= Report\n\n#include \"intro.typ\"" },
    { path: "/intro.typ", text: "== Intro\n\nHello." },
  ],
  main: "/main.typ",
};

function livePaths(p: CollabProject): string[] {
  return p
    .snapshot()
    .files.filter((f) => !f.deleted)
    .map((f) => f.path)
    .sort();
}

function mainPathOf(p: CollabProject): string | undefined {
  const id = p.mainFileId();
  return p.snapshot().files.find((f) => f.fileId === id)?.path;
}

function treeOf(p: CollabProject): VersionedFile[] {
  const out = materializeProject(p.snapshot());
  if (!out.ok) throw new Error(`materialize failed: ${out.reason}`);
  return out.result.files;
}

describe("instantiateTemplate (#2)", () => {
  it("seeds a fresh project: files + main appear, project compiles", () => {
    const p = new CollabProject();
    instantiateTemplate(p, TEMPLATE, HUMAN);

    expect(livePaths(p)).toEqual(["/intro.typ", "/main.typ"]);
    expect(mainPathOf(p)).toBe("/main.typ");

    // toProjectInput() is valid (main set, no duplicate paths, main not deleted).
    const input = p.toProjectInput();
    expect(input).not.toBeNull();
    expect(input!.main).toBe("/main.typ");
    expect(input!.files.map((f) => f.path).sort()).toEqual(["/intro.typ", "/main.typ"]);
    expect(input!.files.find((f) => f.path === "/intro.typ")!.text).toBe("== Intro\n\nHello.");
  });

  it("canonicalizes leading-slash-less template paths", () => {
    const p = new CollabProject();
    instantiateTemplate(
      p,
      { files: [{ path: "main.typ", text: "x" }], main: "main.typ" },
      HUMAN,
    );
    expect(livePaths(p)).toEqual(["/main.typ"]);
    expect(mainPathOf(p)).toBe("/main.typ");
  });

  it("is a no-op for a template with no files", () => {
    const p = new CollabProject();
    instantiateTemplate(p, { files: [], main: "/main.typ" }, HUMAN);
    expect(livePaths(p)).toEqual([]);
    expect(p.mainFileId()).toBeNull();
  });

  it("re-instantiating the SAME template into the seeded project is idempotent (no clobber, no duplicates)", () => {
    const p = new CollabProject();
    instantiateTemplate(p, TEMPLATE, HUMAN);
    const before = treeOf(p);

    // Second apply: now the doc has history, so it takes the additive path and
    // updates the existing files BY PATH rather than creating duplicates.
    instantiateTemplate(p, TEMPLATE, HUMAN);

    expect(livePaths(p)).toEqual(["/intro.typ", "/main.typ"]);
    expect(p.duplicatePaths()).toEqual([]);
    expect(treeOf(p)).toEqual(before);
  });

  it("applies additively into a NON-EMPTY project without destroying the user's files", () => {
    const p = new CollabProject();
    // A pre-existing project the user already started.
    p.seedIfPristine([{ path: "/notes.typ", text: "my notes" }], "/notes.typ", HUMAN);
    const notesId = p.snapshot().files.find((f) => f.path === "/notes.typ")!.fileId;

    instantiateTemplate(p, TEMPLATE, HUMAN);

    // Template files created, the user's file is preserved (not soft-deleted).
    expect(livePaths(p)).toEqual(["/intro.typ", "/main.typ", "/notes.typ"]);
    expect(p.getFile(notesId)).toMatchObject({ text: "my notes", deleted: false });
    // Main re-pointed to the template's main by path.
    expect(mainPathOf(p)).toBe("/main.typ");
  });

  it("updates an existing file BY PATH (minimal-diff) instead of duplicating it", () => {
    const p = new CollabProject();
    p.seedIfPristine([{ path: "/main.typ", text: "old main" }], "/main.typ", HUMAN);

    instantiateTemplate(p, TEMPLATE, HUMAN);

    // /main.typ updated in place (no duplicate path), /intro.typ created.
    expect(livePaths(p)).toEqual(["/intro.typ", "/main.typ"]);
    expect(p.duplicatePaths()).toEqual([]);
    const main = p.snapshot().files.find((f) => f.path === "/main.typ")!;
    expect(main.text).toBe("= Report\n\n#include \"intro.typ\"");
  });

  it("replace: switching templates soft-deletes the old files not in the new set (B5)", () => {
    const p = new CollabProject();
    // Seed an "Einstein-like" 7-file project (the orphan-prone case): main +
    // several papers + a bib. This is the additive seed (pristine), like a boot.
    const EINSTEIN: ProjectTemplate = {
      files: [
        { path: "/main.typ", text: "= Annus Mirabilis\n#include \"relativity.typ\"" },
        { path: "/relativity.typ", text: "== Relativity" },
        { path: "/brownian.typ", text: "== Brownian" },
        { path: "/photoelectric.typ", text: "== Photoelectric" },
        { path: "/spacetime.typ", text: "== Spacetime" },
        { path: "/marginalia.typ", text: "== Marginalia" },
        { path: "/refs.bib", text: "@book{e, title={E}}" },
      ],
      main: "/main.typ",
    };
    p.seedIfPristine(EINSTEIN.files, EINSTEIN.main, HUMAN);
    expect(livePaths(p)).toHaveLength(7);

    // Switch to the smaller two-file Article template WITH replace semantics.
    const ARTICLE: ProjectTemplate = {
      files: [
        { path: "/main.typ", text: "= Article\n#import \"/style.typ\": *" },
        { path: "/style.typ", text: "#let pkg() = none" },
      ],
      main: "/main.typ",
    };
    instantiateTemplate(p, ARTICLE, HUMAN, /* replace */ true);

    // (a) live files are EXACTLY the Article template's two files — no orphans.
    expect(livePaths(p)).toEqual(["/main.typ", "/style.typ"]);
    // (b) the five Einstein-only files are SOFT-deleted (history preserved).
    const all = p.snapshot().files;
    for (const orphan of ["/relativity.typ", "/brownian.typ", "/photoelectric.typ", "/spacetime.typ", "/marginalia.typ", "/refs.bib"]) {
      const row = all.find((f) => f.path === orphan);
      expect(row, `${orphan} must still exist as a tombstone`).toBeDefined();
      expect(row!.deleted, `${orphan} must be soft-deleted`).toBe(true);
    }
    // (c) main is the Article template's main, on a LIVE file.
    expect(mainPathOf(p)).toBe("/main.typ");
    // /main.typ was UPDATED in place (shared path), not duplicated.
    expect(p.duplicatePaths()).toEqual([]);
    const main = p.snapshot().files.find((f) => !f.deleted && f.path === "/main.typ")!;
    expect(main.text).toBe("= Article\n#import \"/style.typ\": *");
  });

  it("replace + EMPTY template clears the project (the blank 'Empty project' choice, B8)", () => {
    const p = new CollabProject();
    p.seedIfPristine(
      [
        { path: "/main.typ", text: "a" },
        { path: "/extra.typ", text: "b" },
      ],
      "/main.typ",
      HUMAN,
    );
    expect(livePaths(p)).toEqual(["/extra.typ", "/main.typ"]);

    // An empty template under REPLACE soft-deletes everything (clean slate).
    instantiateTemplate(p, { files: [], main: "/main.typ" }, HUMAN, /* replace */ true);

    expect(livePaths(p)).toEqual([]);
    // The cleared files are tombstones, not hard-destroyed.
    for (const f of p.snapshot().files) expect(f.deleted).toBe(true);
  });

  it("EMPTY template WITHOUT replace stays a no-op even on a non-empty project", () => {
    const p = new CollabProject();
    p.seedIfPristine([{ path: "/keep.typ", text: "x" }], "/keep.typ", HUMAN);
    instantiateTemplate(p, { files: [], main: "/keep.typ" }, HUMAN);
    expect(livePaths(p)).toEqual(["/keep.typ"]);
  });

  it("replace=false (default) stays additive — old files are NOT removed", () => {
    const p = new CollabProject();
    p.seedIfPristine([{ path: "/keep.typ", text: "mine" }], "/keep.typ", HUMAN);

    // Default (additive) instantiate leaves the user's file in place.
    instantiateTemplate(p, TEMPLATE, HUMAN);

    expect(livePaths(p)).toEqual(["/intro.typ", "/keep.typ", "/main.typ"]);
  });

  it("sets main by PATH even when main isn't the first template file", () => {
    const p = new CollabProject();
    instantiateTemplate(
      p,
      {
        files: [
          { path: "/a.typ", text: "a" },
          { path: "/cover.typ", text: "cover" },
        ],
        main: "/cover.typ",
      },
      HUMAN,
    );
    expect(mainPathOf(p)).toBe("/cover.typ");
  });
});
