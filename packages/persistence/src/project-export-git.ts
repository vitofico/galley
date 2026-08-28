/**
 * Roadmap #17.5 — export-as-git-repo core. "Data outlives the app": download a
 * project as a ready-to-clone **git repository**, packaged in the same
 * deterministic ustar tar format the `.typ` bundle export uses.
 *
 * ## Layout: a BARE repo (`project.git/` at the tar root)
 * Chosen over a working-tree + `.git` layout deliberately:
 *   - **Determinism.** A bare repo is only HEAD + config + refs + loose
 *     objects — every byte a pure function of the snapshot. A checked-out
 *     layout needs an index file whose stat cache embeds wall-clock
 *     mtimes/inodes (never byte-reproducible), and *omitting* the index would
 *     make the extracted repo `git status` as all-deleted.
 *   - **Standard & usable.** `git clone project.git my-project` yields the
 *     working tree with history; the bare dir is also directly usable as a
 *     remote (`git remote add origin path/to/project.git`).
 *   - **Smallest.** No duplicated worktree bytes alongside the objects.
 *
 * ## Hand-rolled object writing (browser-safe by construction)
 * The repo bytes are produced WITHOUT isomorphic-git: its object-write path
 * (`writeBlob`/`writeTree`/`writeObject`) reaches for the Node `Buffer` global,
 * which doesn't exist in a Vite browser bundle — the export worked in node
 * unit tests and threw `Buffer is not defined` at browser runtime. A git loose
 * object is simply `zlib("<type> <byteLen>\0" + content)` stored at
 * `objects/<oid[0..2]>/<oid[2..]>`, with the oid = SHA-1 of the pre-zlib
 * bytes — so we write blobs/trees/the commit ourselves with Web Crypto SHA-1
 * (browser + Node ≥20) and `pako.deflate` (zlib; already isomorphic-git's own
 * deflate, so no new transitive code). This also guarantees CANONICAL tree
 * entry order (directories compare as `name/`): isomorphic-git re-sorts tree
 * entries non-canonically on write, which the raw-object pin test in
 * project-export-git.test.ts would catch. No fs at all — the repo is built
 * directly as tar entries. No clocks either: the commit timestamp is an
 * explicit option defaulting to epoch 0, because a `ProjectSnapshot` carries
 * no timestamp and a `Date.now()` default would silently break
 * byte-determinism.
 *
 * Fail-closed like `bundleProject` (same outcome house style): a snapshot with
 * no main file or an unprojectable tree returns `{ error }`, never a
 * half-baked archive.
 */
// Default import on purpose: pako is CommonJS, and Node's ESM loader (the e2e
// webServers run under tsx) cannot statically detect its named exports — a
// `{ deflate }` named import dies at runtime ("does not provide an export").
// The default import is the module.exports object under every loader.
import pako from "pako";
import {
  materializeProject,
  materializeProjectBinaries,
  writeUstar,
  type ProjectSnapshot,
  type UstarEntry,
} from "@galley/collab";

/** A finished git-repo export: the suggested download filename + the tar bytes. */
export interface GitRepoExport {
  filename: string;
  bytes: Uint8Array;
  /**
   * Canonical paths of binary pointers whose bytes weren't available in
   * `blobsByHash` and were therefore OMITTED from the committed tree (#7 7C-4).
   * Present only when at least one binary was dropped; a text-only or
   * fully-resolved export omits this field (output bytes unchanged).
   */
  omitted?: string[];
}

/** Export outcome — fail-closed, mirroring `bundleProject`'s style. */
export type GitExportOutcome = GitRepoExport | { error: string };

export interface GitExportOptions {
  /**
   * Commit author/committer timestamp in unix SECONDS. Defaults to **0**
   * (epoch): the snapshot carries no clock and a `Date.now()` default would
   * break determinism. Callers that want a real export time pass one
   * explicitly (e.g. from a user gesture); the export stays deterministic for
   * a given (snapshot, timestamp) pair either way.
   */
  timestampSec?: number;
  /**
   * Binary-asset bytes (#7 7C-4), keyed by sha256 hash. The CRDT holds only
   * content-addressed pointers; the bytes live in the BlobStore. Supply this so
   * binary files are committed into the repo at their path. Omitted/empty (the
   * default) → binaries are dropped (reported via {@link GitRepoExport.omitted}),
   * exactly as a text-only export behaves today.
   */
  blobsByHash?: ReadonlyMap<string, Uint8Array>;
}

/** A tree entry to write as a git blob: its repo-relative path + raw bytes. */
interface ExportFile {
  path: string;
  bytes: Uint8Array;
}

const BRANCH = "main";
/** Fixed, deterministic commit identity — the export is a projection, not authorship. */
const IDENTITY = "Galley <galley@local>";
const COMMIT_MESSAGE = "Galley project export\n";
/** The directory the bare repo occupies at the tar root. */
const TAR_ROOT = "project.git";
/** The skeleton a fresh bare repo carries (what `git init --bare` would lay down,
 * minus hooks/samples). `refs/tags` and `objects/pack` are deliberately present
 * as EMPTY dirs so the extracted repo looks like a normal bare repo. */
const CONFIG = "[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = true\n";

const enc = new TextEncoder();

/**
 * Export a project snapshot as a downloadable tar containing a bare git repo
 * (`project.git/`) whose single root commit's tree is exactly the materialized
 * project (live files + the `.galley/project.json` manifest + the
 * `.galley/instructions` config, when the project has one).
 *
 * Pure and offline: no fs, no git library, deterministic commit metadata,
 * mtime-0 tar headers — identical inputs yield identical bytes.
 */
export async function exportProjectAsGitRepo(
  snapshot: ProjectSnapshot,
  opts: GitExportOptions = {},
): Promise<GitExportOutcome> {
  if (snapshot.mainFileId === null) {
    return { error: "cannot export: project has no main file" };
  }
  // EXPORT surface (14-D round-trip): the committed tree carries the project's
  // `.galley/instructions` config alongside the manifest, so cloning the repo —
  // or fetching it back into Galley — preserves the agent-steering config.
  const outcome = materializeProject(snapshot, { includeInstructions: true });
  if (!outcome.ok) {
    return { error: `cannot export (${outcome.reason}): ${outcome.detail}` };
  }

  // Binary files (#7 7C-4): resolve their bytes and commit them alongside the
  // text tree. A path collision fails closed; a pointer with no available bytes
  // is omitted (reported, not fatal) — same posture as the .tar bundle.
  const binaries = materializeProjectBinaries(snapshot, opts.blobsByHash ?? new Map());
  if (!binaries.ok) {
    return { error: `cannot export (${binaries.reason}): ${binaries.detail}` };
  }

  try {
    // oid (hex) → zlib-deflated loose-object bytes, insertion-ordered.
    const objects = new Map<string, Uint8Array>();

    // Unify text + binary into byte-valued tree entries; the tree builder no
    // longer cares whether a leaf was text or binary (both become git blobs).
    const treeFiles: ExportFile[] = [
      ...outcome.result.files.map((f) => ({ path: f.path, bytes: enc.encode(f.text) })),
      ...binaries.files.map((f) => ({ path: f.path, bytes: f.bytes })),
    ];
    const treeOid = await writeTreeRecursive(objects, buildHierarchy(treeFiles));

    const ts = opts.timestampSec ?? 0;
    const when = `${ts} +0000`;
    const commitContent =
      `tree ${treeOid}\n` +
      `author ${IDENTITY} ${when}\n` +
      `committer ${IDENTITY} ${when}\n` +
      `\n` +
      COMMIT_MESSAGE;
    const commitOid = await writeLooseObject(objects, "commit", enc.encode(commitContent));

    return {
      filename: `${TAR_ROOT}.tar`,
      bytes: writeUstar(repoEntries(objects, commitOid)),
      ...(binaries.omitted.length > 0 ? { omitted: binaries.omitted } : {}),
    };
  } catch (err) {
    // Defensive: pure byte plumbing should not fail, but if it ever does we
    // return the structured outcome, never throw a half-export.
    return { error: `cannot export (git): ${err instanceof Error ? err.message : String(err)}` };
  }
}

// --- Loose-object plumbing -------------------------------------------------------

/** SHA-1 hex via Web Crypto (browser + Node ≥20 expose `crypto.subtle`). */
async function sha1Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer so the digest input isn't typed over the
  // SharedArrayBuffer union (strict lib Uint8Array<ArrayBufferLike>).
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", buf));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Wrap content as a git object (`"<type> <len>\0" + content`), record its
 * zlib-deflated loose form under its SHA-1 oid, and return the oid. Writing
 * the same content twice is a no-op (content-addressed).
 */
async function writeLooseObject(
  objects: Map<string, Uint8Array>,
  type: "blob" | "tree" | "commit",
  content: Uint8Array,
): Promise<string> {
  const header = enc.encode(`${type} ${content.byteLength}\0`);
  const wrapped = new Uint8Array(header.length + content.length);
  wrapped.set(header, 0);
  wrapped.set(content, header.length);
  const oid = await sha1Hex(wrapped);
  if (!objects.has(oid)) objects.set(oid, pako.deflate(wrapped));
  return oid;
}

// --- Tree plumbing -------------------------------------------------------------

interface TreeDir {
  dirs: Map<string, TreeDir>;
  files: Map<string, Uint8Array>; // name → raw blob bytes (text pre-encoded)
}

function buildHierarchy(files: ExportFile[]): TreeDir {
  const root: TreeDir = { dirs: new Map(), files: new Map() };
  for (const f of files) {
    const parts = f.path.split("/").filter((p) => p.length > 0);
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i] as string;
      let next = cur.dirs.get(name);
      if (!next) {
        next = { dirs: new Map(), files: new Map() };
        cur.dirs.set(name, next);
      }
      cur = next;
    }
    const leaf = parts[parts.length - 1];
    if (leaf !== undefined) cur.files.set(leaf, f.bytes);
  }
  return root;
}

/** Recursively write the hierarchy as git tree objects; returns the root tree oid. */
async function writeTreeRecursive(
  objects: Map<string, Uint8Array>,
  node: TreeDir,
): Promise<string> {
  const entries: { mode: string; path: string; oid: string; type: "blob" | "tree" }[] = [];
  for (const [name, bytes] of node.files) {
    const oid = await writeLooseObject(objects, "blob", bytes);
    entries.push({ mode: "100644", path: name, oid, type: "blob" });
  }
  for (const [name, child] of node.dirs) {
    const oid = await writeTreeRecursive(objects, child);
    entries.push({ mode: "40000", path: name, oid, type: "tree" });
  }
  // git requires tree entries in CANONICAL order: directories compare as if
  // their name ended in "/" (the file "notes.typ" sorts before the tree
  // "notes" — '.' 0x2E < '/' 0x2F). A plain name sort inverts such pairs and
  // the repo fails `git fsck` ("tree entry not sorted"). The raw-object pin
  // test in project-export-git.test.ts verifies the stored byte order.
  const sortKey = (e: { path: string; type: "blob" | "tree" }): string =>
    e.type === "tree" ? `${e.path}/` : e.path;
  entries.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  // Tree content: `${mode} ${name}\0` + 20 raw SHA-1 bytes per entry, modes
  // written WITHOUT leading zeros ("40000" for a tree, "100644" for a blob).
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    parts.push(enc.encode(`${e.mode} ${e.path}\0`));
    parts.push(hexToBytes(e.oid));
  }
  const content = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    content.set(p, off);
    off += p.length;
  }
  return writeLooseObject(objects, "tree", content);
}

/** Hex oid → the 20 raw bytes git trees embed. */
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// --- Repo → tar entries ----------------------------------------------------------

/**
 * Lay the bare repo out as tar entries under `project.git/`: the skeleton
 * (HEAD, config, the standard empty dirs), every loose object, and the branch
 * ref. Deterministic: skeleton order is fixed and object dirs/files are
 * emitted sorted by oid, parents before children.
 */
function repoEntries(objects: Map<string, Uint8Array>, commitOid: string): UstarEntry[] {
  const out: UstarEntry[] = [
    { type: "dir", path: `${TAR_ROOT}/` },
    { type: "file", path: `${TAR_ROOT}/HEAD`, bytes: enc.encode(`ref: refs/heads/${BRANCH}\n`) },
    { type: "file", path: `${TAR_ROOT}/config`, bytes: enc.encode(CONFIG) },
    { type: "dir", path: `${TAR_ROOT}/info/` },
    { type: "dir", path: `${TAR_ROOT}/objects/` },
    { type: "dir", path: `${TAR_ROOT}/objects/info/` },
    { type: "dir", path: `${TAR_ROOT}/objects/pack/` },
  ];
  // Loose objects grouped by their 2-hex fan-out dir, sorted for determinism.
  const oids = [...objects.keys()].sort();
  const seenFanout = new Set<string>();
  for (const oid of oids) {
    const fan = oid.slice(0, 2);
    if (!seenFanout.has(fan)) {
      seenFanout.add(fan);
      out.push({ type: "dir", path: `${TAR_ROOT}/objects/${fan}/` });
    }
    out.push({
      type: "file",
      path: `${TAR_ROOT}/objects/${fan}/${oid.slice(2)}`,
      bytes: objects.get(oid) as Uint8Array,
    });
  }
  out.push(
    { type: "dir", path: `${TAR_ROOT}/refs/` },
    { type: "dir", path: `${TAR_ROOT}/refs/heads/` },
    {
      type: "file",
      path: `${TAR_ROOT}/refs/heads/${BRANCH}`,
      bytes: enc.encode(`${commitOid}\n`),
    },
    { type: "dir", path: `${TAR_ROOT}/refs/tags/` },
  );
  return out;
}
