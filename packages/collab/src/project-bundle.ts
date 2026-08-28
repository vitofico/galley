/**
 * Roadmap #17.5 (Lane D) — export-as-bundle core. "Data outlives the app."
 *
 * Produces a single **downloadable tar** of a project: every materialized file
 * at its relative path, plus the `.galley/project.json` manifest (and the
 * `.galley/instructions` config when the project has one — 14-D round-trip), so
 * a project's source survives independent of Galley (open it anywhere, feed it
 * to a stock `typst` CLI, or re-import it later via the manifest's path↔fileId map).
 *
 * Built on top of {@link materializeProject} (the CRDT → working-tree projection)
 * — we never re-implement that logic, just frame its output as a ustar archive.
 * Pure, offline, deterministic: identical snapshots emit byte-identical tars
 * (entries sorted by path, mtime pinned to 0, no clocks). Fail-closed: a
 * materialize failure (duplicate/unsafe path) or a project with no main file
 * returns `{ error }` rather than a half-baked bundle.
 *
 * Scope: ONLY the .typ/tar bundle here. HTML export and per-page PNG/SVG raster
 * are deferred. The ustar writer itself is exported as {@link writeUstar} so the
 * git-repo export (`@galley/persistence` `project-export-git.ts`, roadmap #17.5)
 * reuses the SAME deterministic archive plumbing instead of growing a second
 * tar implementation. `bundleProject`'s output bytes are unchanged.
 */
import type { ProjectSnapshot } from "./collab-project.js";
import { materializeProject, materializeProjectBinaries } from "./materialize.js";

/** A finished bundle: the suggested download filename + the raw archive bytes. */
export interface ProjectBundle {
  filename: string;
  bytes: Uint8Array;
  /**
   * Canonical paths of binary pointers whose bytes weren't available in
   * `blobsByHash` and were therefore OMITTED from the archive (#7 7C-4). Present
   * only when at least one binary was dropped — a text-only or fully-resolved
   * bundle omits this field entirely (output bytes unchanged).
   */
  omitted?: string[];
}

/** Bundle outcome — fail-closed, mirroring `materializeProject`'s style. */
export type BundleOutcome = ProjectBundle | { error: string };

const BLOCK = 512;
const utf8 = new TextEncoder();

/**
 * Build a deterministic ustar tar of a project's materialized working tree.
 *
 * Returns `{ error }` if the project can't be cleanly projected (duplicate or
 * unsafe path) or has no main file — we refuse to ship a bundle that can't be
 * compiled or re-imported faithfully. Otherwise returns the archive bytes and a
 * suggested `<name>.tar` filename.
 */
export function bundleProject(
  snapshot: ProjectSnapshot,
  blobsByHash: ReadonlyMap<string, Uint8Array> = new Map(),
): BundleOutcome {
  if (snapshot.mainFileId === null) {
    return { error: "cannot bundle: project has no main file" };
  }

  // EXPORT surface (14-D round-trip): carry the project's `.galley/instructions`
  // config in the bundle at its real path, so an exported project's agent
  // steering survives a re-import. Version snapshots deliberately do NOT opt in.
  const outcome = materializeProject(snapshot, { includeInstructions: true });
  if (!outcome.ok) {
    return { error: `cannot bundle (${outcome.reason}): ${outcome.detail}` };
  }

  // Binary files (#7 7C-4): resolve their bytes from the BlobStore map and add
  // them as archive entries. A path collision with a text file fails closed; a
  // pointer with no available bytes is omitted (reported, not fatal).
  const binaries = materializeProjectBinaries(snapshot, blobsByHash);
  if (!binaries.ok) {
    return { error: `cannot bundle (${binaries.reason}): ${binaries.detail}` };
  }

  // Merge text + binary entries, then sort by path so tar ordering is determined
  // solely by path (materializeProject already sorts text files; binaries arrive
  // sorted too — the merge re-sort keeps the combined stream deterministic).
  const entries: UstarEntry[] = [
    ...outcome.result.files.map((f) => ({ type: "file" as const, path: f.path, bytes: utf8.encode(f.text) })),
    ...binaries.files.map((f) => ({ type: "file" as const, path: f.path, bytes: f.bytes })),
  ];
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const bytes = writeUstar(entries);
  return {
    filename: "project.tar",
    bytes,
    ...(binaries.omitted.length > 0 ? { omitted: binaries.omitted } : {}),
  };
}

/**
 * One entry for the reusable ustar writer: a regular file's raw bytes, or a
 * directory (needed by the git-repo export — a bare repo's empty skeleton dirs
 * like `refs/tags` must survive the archive).
 */
export type UstarEntry =
  | { type: "file"; path: string; bytes: Uint8Array }
  | { type: "dir"; path: string };

/**
 * Hand-rolled minimal ustar tar writer (no dependency) — REUSABLE byte-level
 * core shared by `bundleProject` and the git-repo export.
 *
 * For each regular file: a 512-byte header (name, mode 0644, uid/gid, octal
 * size, mtime, typeflag '0', ustar magic, checksum) followed by the file bytes
 * padded to a 512 multiple. A directory is a header-only entry (typeflag '5',
 * mode 0755, size 0, trailing-slash name). The archive ends with two 512-byte
 * zero blocks. All numeric header fields and mtime are fixed (mtime=0) so
 * output is fully deterministic. Entry order is the caller's (callers sort).
 */
export function writeUstar(entries: UstarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const e of entries) {
    if (e.type === "dir") {
      const name = e.path.endsWith("/") ? e.path : `${e.path}/`;
      chunks.push(tarHeader(name, 0, "5", 0o755));
      continue;
    }
    chunks.push(tarHeader(e.path, e.bytes.length, "0", 0o644));
    chunks.push(e.bytes);
    const pad = (BLOCK - (e.bytes.length % BLOCK)) % BLOCK;
    if (pad > 0) chunks.push(new Uint8Array(pad));
  }
  // Two trailing zero blocks mark end-of-archive.
  chunks.push(new Uint8Array(BLOCK * 2));

  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Write `value` as ASCII into `block` starting at `off` (NUL fill is implicit). */
function putAscii(block: Uint8Array, off: number, value: string): void {
  for (let i = 0; i < value.length; i++) block[off + i] = value.charCodeAt(i) & 0x7f;
}

/**
 * A zero-padded octal field of the given width: `width - 1` octal digits then a
 * trailing NUL (the classic tar field layout, e.g. size as "00000000017\0").
 */
function octalField(block: Uint8Array, off: number, width: number, value: number): void {
  const digits = width - 1;
  const s = value.toString(8).padStart(digits, "0");
  putAscii(block, off, s);
  // block[off + digits] stays 0 (NUL terminator) — array is zero-initialized.
}

function tarHeader(treePath: string, size: number, typeflag: "0" | "5", mode: number): Uint8Array {
  const h = new Uint8Array(BLOCK);

  // name[100]. Paths here are short repo-relative paths (project trees and git
  // loose-object paths); ustar's 100-byte limit is ample, so deep prefixing
  // into the prefix[155] field remains out of scope.
  const nameBytes = utf8.encode(treePath);
  h.set(nameBytes.subarray(0, 100), 0);

  octalField(h, 100, 7, mode); // mode → e.g. "000644\0" (6 octal digits)
  octalField(h, 108, 8, 0); // uid    → 0
  octalField(h, 116, 8, 0); // gid    → 0
  octalField(h, 124, 12, size); // size (octal)
  octalField(h, 136, 12, 0); // mtime  → 0 (determinism)

  // chksum[8]: filled with spaces while computing, then written as octal below.
  for (let i = 148; i < 156; i++) h[i] = 0x20;

  h[156] = typeflag.charCodeAt(0); // '0' = regular file, '5' = directory
  // linkname[100] @157 stays zero.

  putAscii(h, 257, "ustar"); // magic[6] = "ustar\0"
  h[263] = 0; // explicit NUL after magic (already 0)
  putAscii(h, 263, "00"); // version[2] = "00"

  // uname/gname left empty; devmajor/devminor zero; prefix[155] zero.

  // Header checksum = unsigned sum of all 512 header bytes, with the checksum
  // field taken as 8 spaces (we set it above). Stored as a 6-digit octal value
  // followed by NUL and a space — the canonical "%06o\0 " layout.
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i]!;
  const chk = sum.toString(8).padStart(6, "0");
  putAscii(h, 148, chk);
  h[148 + 6] = 0; // NUL
  h[148 + 7] = 0x20; // space

  return h;
}
