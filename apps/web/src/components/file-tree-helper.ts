/**
 * file-tree-helper — the PURE core of roadmap #12 folders.
 *
 * Folders are NOT a new entity (ADR-0013): they are DERIVED from the
 * `/`-delimited file paths. Files stay keyed by a stable `fileId`; the path is
 * just metadata. So the only primitives this module needs are:
 *
 *   - `buildFileTree` — group the flat keyed-file list into a nested
 *     folder/file tree for rendering (collapse/expand lives in the React shell).
 *   - `planFolderRename` — expand a "rename this folder" gesture into the set of
 *     per-file `{fileId, newPath}` re-paths the host then drives through the
 *     existing `project.rename(fileId, newPath, HUMAN)` primitive.
 *
 * No React, no DOM, no CRDT. Paths follow the core's `canonicalizePath`: a
 * leading slash, `/` as separator. A folder's `path` is its canonical prefix
 * WITHOUT a trailing slash (e.g. `/chapters`).
 */

/** A flat project file as the tree sees it (a thin view of the CRDT snapshot). */
export interface FileTreeInput {
  fileId: string;
  path: string;
  deleted?: boolean;
  /**
   * #7 7D: a binary file (image/PDF pointer). Binary leaves render as READ-ONLY
   * rows (no editor open, no set-as-main). Omitted/false ⇒ a text file, whose
   * node is byte-for-byte unchanged so existing callers/snapshots are untouched.
   */
  isBinary?: boolean;
}

/** A folder node: derived from a path prefix, holds nested folders + files. */
export interface FolderNode {
  type: "folder";
  /** The last path segment (the display name), e.g. `chapters`. */
  name: string;
  /** The canonical prefix WITHOUT a trailing slash, e.g. `/chapters`. */
  path: string;
  children: TreeNode[];
}

/** A file node: a leaf carrying its stable fileId + canonical full path. */
export interface FileNode {
  type: "file";
  /** The basename (last path segment), e.g. `intro.typ`. */
  name: string;
  /** The canonical full path, e.g. `/chapters/intro.typ`. */
  path: string;
  fileId: string;
  /**
   * #7 7D: present (`"binary"`) ONLY for a binary leaf — a read-only row the
   * shell renders distinctly and never opens in the editor. A text leaf omits
   * this field entirely, so its node is byte-for-byte unchanged.
   */
  kind?: "binary";
}

export type TreeNode = FolderNode | FileNode;

/** Ensure a leading slash; mirrors the core's `canonicalizePath`. */
function canonicalize(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/** Split a canonical path into its non-empty segments. */
function segments(path: string): string[] {
  return canonicalize(path)
    .split("/")
    .filter((s) => s.length > 0);
}

/** folders before files, then locale-aware by name — deterministic. */
function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

/** Recursively sort a node list and every folder's children, in place. */
function sortTree(nodes: TreeNode[]): TreeNode[] {
  nodes.sort(compareNodes);
  for (const n of nodes) if (n.type === "folder") sortTree(n.children);
  return nodes;
}

/**
 * Turn the flat keyed-file list into a nested folder/file tree. Deleted files
 * are skipped (the live tree shows live files only; the caller already filters
 * reserved `.galley/*` paths). The result is deterministically ordered: at every
 * level, folders before files, then locale-aware by name.
 */
export function buildFileTree(files: FileTreeInput[]): TreeNode[] {
  const roots: TreeNode[] = [];
  // Index folder nodes by their canonical prefix so siblings share one node.
  const folders = new Map<string, FolderNode>();

  const folderAt = (prefix: string, name: string, parent: TreeNode[]): FolderNode => {
    const existing = folders.get(prefix);
    if (existing) return existing;
    const node: FolderNode = { type: "folder", name, path: prefix, children: [] };
    folders.set(prefix, node);
    parent.push(node);
    return node;
  };

  for (const file of files) {
    if (file.deleted) continue;
    const path = canonicalize(file.path);
    const parts = segments(path);
    const name = parts[parts.length - 1] ?? path;

    // Descend/create the folder chain for every segment except the basename.
    let parent = roots;
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i] as string;
      prefix += `/${segment}`;
      parent = folderAt(prefix, segment, parent).children;
    }

    parent.push({
      type: "file",
      name,
      path,
      fileId: file.fileId,
      // Tag binary leaves only; a text leaf omits `kind` (back-compat).
      ...(file.isBinary ? { kind: "binary" as const } : {}),
    });
  }

  return sortTree(roots);
}

/** The default basename of the starter file a new folder is materialized with. */
export const FOLDER_STARTER_BASENAME = "untitled.typ";

/**
 * Plan creating a new folder. Folders are NOT a stored entity (ADR-0013): they
 * are DERIVED from file paths, so an EMPTY folder cannot exist. Creating a
 * folder therefore means creating its first file — a starter file under the new
 * folder prefix — which makes the folder derive and render in one step.
 *
 * `rawName` is whatever the user typed (`chapters`, `/chapters`, `a/b`, with
 * stray slashes/whitespace). It is canonicalized to a `/`-prefixed prefix, then
 * a `<prefix>/<FOLDER_STARTER_BASENAME>` path is formed. If that exact path
 * already exists among the LIVE files, the basename is deduped
 * (`untitled-2.typ`, `untitled-3.typ`, …) so the new starter never silently
 * collides with an existing file. (ADR-0013 permits duplicate paths and merely
 * flags them; deduping here is the friendlier behavior for an explicit
 * create-folder gesture.)
 *
 * Returns `null` when `rawName` has no usable segment (empty / only slashes /
 * only whitespace) — the host treats that as a no-op. The returned `prefix` is
 * the canonical folder path WITHOUT a trailing slash (e.g. `/chapters`), matching
 * `FolderNode.path`; `starterPath` is the full canonical path to `project.create`.
 */
export interface FolderCreatePlan {
  /** Canonical folder prefix, no trailing slash (e.g. `/chapters`). */
  prefix: string;
  /** Full canonical path of the starter file to create (e.g. `/chapters/untitled.typ`). */
  starterPath: string;
}

export function planFolderCreate(
  files: FileTreeInput[],
  rawName: string,
): FolderCreatePlan | null {
  // Split on `/`, trim each segment, and drop blanks — so stray slashes and
  // surrounding/empty whitespace ("  /book//chapters/  ", "   ", "///") collapse
  // to the real segments (or none, → a no-op).
  const parts = rawName
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return null; // empty / only-slashes / whitespace → no-op
  const prefix = `/${parts.join("/")}`;

  // The set of live paths to dedupe against (deleted files free their path).
  const taken = new Set(files.filter((f) => !f.deleted).map((f) => canonicalize(f.path)));

  const dot = FOLDER_STARTER_BASENAME.lastIndexOf(".");
  const stem = dot > 0 ? FOLDER_STARTER_BASENAME.slice(0, dot) : FOLDER_STARTER_BASENAME;
  const ext = dot > 0 ? FOLDER_STARTER_BASENAME.slice(dot) : "";

  let starterPath = `${prefix}/${FOLDER_STARTER_BASENAME}`;
  for (let n = 2; taken.has(starterPath); n++) {
    starterPath = `${prefix}/${stem}-${n}${ext}`;
  }
  return { prefix, starterPath };
}

/** The per-file re-path a folder rename expands to. */
export interface FolderRenameStep {
  fileId: string;
  newPath: string;
}

/**
 * Plan a folder rename: every LIVE file whose path sits strictly under
 * `oldPrefix` (i.e. starts with `oldPrefix + "/"`) is re-pathed by swapping that
 * prefix for `newPrefix`. The boundary is exact — `/ch` never matches
 * `/chapters/x` nor the file `/ch.typ`; only paths under `/ch/` do. Returns []
 * for an unchanged prefix (no-op). Both prefixes are canonicalized first.
 *
 * Duplicate/collision awareness is intentionally NOT reimplemented here: the
 * host already surfaces colliding paths via the core's `duplicatePaths()` after
 * the renames land (ADR-0013 allows duplicate paths; they are flagged, never
 * silently merged).
 */
export function planFolderRename(
  files: FileTreeInput[],
  oldPrefix: string,
  newPrefix: string,
): FolderRenameStep[] {
  const from = canonicalize(oldPrefix);
  const to = canonicalize(newPrefix);
  if (from === to) return [];

  const boundary = `${from}/`;
  const steps: FolderRenameStep[] = [];
  for (const file of files) {
    if (file.deleted) continue;
    const path = canonicalize(file.path);
    if (!path.startsWith(boundary)) continue;
    steps.push({ fileId: file.fileId, newPath: to + path.slice(from.length) });
  }
  return steps;
}
