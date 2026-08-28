/**
 * Roadmap #4 — the CRDT → git **projection** core (ADR-0018).
 *
 * The Yjs CRDT document is the single source of truth; Git is a one-way,
 * human-readable *projection* of it, materialized at version boundaries. This
 * module is the pure, deterministic, offline heart of that projection: given a
 * `CollabProject` {@link ProjectSnapshot}, it produces the files a `VersionStore`
 * would commit into a bare git repo — the live `.typ` (and other) files plus a
 * `.galley/project.json` manifest that records structure (main + path↔fileId) so a
 * future import can map files back to their stable CRDT ids without losing history.
 *
 * It performs NO IO and touches NO git — that's the adapter's job (a later slice).
 * Git is never the merge layer; restore/import is an explicit CRDT transaction.
 */
import { isSafeProjectPath, isReservedProjectPath } from "@galley/shared";
import type { ProjectSnapshot } from "./collab-project.js";

/**
 * A binary file in the projected working tree (#7 7C-4). `path` is RELATIVE (no
 * leading slash, like {@link MaterializedFile}); `bytes` are the raw blob bytes,
 * resolved from a `hash → bytes` map the caller supplies (the BlobStore holds the
 * bytes; the CRDT holds only the content-addressed pointer).
 */
export interface MaterializedBinaryFile {
  path: string;
  bytes: Uint8Array;
}

export type MaterializeBinariesOutcome =
  | { ok: true; files: MaterializedBinaryFile[]; omitted: string[] }
  | { ok: false; reason: "duplicate_path" | "unsafe_path"; detail: string };

/** A file in the projected working tree. `path` is RELATIVE (no leading slash). */
export interface MaterializedFile {
  path: string;
  text: string;
}

/** The `.galley/project.json` manifest — structure only (deterministic, no timestamps). */
export interface ProjectManifest {
  schema: "galley.project/v1";
  /** Canonical (leading-slash) path of the main file, or null if unset/deleted. */
  main: string | null;
  /** Live files, canonical path + stable CRDT fileId, sorted by path then fileId. */
  files: { path: string; fileId: string }[];
}

export interface MaterializeResult {
  /** The working tree (live files + the manifest), sorted by path. */
  files: MaterializedFile[];
  manifest: ProjectManifest;
}

export type MaterializeOutcome =
  | { ok: true; result: MaterializeResult }
  | { ok: false; reason: "duplicate_path" | "unsafe_path"; detail: string };

/** Where the manifest lives in the projected tree. */
export const PROJECT_MANIFEST_PATH = ".galley/project.json";

/**
 * Where the project's agent-steering config (14-D) lives in the projected tree
 * when a caller opts in via {@link MaterializeOptions.includeInstructions}.
 */
export const PROJECT_INSTRUCTIONS_PATH = ".galley/instructions";

/** Additive options for {@link materializeProject}. Defaults preserve today's behavior. */
export interface MaterializeOptions {
  /**
   * Carry the live `.galley/instructions` config file into the projected tree at
   * its real path (alongside the manifest). Default **false** — version snapshots
   * deliberately exclude it (restoring an old version must never clobber or
   * tombstone the project's CURRENT instructions), while the user-facing EXPORT
   * surfaces (the `.tar` bundle, the git-repo export, git remote push) opt in so
   * a project's config survives an export → re-import round-trip.
   *
   * The instructions file is a plain tree file only; it is NOT listed in the
   * manifest's `files` (that map is document structure, path↔fileId, and the
   * reserved config is not a document).
   */
  includeInstructions?: boolean;
}

const MANIFEST_SCHEMA = "galley.project/v1" as const;

/**
 * The path forms a live instructions file may use, in PREFERENCE order — the
 * CRDT-canonical leading-slash form first, then the materialized relative form
 * (the same order `readProjectInstructions` in apps/web resolves; duplicates are
 * coalesced by the editor's save, but a snapshot may still carry strays).
 */
const INSTRUCTIONS_SOURCE_PATHS = ["/.galley/instructions", ".galley/instructions"] as const;

/**
 * Pick the live instructions text from snapshot files, deterministically:
 * preference order over the two path forms, lowest fileId within a form (so a
 * not-yet-coalesced duplicate never makes the projection nondeterministic).
 */
function pickInstructionsText(
  files: { fileId: string; path: string; text: string; deleted: boolean }[],
): string | undefined {
  for (const wanted of INSTRUCTIONS_SOURCE_PATHS) {
    const hits = files
      .filter((f) => !f.deleted && f.path === wanted)
      .sort((a, b) => cmp(a.fileId, b.fileId));
    if (hits.length > 0) return hits[0]!.text;
  }
  return undefined;
}

/**
 * Extract the `.galley/instructions` text from a MATERIALIZED tree (the import
 * side of the round-trip). Accepts both the relative form the projection emits
 * and the leading-slash form for defense in depth (mirroring how the manifest is
 * matched in version-compare). Pure; returns `undefined` when the tree carries
 * no instructions — callers must then leave any existing instructions untouched.
 */
export function projectInstructionsFromTree(
  tree: { path: string; text: string }[],
): string | undefined {
  for (const wanted of INSTRUCTIONS_SOURCE_PATHS) {
    const hit = tree.find((f) => f.path === wanted);
    if (hit) return hit.text;
  }
  return undefined;
}

/** Canonical "/a/b.typ" → relative tree path "a/b.typ". */
function toTreePath(canonicalPath: string): string {
  return canonicalPath.replace(/^\/+/, "");
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Project a CRDT project snapshot into a git-shaped working tree + manifest.
 *
 * Live (non-deleted) files only. A **duplicate live path** fails closed
 * (`{ ok: false }`) — two files can't occupy one tree path, and we never silently
 * pick a winner (the same rule as `CollabProject.toProjectInput`). The result is
 * fully determined by the snapshot (no clocks), so re-projecting identical state
 * yields byte-identical output — important for stable version diffs.
 *
 * `options.includeInstructions` (default OFF) additionally carries the live
 * `.galley/instructions` config into the tree (see {@link MaterializeOptions}) —
 * the EXPORT surfaces opt in so the project's agent-steering config round-trips;
 * version snapshots keep the default and stay config-free on purpose.
 */
export function materializeProject(
  snapshot: ProjectSnapshot,
  options: MaterializeOptions = {},
): MaterializeOutcome {
  // Sort by (path, fileId) so the projection is deterministic regardless of the
  // snapshot's input order (a real CollabProject snapshot is already sorted; a
  // hand-built one may not be).
  const live = snapshot.files
    .filter((f) => !f.deleted)
    // Exclude the reserved `.galley/*` namespace (the agent-steering
    // `instructions` file, 14-D) BEFORE the safety gate and the manifest. These
    // are internal CRDT-local config, never materialized as user tree files —
    // and `isSafeProjectPath` (correctly) rejects `.galley`, so without this
    // filter a live `/.galley/instructions` would fail the projection closed and
    // break export/version/unify/compare. The `.galley/project.json` manifest is
    // still WRITTEN below (it's synthesized here, not carried as a live file).
    //
    // 14-D round-trip: when `options.includeInstructions` is set, the
    // instructions file (and ONLY that file — never arbitrary `.galley/*`) is
    // re-added to the tree at the end, bypassing the user-path safety gate the
    // same way the synthesized manifest does. The restore path
    // (`restoreProjectFromTree`) must still NOT tombstone a live reserved file
    // just because a tree omits it, and must route a tree-carried instructions
    // file through the coalescing write seam, never a raw create.
    .filter((f) => !isReservedProjectPath(f.path))
    .slice()
    .sort((a, b) => (a.path === b.path ? cmp(a.fileId, b.fileId) : cmp(a.path, b.path)));

  // Fail closed on a path that would escape the tree or shadow the manifest — a
  // project path is user-controlled (create/rename) and we're about to write it to
  // disk. (The version store containment-checks again; defense in depth.)
  for (const f of live) {
    if (!isSafeProjectPath(f.path)) {
      return { ok: false, reason: "unsafe_path", detail: f.path };
    }
  }

  // Detect duplicate live paths ourselves (don't trust the snapshot to have
  // pre-flagged them) — defense in depth against a clobbering projection.
  const seen = new Map<string, string>();
  for (const f of live) {
    const prev = seen.get(f.path);
    if (prev !== undefined) {
      return { ok: false, reason: "duplicate_path", detail: f.path };
    }
    seen.set(f.path, f.fileId);
  }

  // Resolve main's canonical path, if main is a live file.
  const mainFile = snapshot.mainFileId === null ? undefined : live.find((f) => f.fileId === snapshot.mainFileId);
  const manifest: ProjectManifest = {
    schema: MANIFEST_SCHEMA,
    main: mainFile ? mainFile.path : null,
    files: live.map((f) => ({ path: f.path, fileId: f.fileId })),
  };

  const files: MaterializedFile[] = live.map((f) => ({ path: toTreePath(f.path), text: f.text }));
  files.push({ path: PROJECT_MANIFEST_PATH, text: `${JSON.stringify(manifest, null, 2)}\n` });

  // Opt-in (export surfaces): carry the instructions config at its real path.
  // Deterministic pick over the raw snapshot (the reserved filter above removed
  // it from `live`); NOT listed in the manifest — it's config, not a document.
  if (options.includeInstructions) {
    const instructions = pickInstructionsText(snapshot.files);
    if (instructions !== undefined) {
      files.push({ path: PROJECT_INSTRUCTIONS_PATH, text: instructions });
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { ok: true, result: { files, manifest } };
}

/**
 * Project a snapshot's BINARY files into raw-byte tree entries (#7 7C-4 — the
 * export side of the binary-asset feature). Kept SEPARATE from
 * {@link materializeProject} (which stays text-only — version snapshots and
 * compare never carry bytes), so callers opt into bytes explicitly: the EXPORT
 * surfaces (`bundleProject`, the git-repo export) merge these entries with the
 * text tree, version snapshots do not.
 *
 * Live (non-deleted) binaries only. The binary/text path namespace is UNIFIED
 * (the same `duplicatePaths` rule), so a binary path that collides with a live
 * text path — or with another binary — fails closed (`duplicate_path`), and an
 * unsafe path fails closed (`unsafe_path`), exactly like the text projection.
 *
 * Bytes are resolved from `blobsByHash` (sha256 hash → bytes). A pointer whose
 * bytes are NOT present is OMITTED rather than failing the whole export — its
 * path is returned in `omitted` so the caller can warn. This mirrors the
 * compile-time resolver (a synced-but-unfetched blob, the deferred blob-sync
 * case) and degrades gracefully instead of blocking an otherwise-faithful export.
 * Result `files` are sorted by relative path; `omitted` by canonical path.
 */
export function materializeProjectBinaries(
  snapshot: ProjectSnapshot,
  blobsByHash: ReadonlyMap<string, Uint8Array>,
): MaterializeBinariesOutcome {
  const binaries = (snapshot.binaryFiles ?? [])
    .filter((b) => !b.deleted)
    .slice()
    .sort((a, b) => (a.path === b.path ? cmp(a.fileId, b.fileId) : cmp(a.path, b.path)));

  // The live TEXT paths the projection would write (same filtering as
  // materializeProject: non-deleted, non-reserved). A binary colliding with one
  // of these would shadow a text file in the tree — fail closed.
  const textPaths = new Set<string>();
  for (const f of snapshot.files) {
    if (f.deleted || isReservedProjectPath(f.path)) continue;
    textPaths.add(f.path);
  }

  const seen = new Set<string>();
  const files: MaterializedBinaryFile[] = [];
  const omitted: string[] = [];
  for (const b of binaries) {
    if (!isSafeProjectPath(b.path)) {
      return { ok: false, reason: "unsafe_path", detail: b.path };
    }
    if (textPaths.has(b.path) || seen.has(b.path)) {
      return { ok: false, reason: "duplicate_path", detail: b.path };
    }
    seen.add(b.path);
    const bytes = blobsByHash.get(b.hash);
    if (bytes === undefined) {
      omitted.push(b.path);
      continue;
    }
    files.push({ path: toTreePath(b.path), bytes });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  omitted.sort(cmp);
  return { ok: true, files, omitted };
}
