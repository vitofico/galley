/**
 * binary-files — the PURE core of #7 slice 7D (wiring the binary-asset substrate
 * into the app layer), kept free of React + IndexedDB so it unit-tests cleanly.
 *
 * Two concerns live here:
 *
 *  1. COMPILE RESOLUTION. The compile input is built SYNCHRONOUSLY, but a binary
 *     pointer's bytes load ASYNC from the per-project BlobStore. ProjectApp keeps
 *     a `hash -> bytes` cache (a ref) populated by an effect that fetches the
 *     missing hashes; the compile-input build reads only what is already cached.
 *     `pendingHashes` tells the effect what to fetch; `buildBinaryFilesInput`
 *     turns the cache into the compiler's `ProjectBinaryFile[]` (skipping any
 *     pointer whose bytes aren't resolved yet — they appear on a later tick).
 *
 *  2. IMPORT HANDOFF. A `.zip` import creates a NEW project and navigates to it,
 *     so binary bytes must cross from the picking ProjectApp to the freshly
 *     mounted one. Mirroring `pending-seed.ts`, two in-process slots carry them:
 *       - the LATEST imported binaries (the zip reader records them; the Accept
 *         handler takes them), and
 *       - a per-project PENDING-pointer map (the Accept handler writes bytes to
 *         the new project's BlobStore + records the pointers; the new project's
 *         boot consumes them and calls `project.createBinary`, AFTER the text
 *         `seedIfPristine` has run — so the pointer writes never suppress it).
 *     Both are in-process only (same SPA heap; navigation is a `pushState`), so a
 *     full reload during the handoff legitimately drops them — the same accepted
 *     property the text pending-seed already has.
 *
 * Default-safe: a text-only project has no binary pointers, so every helper here
 * returns an empty result and ProjectApp adds no `binaryFiles` to the compile
 * input — byte-for-byte unchanged.
 */
import type { BinaryAsset } from "@galley/collab";
import type { ProjectBinaryFile } from "@galley/shared";
import { isSafeProjectPath } from "@galley/shared";

/** The resolved-bytes cache: a binary pointer's `hash` -> its bytes. */
export type ResolvedBinaryCache = Map<string, Uint8Array>;

/** The minimal shape of a live binary pointer the resolver helpers need. */
export interface BinaryPointerLike {
  path: string;
  hash: string;
  deleted: boolean;
}

/** An imported binary asset: a project path + its raw bytes. */
export interface ImportedBinary {
  path: string;
  bytes: Uint8Array;
}

/** A CRDT-pointer-to-be: the path + the BlobStore pointer (`createBinary` input). */
export interface PendingBinaryPointer {
  path: string;
  asset: BinaryAsset;
}

/** Ensure a leading slash; mirrors the core's `canonicalizePath`. */
function canonicalize(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * A compact human size hint for a binary row (e.g. `812 B`, `4.2 KB`, `1.5 MB`).
 * Decimal units, one decimal place above a kilobyte. Pure + deterministic.
 */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "0 B";
  if (size < 1024) return `${Math.round(size)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

/**
 * The DISTINCT, non-deleted hashes among `files` that are NOT yet in `cache` —
 * i.e. the bytes the resolution effect still needs to fetch from the BlobStore.
 * Deterministic-ish ordering doesn't matter (the caller fetches each once).
 */
export function pendingHashes(
  files: readonly BinaryPointerLike[] | undefined,
  cache: ResolvedBinaryCache,
): string[] {
  if (!files) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (f.deleted) continue;
    if (cache.has(f.hash) || seen.has(f.hash)) continue;
    seen.add(f.hash);
    out.push(f.hash);
  }
  return out;
}

/**
 * Build the compiler's `binaryFiles` input from the RESOLVED cache: every live
 * pointer whose bytes are already cached becomes `{ path, bytes }`. Pointers with
 * unresolved bytes are SKIPPED (no throw) — they land on the next tick once the
 * effect resolves them. Sorted by path for a deterministic compile input.
 */
export function buildBinaryFilesInput(
  files: readonly BinaryPointerLike[] | undefined,
  cache: ResolvedBinaryCache,
): ProjectBinaryFile[] {
  if (!files) return [];
  const out: ProjectBinaryFile[] = [];
  for (const f of files) {
    if (f.deleted) continue;
    const bytes = cache.get(f.hash);
    if (!bytes) continue; // not resolved yet — appears on a later tick
    out.push({ path: f.path, bytes });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * Canonicalize + safety-gate imported binary entries: leading-slash the path,
 * drop anything VFS-unsafe (traversal, control chars, the reserved `/.galley`
 * namespace — the SAME `isSafeProjectPath` gate the text path uses), and dedupe
 * by path (first wins). Pure; the caller persists the survivors' bytes.
 */
export function normalizeImportedBinaries(
  binaries: readonly ImportedBinary[] | undefined,
): ImportedBinary[] {
  if (!binaries) return [];
  const out: ImportedBinary[] = [];
  const seen = new Set<string>();
  for (const b of binaries) {
    const path = canonicalize(b.path);
    if (!isSafeProjectPath(path)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, bytes: b.bytes });
  }
  return out;
}

// ---------------------------------------------------------------------------
// In-process handoff slots (mirroring pending-seed.ts; never persisted)
// ---------------------------------------------------------------------------

/** The latest imported binaries, recorded by the zip reader for the Accept handler. */
let LATEST_IMPORTED: ImportedBinary[] = [];

/**
 * Record the binaries from the most recently read project zip. One pick is in
 * flight at a time, so a later call replaces the earlier set.
 */
export function rememberImportedBinaries(binaries: readonly ImportedBinary[]): void {
  LATEST_IMPORTED = binaries.slice();
}

/** Take (and clear) the latest imported binaries; `[]` if none were recorded. */
export function takeImportedBinaries(): ImportedBinary[] {
  const taken = LATEST_IMPORTED;
  LATEST_IMPORTED = [];
  return taken;
}

/** Per-project pending CRDT pointers, consumed once by the new project's boot. */
const PENDING_POINTERS = new Map<string, PendingBinaryPointer[]>();

/** Stash the binary pointers to create in `projectId` on its first boot. */
export function setPendingBinarySeed(projectId: string, pointers: PendingBinaryPointer[]): void {
  PENDING_POINTERS.set(projectId, pointers);
}

/**
 * Return AND delete the pending binary pointers for `projectId` (consume-once, so
 * a StrictMode double-invoke / reload can't double-create). `undefined` if none.
 */
export function takePendingBinarySeed(projectId: string): PendingBinaryPointer[] | undefined {
  const pointers = PENDING_POINTERS.get(projectId);
  if (pointers !== undefined) PENDING_POINTERS.delete(projectId);
  return pointers;
}
