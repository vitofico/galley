import { describe, it, expect } from "vitest";
import { CollabProject, materializeProject } from "@galley/collab";
import type { Author, VersionedFile } from "@galley/shared";
import { restoreProjectFromTree } from "./project-session.js";

/**
 * #12.6 restore-as-CRDT-transaction: restoring a saved version tree onto a live
 * project reverts/creates/soft-deletes files as explicit CRDT ops (never a
 * destructive wipe), all offline + deterministic.
 */
const HUMAN: Author = { kind: "human", userId: "me" };

function treeOf(p: CollabProject): VersionedFile[] {
  const out = materializeProject(p.snapshot());
  if (!out.ok) throw new Error(`materialize failed: ${out.reason}`);
  return out.result.files;
}

describe("restoreProjectFromTree (#12.6)", () => {
  it("reverts edited file content to the saved version", () => {
    const p = new CollabProject();
    p.seedIfPristine([{ path: "/main.typ", text: "= V1\n\nHello." }], "/main.typ", HUMAN);
    const v1 = treeOf(p);

    const mainId = p.mainFileId()!;
    p.transactFile(
      mainId,
      (t) => {
        t.delete(0, t.length);
        t.insert(0, "= V2\n\nChanged.");
      },
      HUMAN,
    );
    expect(p.getFile(mainId)!.text).toContain("V2");

    restoreProjectFromTree(p, v1, HUMAN);
    expect(p.getFile(mainId)!.text).toBe("= V1\n\nHello.");
  });

  it("recreates a file the version had and soft-deletes one it didn't", () => {
    const p = new CollabProject();
    p.seedIfPristine(
      [
        { path: "/main.typ", text: "main" },
        { path: "/a.typ", text: "A" },
      ],
      "/main.typ",
      HUMAN,
    );
    const v1 = treeOf(p);

    const aId = p.snapshot().files.find((f) => f.path === "/a.typ")!.fileId;
    p.delete(aId, HUMAN);
    p.create("/b.typ", "B", HUMAN);

    restoreProjectFromTree(p, v1, HUMAN);
    const livePaths = p
      .snapshot()
      .files.filter((f) => !f.deleted)
      .map((f) => f.path)
      .sort();
    expect(livePaths).toEqual(["/a.typ", "/main.typ"]); // b soft-deleted, a restored
  });

  it("preserves a live reserved .galley/instructions file across a materialize→restore round-trip (14-D)", () => {
    // materializeProject filters `.galley/*` out of the tree, so a restored
    // version never lists it; restore MUST NOT tombstone it as a result.
    const p = new CollabProject();
    p.seedIfPristine([{ path: "/main.typ", text: "main" }], "/main.typ", HUMAN);
    p.create("/.galley/instructions", "Write tersely.", HUMAN);
    const v1 = treeOf(p); // tree excludes the reserved file (Part A)
    expect(v1.some((f) => f.path === ".galley/instructions")).toBe(false);

    restoreProjectFromTree(p, v1, HUMAN);

    const live = p.snapshot().files.filter((f) => !f.deleted);
    const instr = live.find((f) => f.path === "/.galley/instructions");
    expect(instr).toBeDefined();
    expect(p.getFile(instr!.fileId)!.text).toBe("Write tersely.");
  });

  it("restores a tree-carried .galley/instructions through the coalescing seam (export round-trip)", () => {
    // EXPORT side: opt the instructions into the tree (what the bundle/git-repo/
    // remote-push surfaces do). IMPORT side: restoring that tree into a FRESH
    // project recreates the config — the full round-trip.
    const source = new CollabProject();
    source.seedIfPristine([{ path: "/main.typ", text: "= Doc" }], "/main.typ", HUMAN);
    source.create("/.galley/instructions", "Write tersely.", HUMAN);
    const out = materializeProject(source.snapshot(), { includeInstructions: true });
    if (!out.ok) throw new Error(`materialize failed: ${out.reason}`);
    const tree = out.result.files;
    expect(tree.some((f) => f.path === ".galley/instructions")).toBe(true);

    const target = new CollabProject();
    target.seedIfPristine([{ path: "/main.typ", text: "old" }], "/main.typ", HUMAN);
    restoreProjectFromTree(target, tree, HUMAN);

    const live = target.snapshot().files.filter((f) => !f.deleted);
    const instr = live.filter(
      (f) => f.path === "/.galley/instructions" || f.path === ".galley/instructions",
    );
    expect(instr).toHaveLength(1);
    expect(instr[0]!.path).toBe("/.galley/instructions"); // canonical, never the raw tree path
    expect(instr[0]!.text).toBe("Write tersely.");

    // Idempotent: importing the same tree again neither duplicates nor edits.
    restoreProjectFromTree(target, tree, HUMAN);
    const again = target
      .snapshot()
      .files.filter((f) => !f.deleted && f.path === "/.galley/instructions");
    expect(again).toHaveLength(1);
    expect(again[0]!.text).toBe("Write tersely.");
  });

  it("a tree-carried instructions file UPDATES (not duplicates) the project's existing one", () => {
    const p = new CollabProject();
    p.seedIfPristine([{ path: "/main.typ", text: "= Doc" }], "/main.typ", HUMAN);
    const id = p.create("/.galley/instructions", "Local steering.", HUMAN);

    restoreProjectFromTree(
      p,
      [
        { path: "main.typ", text: "= Doc" },
        { path: ".galley/instructions", text: "Remote steering." },
      ],
      HUMAN,
    );

    const live = p
      .snapshot()
      .files.filter((f) => !f.deleted && f.path === "/.galley/instructions");
    expect(live).toHaveLength(1);
    expect(live[0]!.fileId).toBe(id); // coalesced in-place edit, not a raw create
    expect(live[0]!.text).toBe("Remote steering.");
  });

  it("fences unknown reserved .galley/* tree entries out of the restore (never raw-created)", () => {
    // A hostile/foreign tree (e.g. a hand-edited remote repo) must not be able to
    // plant arbitrary files in the reserved namespace via restore.
    const p = new CollabProject();
    p.seedIfPristine([{ path: "/main.typ", text: "= Doc" }], "/main.typ", HUMAN);

    restoreProjectFromTree(
      p,
      [
        { path: "main.typ", text: "= Doc" },
        { path: ".galley/evil", text: "nope" },
        { path: "/.galley/project.json", text: "{}" }, // leading-slash manifest form
      ],
      HUMAN,
    );

    const reserved = p
      .snapshot()
      .files.filter((f) => !f.deleted && f.path.replace(/^\//, "").startsWith(".galley/"));
    expect(reserved).toHaveLength(0);
  });

  it("drops non-normalized / unsafe tree paths entirely (no reserved-fence bypass, no poisoning)", () => {
    // A remote-controlled fetch candidate could carry paths that dodge the
    // first-segment reserved check (`./.galley/…`, `//.galley/…`) or are
    // outright unsafe (traversal, backslash, control chars). NONE of these may
    // be created into the CRDT — they'd be unexportable and break the projection.
    const p = new CollabProject();
    p.seedIfPristine([{ path: "/main.typ", text: "= Doc" }], "/main.typ", HUMAN);

    restoreProjectFromTree(
      p,
      [
        { path: "main.typ", text: "= Doc" },
        { path: "./.galley/evil", text: "nope" },
        { path: "//.galley/evil2", text: "nope" },
        { path: "../escape.typ", text: "nope" },
        { path: "a\\b.typ", text: "nope" },
        { path: "ctl\u0007.typ", text: "nope" },
      ],
      HUMAN,
    );

    const livePaths = p
      .snapshot()
      .files.filter((f) => !f.deleted)
      .map((f) => f.path);
    expect(livePaths).toEqual(["/main.typ"]);
  });

  it("re-points main from the version manifest by path", () => {
    const p = new CollabProject();
    p.seedIfPristine(
      [
        { path: "/main.typ", text: "m" },
        { path: "/intro.typ", text: "i" },
      ],
      "/main.typ",
      HUMAN,
    );
    const v1 = treeOf(p);

    const introId = p.snapshot().files.find((f) => f.path === "/intro.typ")!.fileId;
    p.setMain(introId, HUMAN);
    expect(p.snapshot().mainFileId).toBe(introId);

    restoreProjectFromTree(p, v1, HUMAN);
    const mainPath = p.snapshot().files.find((f) => f.fileId === p.mainFileId())!.path;
    expect(mainPath).toBe("/main.typ");
  });
});
