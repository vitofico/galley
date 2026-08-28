import { describe, it, expect } from "vitest";
import {
  draftToProjectSnapshot,
  DEFAULT_DRAFT_PATH,
  DEFAULT_DRAFT_FILE_ID,
} from "./unify.js";
import { materializeProject, PROJECT_MANIFEST_PATH } from "./materialize.js";

describe("roadmap #14 seed — draftToProjectSnapshot", () => {
  it("wraps a draft into a one-file snapshot whose only file is main", () => {
    const snap = draftToProjectSnapshot("= Hi\n\nbody");
    expect(snap.files).toHaveLength(1);
    expect(snap.files[0]).toEqual({
      fileId: DEFAULT_DRAFT_FILE_ID,
      path: DEFAULT_DRAFT_PATH,
      text: "= Hi\n\nbody",
      deleted: false,
    });
    expect(snap.mainFileId).toBe(DEFAULT_DRAFT_FILE_ID);
    expect(snap.duplicatePaths).toEqual([]);
  });

  it("is deterministic and honors path/fileId overrides", () => {
    const a = draftToProjectSnapshot("x", { path: "/thesis.typ", fileId: "f1" });
    const b = draftToProjectSnapshot("x", { path: "/thesis.typ", fileId: "f1" });
    expect(a).toEqual(b);
    expect(a.files[0]!.path).toBe("/thesis.typ");
    expect(a.mainFileId).toBe("f1");
  });

  it("preserves an empty draft (becomes an empty one-file project)", () => {
    const snap = draftToProjectSnapshot("");
    expect(snap.files[0]!.text).toBe("");
    expect(snap.mainFileId).toBe(DEFAULT_DRAFT_FILE_ID);
  });

  it("composes with the #4 projection: materializes to a one-file tree + manifest", () => {
    const snap = draftToProjectSnapshot("= Draft\n", { path: "/main.typ" });
    const outcome = materializeProject(snap);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The lone draft file + the project manifest.
    const paths = outcome.result.files.map((f) => f.path).sort();
    expect(paths).toContain("main.typ");
    expect(paths).toContain(PROJECT_MANIFEST_PATH);
    // The manifest records the draft file as the project's single live file + main.
    expect(outcome.result.manifest.files).toEqual([
      { path: "/main.typ", fileId: DEFAULT_DRAFT_FILE_ID },
    ]);
    expect(outcome.result.manifest.main).toBe("/main.typ");
  });
});
