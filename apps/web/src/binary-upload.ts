/**
 * binary-upload — the PURE core of #7 slice 7D's user-facing binary upload
 * (drop / paste / picker) + image insert, kept free of React, IndexedDB and the
 * DOM so it unit-tests cleanly in the node gate (mirroring `binary-files.ts`).
 *
 * The one non-obvious rule this core enforces is UNIQUENESS. The CRDT core
 * allows duplicate paths (`createBinary`), but a duplicate path makes the
 * compile input ambiguous and blocks the preview (`toProjectInput` → null), so
 * `planBinaryUpload` guarantees every accepted path is free of the live tree
 * AND of the rest of the batch — auto-suffixing `name-1.ext`, `name-2.ext` on a
 * collision. It also gates size (per-file + batch total, on `File.size` BEFORE
 * any `arrayBuffer()`), sanitizes the filename, and safety-gates the path
 * (`isSafeProjectPath` + a length cap the VFS gate itself does not impose).
 *
 * Nothing here reads bytes or touches a BlobStore — the handler does that,
 * ordered bytes-before-pointer. This module decides ONLY paths + policy.
 */
import { isSafeProjectPath } from "@galley/shared";

/** Per-file ceiling (= the zip-import `MAX_ENTRY_BYTES`; one user file into the same store). */
export const MAX_UPLOAD_FILE_BYTES = 32 * 1024 * 1024;
/** Whole-batch ceiling (= the zip-import `MAX_TOTAL_BYTES`). */
export const MAX_UPLOAD_TOTAL_BYTES = 128 * 1024 * 1024;
/** Path length cap (= `FILE_PROPOSAL_LIMITS.maxPathChars`; `isSafeProjectPath` has none). */
export const MAX_UPLOAD_PATH_CHARS = 1024;
/**
 * Max files ACCEPTED per gesture. Binary pointers are permanent CRDT records (the
 * Yjs log has no GC — that's why bytes stay out of it), so an accidental folder
 * drop of tens of thousands of tiny files would permanently bloat the shared doc
 * for every peer. Cap the pointer count per upload, mirroring the byte budgets.
 */
export const MAX_UPLOAD_FILE_COUNT = 100;

/** The pre-read shape of one upload candidate — name + `File.size`, no bytes. */
export interface UploadCandidate {
  name: string;
  size: number;
}

/** An accepted upload: the ORIGINAL index (correlates back to the `File[]`) + its assigned path. */
export interface AcceptedUpload {
  index: number;
  name: string;
  path: string;
}

/** A rejected upload: the (display) name + a short human reason for the aggregate Notice. */
export interface RejectedUpload {
  name: string;
  reason: string;
}

export interface UploadPlan {
  accepted: AcceptedUpload[];
  rejected: RejectedUpload[];
}

const MIB = 1024 * 1024;

/** Path separators + the Typst-string-breaking quote. */
const UNSAFE_NAME_CHARS = /[/\\"]/g;
/** ASCII control chars (0x00–0x1f) + DEL (0x7f). */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Sanitize a raw filename into a single path SEGMENT: drop path separators and
 * the `"` that would break a Typst string, drop control chars, collapse runs of
 * whitespace, and trim. Empty after sanitize (e.g. a name of only slashes) →
 * `""`, which the plan rejects.
 */
function sanitizeFileName(name: string): string {
  return name
    .replace(UNSAFE_NAME_CHARS, "")
    .replace(CONTROL_CHARS, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Ensure a leading slash; mirrors the core's `canonicalizePath`. */
function canonicalize(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/** Join a folder prefix (may be undefined / with a trailing slash) and a clean segment. */
function joinPath(folderPrefix: string | undefined, name: string): string {
  const prefix = (folderPrefix ?? "").replace(/\/+$/, "");
  return canonicalize(`${prefix}/${name}`);
}

/**
 * Return `basePath` if free, else the first `stem-1.ext`, `stem-2.ext`, … not in
 * `used`. A dotfile (`.gitignore`, leading dot) has no extension, so the suffix
 * lands at the end. Pure; the caller adds the winner to `used`. Exported so the
 * app layer can RE-suffix a planned path against a fresh snapshot immediately
 * before committing pointers (a remote peer / concurrent gesture may have taken
 * the path during the async put window).
 */
export function uniqueBinaryPath(basePath: string, used: ReadonlySet<string>): string {
  if (!used.has(basePath)) return basePath;
  const slash = basePath.lastIndexOf("/");
  const dir = basePath.slice(0, slash + 1); // keeps the trailing slash
  const file = basePath.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : "";
  let i = 1;
  let candidate = `${dir}${stem}-${i}${ext}`;
  while (used.has(candidate)) {
    i += 1;
    candidate = `${dir}${stem}-${i}${ext}`;
  }
  return candidate;
}

/**
 * Plan a binary upload: sanitize + safety-gate + size-gate + de-duplicate every
 * candidate against the live tree (`takenPaths` = live text AND binary paths)
 * and the rest of the batch. Deterministic (single left-to-right pass). Reads no
 * bytes — `size` is `File.size`, so the caller can gate BEFORE `arrayBuffer()`.
 */
export function planBinaryUpload(
  candidates: readonly UploadCandidate[],
  takenPaths: ReadonlySet<string>,
  opts?: { folderPrefix?: string },
): UploadPlan {
  const accepted: AcceptedUpload[] = [];
  const rejected: RejectedUpload[] = [];
  const used = new Set<string>(takenPaths);
  let total = 0;
  candidates.forEach((c, index) => {
    const clean = sanitizeFileName(c.name);
    if (clean === "") {
      rejected.push({ name: c.name || "(unnamed)", reason: "isn't a valid file name" });
      return;
    }
    if (accepted.length >= MAX_UPLOAD_FILE_COUNT) {
      rejected.push({
        name: clean,
        reason: `is over the ${MAX_UPLOAD_FILE_COUNT}-file limit for one upload`,
      });
      return;
    }
    if (!Number.isFinite(c.size) || c.size < 0) {
      rejected.push({ name: clean, reason: "has an unreadable size" });
      return;
    }
    if (c.size > MAX_UPLOAD_FILE_BYTES) {
      rejected.push({ name: clean, reason: `is larger than ${MAX_UPLOAD_FILE_BYTES / MIB} MB` });
      return;
    }
    if (total + c.size > MAX_UPLOAD_TOTAL_BYTES) {
      rejected.push({
        name: clean,
        reason: `would exceed the ${MAX_UPLOAD_TOTAL_BYTES / MIB} MB upload limit`,
      });
      return;
    }
    const basePath = joinPath(opts?.folderPrefix, clean);
    if (!isSafeProjectPath(basePath)) {
      rejected.push({ name: clean, reason: "isn't a safe project path" });
      return;
    }
    const path = uniqueBinaryPath(basePath, used);
    if (path.length > MAX_UPLOAD_PATH_CHARS) {
      rejected.push({ name: clean, reason: "has too long a path" });
      return;
    }
    used.add(path);
    total += c.size;
    accepted.push({ index, name: clean, path });
  });
  return { accepted, rejected };
}

/**
 * A human, single-sentence Notice for skipped uploads (no "file(s)"). Each reason
 * is a verb-phrase that follows the name ("logo.png is larger than 32 MB"), so
 * one skip reads as a plain sentence and several are joined compactly.
 */
export function uploadSkipNotice(rejected: readonly RejectedUpload[]): string {
  const phrase = (r: RejectedUpload) => `${r.name} ${r.reason}`;
  if (rejected.length === 1) return `Skipped ${phrase(rejected[0]!)}.`;
  return `Skipped ${rejected.length} files: ${rejected.map(phrase).join("; ")}.`;
}

/** mime → the extension a pasted image is named with (unknown → `.bin`). */
const PASTE_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/svg+xml": ".svg",
};

/**
 * A stable filename for a pasted image (the clipboard rarely carries one). The
 * extension comes from the clipboard mime; collisions are resolved by the plan
 * (`pasted-image-1.png`, …). Unknown mime → `.bin`.
 */
export function pastedImageName(mime: string): string {
  return `pasted-image${PASTE_EXT[mime] ?? ".bin"}`;
}

/** Escape a path for embedding inside a Typst string literal (defensive; paths are already clean). */
function escapeTypstPath(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** A reviewable `#figure` wrapping the image at `path` (the ⌘K / picker insert). */
export function imageSnippet(path: string): string {
  return `#figure(\n  image("${escapeTypstPath(path)}"),\n  caption: [],\n)`;
}

/** A bare inline `#image(...)` for the image at `path` (the paste insert). */
export function inlineImageSnippet(path: string): string {
  return `#image("${escapeTypstPath(path)}")`;
}

/**
 * The raster mimes a standalone `<img>` preview may render. Deliberately a SMALL
 * allowlist so a peer-forged / attacker-influenced `pointer.mime` can never
 * coerce the preview into a script-bearing type — SVG is handled separately
 * (rendered via `<img>` only, where its script is inert), PDF/other get no
 * inline preview. Exported so upload + preview share ONE policy.
 */
const DISPLAYABLE_RASTER_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

/** True iff `mime` is a raster type safe to render in a standalone `<img>`. Pure. */
export function isDisplayableRasterMime(mime: string): boolean {
  return DISPLAYABLE_RASTER_MIMES.has(mime);
}
