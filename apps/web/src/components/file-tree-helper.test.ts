import { describe, it, expect } from "vitest";
import {
  buildFileTree,
  planFolderCreate,
  planFolderRename,
  FOLDER_STARTER_BASENAME,
  type TreeNode,
} from "./file-tree-helper.js";

/**
 * `file-tree-helper` is the PURE core of roadmap #12 folders. Folders are NOT a
 * new entity (ADR-0013): they are DERIVED from the `/`-delimited file paths. The
 * helpers here turn the flat keyed-file list into a nested folder/file tree and
 * plan the per-file re-paths that a folder rename expands to. No React, no DOM,
 * no CRDT — the ProjectApp shell renders the tree and drives the plan through the
 * existing `project.rename(fileId, newPath, HUMAN)` primitive.
 *
 * Path convention (matches the core's `canonicalizePath`): every path carries a
 * leading slash and uses `/` as the separator. A folder's `path` is its canonical
 * prefix WITHOUT a trailing slash (e.g. `/chapters`).
 */

/** Compact a tree to `name[/]` strings for terse structural assertions. */
function shape(nodes: TreeNode[]): unknown {
  return nodes.map((n) =>
    n.type === "folder" ? { [`${n.name}/`]: shape(n.children) } : n.name,
  );
}

describe("buildFileTree", () => {
  it("returns [] for empty input", () => {
    expect(buildFileTree([])).toEqual([]);
  });

  it("keeps root files flat (no phantom folder) and preserves their fileId+path", () => {
    const tree = buildFileTree([
      { fileId: "a", path: "/main.typ" },
      { fileId: "b", path: "/refs.bib" },
    ]);
    expect(tree).toEqual<TreeNode[]>([
      { type: "file", name: "main.typ", path: "/main.typ", fileId: "a" },
      { type: "file", name: "refs.bib", path: "/refs.bib", fileId: "b" },
    ]);
  });

  it("groups one level of folders and exposes the canonical folder path", () => {
    const tree = buildFileTree([
      { fileId: "a", path: "/chapters/intro.typ" },
      { fileId: "b", path: "/chapters/method.typ" },
    ]);
    expect(tree).toHaveLength(1);
    const folder = tree[0];
    if (folder?.type !== "folder") throw new Error("expected folder");
    expect(folder.name).toBe("chapters");
    expect(folder.path).toBe("/chapters");
    expect(folder.children.map((c) => c.name)).toEqual(["intro.typ", "method.typ"]);
  });

  it("nests deeply and gives each intermediate folder its full prefix path", () => {
    const tree = buildFileTree([{ fileId: "a", path: "/a/b/c/deep.typ" }]);
    expect(shape(tree)).toEqual([{ "a/": [{ "b/": [{ "c/": ["deep.typ"] }] }] }]);
    // walk to the deepest folder and check its canonical path
    const a = tree[0];
    if (a?.type !== "folder") throw new Error("a");
    const b = a.children[0];
    if (b?.type !== "folder") throw new Error("b");
    const c = b.children[0];
    if (c?.type !== "folder") throw new Error("c");
    expect(a.path).toBe("/a");
    expect(b.path).toBe("/a/b");
    expect(c.path).toBe("/a/b/c");
    expect(c.children[0]).toMatchObject({ type: "file", path: "/a/b/c/deep.typ", fileId: "a" });
  });

  it("orders folders before files, then locale-aware by name, deterministically", () => {
    const tree = buildFileTree([
      { fileId: "z", path: "/zeta.typ" },
      { fileId: "a", path: "/alpha.typ" },
      { fileId: "m", path: "/mid/m.typ" },
      { fileId: "b", path: "/beta/b.typ" },
    ]);
    expect(shape(tree)).toEqual([
      { "beta/": ["b.typ"] },
      { "mid/": ["m.typ"] },
      "alpha.typ",
      "zeta.typ",
    ]);
  });

  it("mixes root files and nested folders at the same level", () => {
    const tree = buildFileTree([
      { fileId: "root", path: "/main.typ" },
      { fileId: "x", path: "/chapters/intro.typ" },
    ]);
    expect(shape(tree)).toEqual([{ "chapters/": ["intro.typ"] }, "main.typ"]);
  });

  it("treats a bare basename (no leading slash) as a root file under its canonical path", () => {
    const tree = buildFileTree([{ fileId: "a", path: "notes.typ" }]);
    expect(tree).toEqual<TreeNode[]>([
      { type: "file", name: "notes.typ", path: "/notes.typ", fileId: "a" },
    ]);
  });

  it("ignores deleted files (caller may pass them; tree shows live only)", () => {
    const tree = buildFileTree([
      { fileId: "a", path: "/keep.typ" },
      { fileId: "b", path: "/gone.typ", deleted: true },
    ]);
    expect(tree).toEqual<TreeNode[]>([
      { type: "file", name: "keep.typ", path: "/keep.typ", fileId: "a" },
    ]);
  });

  it("sorts sibling folders and files independently under a shared parent", () => {
    const tree = buildFileTree([
      { fileId: "1", path: "/src/z.typ" },
      { fileId: "2", path: "/src/a.typ" },
      { fileId: "3", path: "/src/nested/x.typ" },
    ]);
    expect(shape(tree)).toEqual([{ "src/": [{ "nested/": ["x.typ"] }, "a.typ", "z.typ"] }]);
  });

  // #7 7D: binary files render as read-only rows in the SAME derived tree. A
  // binary node carries `kind: "binary"`; a text node is byte-for-byte unchanged
  // (no `kind` field), so every existing caller/snapshot is untouched.
  it("a text node carries NO kind field (back-compat with existing callers)", () => {
    const tree = buildFileTree([{ fileId: "a", path: "/main.typ" }]);
    expect(tree[0]).toEqual({ type: "file", name: "main.typ", path: "/main.typ", fileId: "a" });
    expect(tree[0]).not.toHaveProperty("kind");
  });

  it("includes a binary file as a leaf tagged kind:'binary'", () => {
    const tree = buildFileTree([{ fileId: "b", path: "/fig/logo.png", isBinary: true }]);
    expect(shape(tree)).toEqual([{ "fig/": ["logo.png"] }]);
    const folder = tree[0];
    if (folder?.type !== "folder") throw new Error("expected folder");
    expect(folder.children[0]).toEqual({
      type: "file",
      name: "logo.png",
      path: "/fig/logo.png",
      fileId: "b",
      kind: "binary",
    });
  });

  it("interleaves binary + text leaves and sorts them together by name", () => {
    const tree = buildFileTree([
      { fileId: "t", path: "/main.typ" },
      { fileId: "b", path: "/banner.png", isBinary: true },
    ]);
    // both are root leaves; sorted by name: banner.png < main.typ
    expect(tree.map((n) => n.name)).toEqual(["banner.png", "main.typ"]);
    expect(tree[0]).toMatchObject({ name: "banner.png", kind: "binary" });
    expect(tree[1]).not.toHaveProperty("kind");
  });

  it("ignores a deleted binary file", () => {
    const tree = buildFileTree([
      { fileId: "b", path: "/keep.png", isBinary: true },
      { fileId: "g", path: "/gone.png", isBinary: true, deleted: true },
    ]);
    expect(tree.map((n) => n.name)).toEqual(["keep.png"]);
  });
});

describe("planFolderRename", () => {
  const files = [
    { fileId: "a", path: "/chapters/intro.typ" },
    { fileId: "b", path: "/chapters/method.typ" },
    { fileId: "c", path: "/chapters/sub/deep.typ" },
    { fileId: "d", path: "/ch.typ" }, // boundary: /ch must NOT match /chapters
    { fileId: "e", path: "/root.typ" },
  ];

  it("re-paths exactly the files under the prefix, swapping the prefix segment", () => {
    const plan = planFolderRename(files, "/chapters", "/parts");
    expect(plan).toEqual([
      { fileId: "a", newPath: "/parts/intro.typ" },
      { fileId: "b", newPath: "/parts/method.typ" },
      { fileId: "c", newPath: "/parts/sub/deep.typ" },
    ]);
  });

  it("respects prefix boundaries: /ch does not match /chapters/* or /ch.typ", () => {
    const plan = planFolderRename(files, "/ch", "/CH");
    // only a file literally under "/ch/" would match — none here
    expect(plan).toEqual([]);
  });

  it("canonicalizes a non-slash prefix argument before matching", () => {
    expect(planFolderRename(files, "chapters", "parts")).toEqual([
      { fileId: "a", newPath: "/parts/intro.typ" },
      { fileId: "b", newPath: "/parts/method.typ" },
      { fileId: "c", newPath: "/parts/sub/deep.typ" },
    ]);
  });

  it("returns [] when the prefix is unchanged (no-op)", () => {
    expect(planFolderRename(files, "/chapters", "/chapters")).toEqual([]);
  });

  it("supports renaming a nested folder by its full prefix", () => {
    expect(planFolderRename(files, "/chapters/sub", "/chapters/appendix")).toEqual([
      { fileId: "c", newPath: "/chapters/appendix/deep.typ" },
    ]);
  });

  it("ignores deleted files", () => {
    const withDeleted = [...files, { fileId: "x", path: "/chapters/dead.typ", deleted: true }];
    const plan = planFolderRename(withDeleted, "/chapters", "/parts");
    expect(plan.some((p) => p.fileId === "x")).toBe(false);
  });

  it("can rename a folder INTO a nested prefix (move a whole subtree)", () => {
    const plan = planFolderRename(files, "/chapters", "/book/chapters");
    expect(plan).toEqual([
      { fileId: "a", newPath: "/book/chapters/intro.typ" },
      { fileId: "b", newPath: "/book/chapters/method.typ" },
      { fileId: "c", newPath: "/book/chapters/sub/deep.typ" },
    ]);
  });
});

describe("planFolderCreate", () => {
  it("canonicalizes a bare name to a /-prefixed folder + starter file", () => {
    expect(planFolderCreate([], "chapters")).toEqual({
      prefix: "/chapters",
      starterPath: `/chapters/${FOLDER_STARTER_BASENAME}`,
    });
  });

  it("accepts an already-/-prefixed name unchanged", () => {
    expect(planFolderCreate([], "/chapters")).toEqual({
      prefix: "/chapters",
      starterPath: `/chapters/${FOLDER_STARTER_BASENAME}`,
    });
  });

  it("supports nested folder paths and strips stray slashes/whitespace", () => {
    expect(planFolderCreate([], "  /book//chapters/  ")).toEqual({
      prefix: "/book/chapters",
      starterPath: `/book/chapters/${FOLDER_STARTER_BASENAME}`,
    });
  });

  it("returns null for empty / only-slashes / only-whitespace input (no-op)", () => {
    expect(planFolderCreate([], "")).toBeNull();
    expect(planFolderCreate([], "   ")).toBeNull();
    expect(planFolderCreate([], "///")).toBeNull();
  });

  it("dedupes the starter basename when the path already exists", () => {
    const files = [{ fileId: "a", path: `/chapters/${FOLDER_STARTER_BASENAME}` }];
    expect(planFolderCreate(files, "chapters")?.starterPath).toBe("/chapters/untitled-2.typ");
  });

  it("keeps deduping past the first collision", () => {
    const files = [
      { fileId: "a", path: "/chapters/untitled.typ" },
      { fileId: "b", path: "/chapters/untitled-2.typ" },
    ];
    expect(planFolderCreate(files, "chapters")?.starterPath).toBe("/chapters/untitled-3.typ");
  });

  it("ignores deleted files when deduping (a deleted path is free)", () => {
    const files = [{ fileId: "a", path: "/chapters/untitled.typ", deleted: true }];
    expect(planFolderCreate(files, "chapters")?.starterPath).toBe("/chapters/untitled.typ");
  });
});
