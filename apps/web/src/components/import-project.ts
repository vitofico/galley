/**
 * Overleaf / LaTeX project `.zip` reader (roadmap #17.3) — PURE, offline, and
 * DELIBERATELY NARROW. It turns a `.zip`'s raw bytes into the already-unpacked
 * file tree that `importLatexProject` (`@galley/agent`) consumes, then the
 * caller runs that core to produce the converted Typst + honest migration
 * report. This module does NOT convert anything — it only safely unpacks.
 *
 * SECURITY / SCOPE (the hard part — there is NO zip dependency):
 *  - The archive is read from its End-Of-Central-Directory record + central
 *    directory, NOT by scanning local file headers (the central directory is the
 *    authoritative index; local headers can lie / be streamed with bit-3 sizes).
 *  - Only compression method 0 (stored) and 8 (deflate, via the native
 *    `DecompressionStream("deflate-raw")`) are supported.
 *  - REJECTED with a typed `ZipImportError`: encrypted entries (GP-flag bit 0),
 *    ZIP64 (the 0xFFFFFFFF sentinels / the ZIP64 EOCD locator), multi-disk
 *    archives, and any UNSAFE path — absolute, leading `/`, `..` traversal,
 *    backslashes, or an embedded NUL.
 *  - Caps are enforced WHILE streaming (DecompressionStream has no output cap, so
 *    we count decompressed bytes ourselves and abort): a per-entry cap, a total
 *    cap across the archive, and a max-entry-count cap.
 *  - Directory entries (names ending `/`) are skipped. Text entries are decoded
 *    UTF-8; non-text (binary) entries become asset entries (`binary: true`) —
 *    their bytes are NOT materialized, matching what `importLatexProject` does
 *    with assets (manifest only).
 *
 * Fully unit-testable: it operates on plain bytes and uses only `DecompressionStream`,
 * which is available in Node 20 + browsers.
 */

import type { ImportLatexProjectInput, LatexProjectInputFile } from "@galley/agent";
import type { LatexProjectReport, ProjectTextFile } from "@galley/agent";
import { isReservedProjectPath, isSafeProjectPath } from "@galley/shared";
import { rememberImportedBinaries, type ImportedBinary } from "../binary-files.js";

// ---------------------------------------------------------------------------
// Caps (the three the contract asks for). Generous enough for a real thesis,
// tight enough that a zip bomb aborts instead of OOMing the tab.
// ---------------------------------------------------------------------------

/** Max decompressed bytes for a SINGLE entry (32 MiB). */
export const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
/** Max decompressed bytes across the WHOLE archive (128 MiB). */
export const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
/**
 * Max size of the RAW `.zip` bytes themselves (128 MiB). Bounds the up-front
 * `file.arrayBuffer()` read in the UI and guards `readProjectZip` for other
 * callers — a multi-GB picked file must be rejected BEFORE it is read into
 * memory, since the per-entry/total caps only apply after parsing begins. Set
 * equal to MAX_TOTAL_BYTES: a compressed archive can never decompress to less
 * than its own stored bytes, so a larger zip cannot fit under the total cap.
 */
export const MAX_ZIP_BYTES = MAX_TOTAL_BYTES;
/** Max number of entries (directory entries included in the count). */
export const MAX_ENTRY_COUNT = 5000;

/** Sub-chunk size for feeding compressed bytes into the inflater (256 KiB). */
const FEED_CHUNK_BYTES = 256 * 1024;

/** Why a `.zip` was rejected — a stable, switchable reason code. */
export type ZipImportErrorCode =
  | "not-a-zip"
  | "truncated"
  | "encrypted"
  | "zip64"
  | "multi-disk"
  | "unsupported-compression"
  | "unsafe-path"
  | "entry-too-large"
  | "archive-too-large"
  | "too-many-entries"
  | "bad-data";

/** A typed, user-presentable rejection. Never thrown for "merely lossy" input. */
export class ZipImportError extends Error {
  readonly code: ZipImportErrorCode;
  constructor(code: ZipImportErrorCode, message: string) {
    super(message);
    this.name = "ZipImportError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Signatures & fixed offsets (PKWARE APPNOTE)
// ---------------------------------------------------------------------------

const SIG_EOCD = 0x06054b50; // End Of Central Directory
const SIG_CDH = 0x02014b50; // Central Directory file Header
const SIG_ZIP64_EOCD_LOC = 0x07064b50; // ZIP64 EOCD locator
const EOCD_MIN_SIZE = 22; // EOCD without comment
const ZIP64_SENTINEL_32 = 0xffffffff;
const ZIP64_SENTINEL_16 = 0xffff;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Unpack a LaTeX/Overleaf project `.zip` into the `ImportLatexProjectInput` tree.
 * PURE (no DOM/network) and async (deflate streams). Throws `ZipImportError` on
 * any unsafe / unsupported archive; otherwise returns the safe, capped file tree.
 */
export async function readProjectZip(
  zip: ArrayBuffer | Uint8Array,
): Promise<ImportLatexProjectInput> {
  const bytes = zip instanceof Uint8Array ? zip : new Uint8Array(zip);

  // Defensive: the UI gates `file.size` before reading, but other callers (and
  // tests) hand us raw bytes directly — reject an over-cap archive up front so
  // a hostile blob never makes it past parsing.
  if (bytes.length > MAX_ZIP_BYTES) {
    throw new ZipImportError(
      "archive-too-large",
      `zip file is ${bytes.length} bytes; the limit is ${MAX_ZIP_BYTES}`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const eocdOffset = findEocd(bytes);
  if (eocdOffset === null) {
    throw new ZipImportError("not-a-zip", "no zip End-Of-Central-Directory record found");
  }

  // Reject ZIP64: its EOCD locator sits immediately before the EOCD.
  if (
    eocdOffset >= 20 &&
    view.getUint32(eocdOffset - 20, true) === SIG_ZIP64_EOCD_LOC
  ) {
    throw new ZipImportError("zip64", "ZIP64 archives are not supported");
  }

  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const cdStartDisk = view.getUint16(eocdOffset + 6, true);
  const cdCountThisDisk = view.getUint16(eocdOffset + 8, true);
  const cdCountTotal = view.getUint16(eocdOffset + 10, true);
  if (diskNumber !== 0 || cdStartDisk !== 0 || cdCountThisDisk !== cdCountTotal) {
    throw new ZipImportError("multi-disk", "multi-disk zip archives are not supported");
  }

  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  if (
    cdOffset === ZIP64_SENTINEL_32 ||
    cdSize === ZIP64_SENTINEL_32 ||
    cdCountTotal === ZIP64_SENTINEL_16
  ) {
    throw new ZipImportError("zip64", "ZIP64 archives are not supported");
  }
  if (cdOffset + cdSize > bytes.length) {
    throw new ZipImportError("truncated", "central directory extends past end of file");
  }
  if (cdCountTotal > MAX_ENTRY_COUNT) {
    throw new ZipImportError(
      "too-many-entries",
      `archive declares ${cdCountTotal} entries; the limit is ${MAX_ENTRY_COUNT}`,
    );
  }

  const files: LatexProjectInputFile[] = [];
  const utf8 = new TextDecoder("utf-8", { fatal: false });
  let totalBytes = 0;
  let scanned = 0;

  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  while (p + 46 <= cdEnd) {
    if (view.getUint32(p, true) !== SIG_CDH) break; // end of central directory headers
    scanned++;
    if (scanned > MAX_ENTRY_COUNT) {
      throw new ZipImportError(
        "too-many-entries",
        `archive has more than ${MAX_ENTRY_COUNT} entries`,
      );
    }

    const gpFlag = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const uncompSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localHeaderOffset = view.getUint32(p + 42, true);

    const nameStart = p + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > cdEnd) {
      throw new ZipImportError("truncated", "central directory header name runs past the directory");
    }
    const nameBytes = bytes.subarray(nameStart, nameEnd);
    // Filenames are UTF-8 when GP-flag bit 11 is set; otherwise CP437. We decode
    // as UTF-8 either way (the ASCII subset both share covers LaTeX paths) and
    // validate safety on the result.
    const rawName = utf8.decode(nameBytes);

    // Advance the cursor to the next CD header BEFORE any per-entry work, then
    // fail closed if name+extra+comment overran the central directory (a forged
    // length must not let us read past `cdEnd`).
    p = nameEnd + extraLen + commentLen;
    if (p > cdEnd) {
      throw new ZipImportError(
        "truncated",
        "central directory header (extra/comment) runs past the directory",
      );
    }

    // -- Reject / skip ---------------------------------------------------------
    if ((gpFlag & 0x0001) !== 0) {
      throw new ZipImportError("encrypted", `entry "${rawName}" is encrypted; encrypted zips are unsupported`);
    }
    if (
      compSize === ZIP64_SENTINEL_32 ||
      uncompSize === ZIP64_SENTINEL_32 ||
      localHeaderOffset === ZIP64_SENTINEL_32
    ) {
      throw new ZipImportError("zip64", `entry "${rawName}" uses ZIP64 fields; unsupported`);
    }

    // Validate EVERY entry name's safety — including directory entries — BEFORE
    // the directory skip, so a hostile directory-only `"../"` entry is rejected,
    // not silently accepted. (`sanitizePath` ignores the trailing slash.)
    const safePath = sanitizePath(rawName);
    if (safePath === null) {
      throw new ZipImportError("unsafe-path", `unsafe entry path rejected: "${rawName}"`);
    }

    // Directory entry: skip (don't materialize, but it counted toward the cap).
    if (rawName.endsWith("/")) continue;

    if (method !== 0 && method !== 8) {
      throw new ZipImportError(
        "unsupported-compression",
        `entry "${rawName}" uses compression method ${method}; only stored (0) and deflate (8) are supported`,
      );
    }

    // -- Locate + read the local data ------------------------------------------
    // The running archive budget is threaded in so decompression aborts MID-ENTRY
    // the instant the archive-wide total would be exceeded — not after the entry
    // fully returns. The per-entry 32 MiB cap stays as the inner bound.
    const remainingTotal = MAX_TOTAL_BYTES - totalBytes;
    const data = await readEntryData(
      bytes,
      view,
      localHeaderOffset,
      method,
      compSize,
      uncompSize,
      rawName,
      remainingTotal,
    );

    totalBytes += data.length;

    if (isTextPath(safePath)) {
      files.push({ path: safePath, text: new TextDecoder("utf-8", { fatal: false }).decode(data) });
    } else {
      // Binary asset (#7): keep the bytes so images survive import (G1). `data` is
      // already bounded by the per-entry + archive-total caps above.
      files.push({ path: safePath, binary: true, bytes: data });
    }
  }

  // #7 7D: record this archive's binary bytes in the in-process handoff slot so
  // the Accept handler can persist them into the NEW project's BlobStore. The
  // import creates a fresh project and navigates to it, and `ImportPanel` (frozen)
  // doesn't forward bytes through `onImportProject(files, report, filename)`, so
  // they cross via this slot — mirroring the text pending-seed handoff. A
  // text-only archive records an empty set (the default-safe path). Recording the
  // LATEST read per pick is correct: only one zip is unpacked at a time.
  const binaries: ImportedBinary[] = files
    .filter((f) => f.binary === true && f.bytes instanceof Uint8Array)
    .map((f) => ({ path: f.path, bytes: f.bytes as Uint8Array }));
  rememberImportedBinaries(binaries);

  return { files };
}

// ---------------------------------------------------------------------------
// Local-header data read + bounded decompression
// ---------------------------------------------------------------------------

const SIG_LFH = 0x04034b50; // Local File Header

async function readEntryData(
  bytes: Uint8Array,
  view: DataView,
  localHeaderOffset: number,
  method: number,
  compSize: number,
  uncompSize: number,
  name: string,
  remainingTotal: number,
): Promise<Uint8Array> {
  if (localHeaderOffset + 30 > bytes.length) {
    throw new ZipImportError("truncated", `entry "${name}" local header runs past end of file`);
  }
  if (view.getUint32(localHeaderOffset, true) !== SIG_LFH) {
    throw new ZipImportError("bad-data", `entry "${name}" has no local file header`);
  }
  const lhNameLen = view.getUint16(localHeaderOffset + 26, true);
  const lhExtraLen = view.getUint16(localHeaderOffset + 28, true);
  const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
  if (dataStart + compSize > bytes.length) {
    throw new ZipImportError("truncated", `entry "${name}" data runs past end of file`);
  }
  // Guard the declared compressed size before doing anything with it: a hostile
  // `compSize` larger than the whole-archive cap is bogus (the slice is bounded
  // by `bytes.length` anyway, but this fails fast and documents the intent).
  if (compSize > MAX_ZIP_BYTES) {
    throw new ZipImportError(
      "entry-too-large",
      `entry "${name}" declares a ${compSize}-byte compressed size; over the ${MAX_ZIP_BYTES}-byte limit`,
    );
  }
  // The effective output ceiling for THIS entry is the smaller of the per-entry
  // cap and the budget left in the archive total. Crossing the budget is an
  // archive-level abort; crossing the per-entry cap (within budget) is an
  // entry-level abort.
  const entryCeiling = Math.min(MAX_ENTRY_BYTES, Math.max(0, remainingTotal));
  const overBudgetIsTotal = remainingTotal < MAX_ENTRY_BYTES;
  const comp = bytes.subarray(dataStart, dataStart + compSize);

  if (method === 0) {
    // Stored: the bytes ARE the content. Cap on the stored (== uncompressed) size
    // against the running budget so a stored entry can't blow the archive total.
    if (comp.length > entryCeiling) {
      throw overBudgetIsTotal && comp.length > remainingTotal
        ? new ZipImportError(
            "archive-too-large",
            `entry "${name}" would push the archive past the ${MAX_TOTAL_BYTES}-byte total limit`,
          )
        : new ZipImportError(
            "entry-too-large",
            `entry "${name}" is ${comp.length} bytes; the per-entry limit is ${MAX_ENTRY_BYTES}`,
          );
    }
    return comp;
  }

  // Deflate (raw). Decompress with a hard output cap counted as we go — the
  // declared `uncompSize` is untrusted, so we never pre-allocate it.
  return inflateRawCapped(comp, name, entryCeiling, overBudgetIsTotal);
}

/**
 * Inflate a raw-deflate stream, aborting as soon as the decompressed output
 * exceeds `ceiling` (DecompressionStream offers no output limit, so the count is
 * enforced here). `ceiling` is the smaller of the per-entry cap and the running
 * archive budget; `overBudgetIsTotal` selects the right error code when the
 * ceiling is the budget. Compressed bytes are fed in BOUNDED sub-chunks (no
 * full-slice copy of an untrusted `compSize`).
 */
async function inflateRawCapped(
  comp: Uint8Array,
  name: string,
  ceiling: number,
  overBudgetIsTotal: boolean,
): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  // Feed the compressed bytes in bounded sub-chunks — never one big copy of an
  // attacker-controlled `compSize`. Each fed chunk is a small standalone buffer
  // (the writer requires a non-shared buffer). Ignore write-side rejections that
  // surface once the reader tears the stream down after a cap abort.
  const pump = (async () => {
    try {
      for (let off = 0; off < comp.length; off += FEED_CHUNK_BYTES) {
        const end = Math.min(off + FEED_CHUNK_BYTES, comp.length);
        const piece = new Uint8Array(end - off);
        piece.set(comp.subarray(off, end));
        await writer.write(piece);
      }
      await writer.close();
    } catch {
      /* reader-side abort closed the pipe; surfaced via the read loop below */
    }
  })();

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        throw new ZipImportError("bad-data", `entry "${name}" is not valid deflate data`);
      }
      if (result.done) break;
      const chunk = result.value;
      total += chunk.length;
      if (total > ceiling) {
        // Cap exceeded: tear the stream down and abort BEFORE buffering more.
        await reader.cancel().catch(() => {});
        throw overBudgetIsTotal
          ? new ZipImportError(
              "archive-too-large",
              `entry "${name}" pushes the archive past the ${MAX_TOTAL_BYTES}-byte total limit`,
            )
          : new ZipImportError(
              "entry-too-large",
              `entry "${name}" decompresses past the per-entry limit of ${MAX_ENTRY_BYTES} bytes`,
            );
      }
      chunks.push(chunk);
    }
  } finally {
    await pump.catch(() => {});
  }

  // Concatenate the capped chunks into one buffer.
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// EOCD discovery
// ---------------------------------------------------------------------------

/**
 * Find the EOCD signature by scanning backwards from the end (the EOCD's
 * trailing comment is variable-length, so it isn't at a fixed offset). The
 * comment is ≤ 0xFFFF, so a 64 KiB + 22 window is sufficient.
 */
function findEocd(bytes: Uint8Array): number | null {
  if (bytes.length < EOCD_MIN_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minStart = Math.max(0, bytes.length - (0xffff + EOCD_MIN_SIZE));
  for (let i = bytes.length - EOCD_MIN_SIZE; i >= minStart; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      // Sanity: the declared comment length must fit exactly to end-of-file
      // (guards against a false signature inside entry data).
      const commentLen = view.getUint16(i + 20, true);
      if (i + EOCD_MIN_SIZE + commentLen === bytes.length) return i;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Path safety + text classification
// ---------------------------------------------------------------------------

/**
 * Validate + normalize a zip entry name to a safe project-relative path. Returns
 * null (→ reject) for anything dangerous: absolute paths, leading `/`, drive
 * letters, backslashes, `..` traversal, or an embedded NUL. A clean name is
 * returned verbatim (forward slashes, no leading slash) so `importLatexProject`
 * normalizes it to its `/`-rooted VFS form.
 */
export function sanitizePath(name: string): string | null {
  if (name.length === 0) return null;
  if (name.includes("\0")) return null; // NUL injection
  if (name.includes("\\")) return null; // backslash (Windows separator / smuggling)
  if (name.startsWith("/")) return null; // absolute / leading slash
  if (/^[A-Za-z]:/.test(name)) return null; // drive-letter absolute (C:foo)
  const parts = name.split("/");
  for (const part of parts) {
    if (part === "..") return null; // traversal
    // "." and "" (empty, e.g. doubled slash) segments are harmless; keep as-is so
    // the downstream normalizer collapses them deterministically.
  }
  return name;
}

/** The result of gating a converted file tree through the project VFS rules. */
export interface SafeProjectFiles {
  /** Files whose `/`-rooted path the VFS will accept (materialize these). */
  kept: ProjectTextFile[];
  /** The `/`-rooted paths that were rejected (surfaced honestly to the user). */
  dropped: string[];
}

/**
 * Gate the FINAL converted `ProjectTextFile[]` (the `importLatexProject` output,
 * whose paths are already `/`-rooted) through `isSafeProjectPath` — the exact
 * predicate `materializeProject` and the version stores enforce. `importLatexProject`
 * rewrites some paths (.tex→.typ), so the input `sanitizePath` gate alone is not
 * sufficient: a path that passed there can still carry a control char or land in
 * the reserved `/.galley` namespace, which would poison the live project with an
 * unexportable file. Anything failing the predicate is dropped (not materialized)
 * and reported, never silently kept.
 */
export function toSafeProjectFiles(files: ProjectTextFile[]): SafeProjectFiles {
  const kept: ProjectTextFile[] = [];
  const dropped: string[] = [];
  for (const f of files) {
    if (isSafeProjectPath(f.path)) kept.push(f);
    else dropped.push(f.path);
  }
  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// Dropped-path surfacing (#17.3 follow-up)
// ---------------------------------------------------------------------------

/**
 * Why a path from the picked archive will NOT land in the project. NOTE:
 * over-cap entries are deliberately absent — the per-entry/total byte caps abort
 * the WHOLE import with a typed `ZipImportError` (fail-closed), so an over-cap
 * path can never appear as a per-path drop.
 */
export type DroppedPathReason =
  | "binary-asset"
  | "latex-style"
  | "unsafe-path"
  | "reserved-namespace"
  | "ignored-entry";

/** One reason-group of dropped paths, ready for calm presentation. */
export interface DroppedPathGroup {
  reason: DroppedPathReason;
  /** User-facing one-line explanation for the whole group. */
  label: string;
  /** Deduped, sorted paths. */
  paths: string[];
}

/** The calm, honest copy for each drop reason (single source for UI + tests). */
export const DROPPED_REASON_LABELS: Record<DroppedPathReason, string> = {
  "binary-asset":
    "Binary files (images, PDFs, fonts) aren't imported yet — Galley projects hold text only. Re-add these in Typst after import.",
  "latex-style":
    "LaTeX class/style files have no Typst equivalent; styling must be redone in Typst.",
  "unsafe-path":
    "The converted path failed the project filesystem safety rules and was not imported.",
  "reserved-namespace":
    ".galley/ is Galley's reserved internal namespace; archive entries under it are never imported.",
  "ignored-entry":
    "Ignored while reading the archive tree (invalid, duplicate, or escaping the project root).",
};

/** Presentation order: most actionable first. */
const DROPPED_REASON_ORDER: DroppedPathReason[] = [
  "binary-asset",
  "latex-style",
  "unsafe-path",
  "reserved-namespace",
  "ignored-entry",
];

/**
 * PURE decision core for the post-unpack "what won't be imported" list: given
 * the converted output tree and the honest migration report, return every
 * dropped path grouped by reason. Sources, in order:
 *
 *  - report outcomes: `asset` (binary bytes are never materialized — the
 *    project substrate is text-only) and `skipped` (.cls/.sty);
 *  - the VFS gate (`toSafeProjectFiles`): output paths the project filesystem
 *    would reject, split into the reserved `/.galley` namespace vs. genuinely
 *    unsafe paths — the SAME gate `onImportProject` applies at Accept time, run
 *    here so the user sees the drop BEFORE accepting;
 *  - entry-level tree warnings (`invalid-entry` / `path-traversal` /
 *    `duplicate-path`): archive entries ignored during normalization. A
 *    `path-traversal` warning is ALSO emitted for an include TARGET inside a
 *    kept file — that warning carries the including file's path, which has an
 *    outcome, so only warning paths with NO outcome count as dropped entries.
 *    A duplicate's path IS imported once (first wins); the ignored copy is
 *    still surfaced, with the label saying so.
 *
 * Deterministic: groups in fixed reason order, paths deduped + sorted.
 */
export function summarizeDroppedPaths(
  files: ProjectTextFile[],
  report: LatexProjectReport,
): DroppedPathGroup[] {
  const buckets = new Map<DroppedPathReason, Set<string>>();
  const add = (reason: DroppedPathReason, path: string) => {
    let set = buckets.get(reason);
    if (!set) buckets.set(reason, (set = new Set()));
    set.add(path);
  };

  for (const o of report.outcomes) {
    if (o.action === "asset") add("binary-asset", o.sourcePath);
    else if (o.action === "skipped") add("latex-style", o.sourcePath);
  }

  for (const p of toSafeProjectFiles(files).dropped) {
    add(isReservedProjectPath(p) ? "reserved-namespace" : "unsafe-path", p);
  }

  const outcomePaths = new Set(report.outcomes.map((o) => o.sourcePath));
  for (const w of report.warnings) {
    if (w.path === undefined) continue;
    if (w.kind === "duplicate-path") {
      add("ignored-entry", w.path);
    } else if (
      (w.kind === "invalid-entry" || w.kind === "path-traversal") &&
      !outcomePaths.has(w.path)
    ) {
      add("ignored-entry", w.path);
    }
  }

  return DROPPED_REASON_ORDER.filter((r) => buckets.has(r)).map((reason) => ({
    reason,
    label: DROPPED_REASON_LABELS[reason],
    paths: [...buckets.get(reason)!].sort(),
  }));
}

const TEXT_EXTS = [
  ".tex", ".bib", ".cls", ".sty", ".txt", ".md", ".markdown",
  ".bbl", ".bst", ".cfg", ".def", ".ltx", ".latex", ".csv", ".json",
  ".yml", ".yaml", ".typ",
];

/** Treat known LaTeX/text extensions as text; everything else is a binary asset. */
function isTextPath(path: string): boolean {
  const lower = path.toLowerCase();
  return TEXT_EXTS.some((ext) => lower.endsWith(ext));
}
