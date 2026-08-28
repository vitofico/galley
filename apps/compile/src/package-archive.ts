/**
 * Package-archive CORE (roadmap #3 slice 5a) — the security-critical, **pure**
 * (no network, no FS) byte handling for a fetched Typst package: capped gunzip,
 * a STRICT ustar reader, and SHA-256 integrity verification. Designed against a
 * Security-Analyst (GPT) threat model (ADR-0016): the parser is deliberately
 * intolerant — it accepts only regular files, verifies header checksums, refuses
 * PAX/GNU/base-256/sparse encodings and truncation, and never allocates on a
 * header's word. Extraction is in-memory only; the returned raw files still pass
 * through ADR-0014 `resolvePackagePaths` downstream (the single re-root/validation
 * gate). The network fetch that feeds this is slice 5b.
 */
import { gunzip as gunzipCb } from "node:zlib";
import { createHash, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const gunzipAsync = promisify(gunzipCb);

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

/** Caps for one package archive (DoS guards). */
export interface ArchiveLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxFiles: 64,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
};

/**
 * Gunzip with a hard absolute output cap (zip-bomb guard). `maxOutputLength`
 * makes zlib throw once output would exceed the cap, so a tiny compressed body
 * can't expand without bound. Async, so it never blocks the event loop on the
 * request path.
 */
export async function gunzipWithCap(gz: Uint8Array, maxOutputBytes: number): Promise<Uint8Array> {
  try {
    const out = await gunzipAsync(gz, { maxOutputLength: maxOutputBytes });
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  } catch {
    // Includes the RangeError zlib throws past maxOutputLength.
    throw new ArchiveError("gunzip failed or exceeded the decompressed size cap");
  }
}

const BLOCK = 512;
const utf8Strict = new TextDecoder("utf-8", { fatal: true });

/** Strict UTF-8 decode, surfacing invalid bytes as an ArchiveError (not a raw TypeError). */
function decodeUtf8(bytes: Uint8Array): string {
  try {
    return utf8Strict.decode(bytes);
  } catch {
    throw new ArchiveError("invalid UTF-8 in archive");
  }
}

function readOctal(field: Uint8Array): number {
  // Reject GNU base-256 sizes (high bit set) outright — we don't support them.
  if ((field[0]! & 0x80) !== 0) throw new ArchiveError("base-256/binary numeric field rejected");
  let s = "";
  for (const b of field) {
    if (b === 0 || b === 0x20) break; // NUL or space terminates
    if (b < 0x30 || b > 0x37) throw new ArchiveError("non-octal byte in numeric field");
    s += String.fromCharCode(b);
  }
  if (s.length === 0) return 0;
  return Number.parseInt(s, 8);
}

function headerChecksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    // The checksum field [148,156) is treated as spaces during computation.
    sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  }
  return sum;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < BLOCK; i++) if (block[i] !== 0) return false;
  return true;
}

function cstr(field: Uint8Array): string {
  let end = field.indexOf(0);
  if (end === -1) end = field.length;
  return decodeUtf8(field.subarray(0, end));
}

/**
 * Parse a STRICT ustar archive into raw `{ path, text }` files. Throws
 * `ArchiveError` on anything irregular: bad checksum, truncation, trailing
 * garbage after the end marker, base-256 sizes, non-regular entries
 * (symlink/hardlink/device/fifo), GNU/PAX extensions, invalid UTF-8, traversal,
 * or any cap breach. Directory entries are skipped (harmless, no data).
 */
export function untarStrict(
  data: Uint8Array,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): Array<{ path: string; text: string }> {
  if (data.length % BLOCK !== 0) throw new ArchiveError("archive length is not a multiple of 512");
  const out: Array<{ path: string; text: string }> = [];
  let total = 0;
  let offset = 0;

  while (offset + BLOCK <= data.length) {
    const header = data.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) {
      // End-of-archive: everything after the (one or two) zero blocks must be
      // zero padding — reject any trailing non-zero garbage.
      for (let i = offset; i < data.length; i++) {
        if (data[i] !== 0) throw new ArchiveError("non-zero data after end-of-archive marker");
      }
      return out;
    }

    // Verify the header checksum before trusting any field.
    const stored = readOctal(header.subarray(148, 156));
    if (stored !== headerChecksum(header)) throw new ArchiveError("bad tar header checksum");

    const typeflag = header[156]!;
    const size = readOctal(header.subarray(124, 136));
    if (size < 0 || !Number.isSafeInteger(size)) throw new ArchiveError("invalid entry size");

    // Regular file = '0' (0x30) or NUL (0x00). Directory = '5' (skip). Everything
    // else — symlink '2', hardlink '1', char/block/fifo '3'/'4'/'6', GNU 'L'/'K',
    // PAX 'x'/'g', etc. — is rejected.
    const isRegular = typeflag === 0x30 || typeflag === 0;
    const isDir = typeflag === 0x35;
    if (!isRegular && !isDir) {
      throw new ArchiveError(`unsupported tar entry type: 0x${typeflag.toString(16)}`);
    }

    const dataStart = offset + BLOCK;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (dataStart + padded > data.length) throw new ArchiveError("truncated archive entry data");

    if (isRegular) {
      if (size > limits.maxFileBytes) throw new ArchiveError("package file exceeds size cap");
      total += size;
      if (total > limits.maxTotalBytes) throw new ArchiveError("package exceeds total size cap");
      if (out.length >= limits.maxFiles) throw new ArchiveError("package exceeds file-count cap");

      const name = cstr(header.subarray(0, 100));
      const prefix = cstr(header.subarray(345, 500));
      const path = prefix ? `${prefix}/${name}` : name;
      // Defense in depth (resolvePackagePaths is the authoritative gate downstream).
      if (path.length === 0 || path.includes("\0") || path.split("/").some((s) => s === ".." )) {
        throw new ArchiveError(`illegal path in archive: ${JSON.stringify(path)}`);
      }
      const text = decodeUtf8(data.subarray(dataStart, dataStart + size));
      out.push({ path, text });
    }

    offset = dataStart + padded;
  }
  // Ran off the end without a zero-block terminator.
  throw new ArchiveError("missing end-of-archive marker");
}

/** Lowercase hex SHA-256 of bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Verify fetched bytes against an expected `{ sha256, size }` integrity entry,
 * in constant time. Throws `ArchiveError` on any mismatch — the caller fails
 * closed. The expected entry comes from an operator-supplied manifest (5b); there
 * is no "skip when absent" in the production path.
 */
export function verifyIntegrity(bytes: Uint8Array, expected: { sha256: string; size: number }): void {
  if (bytes.length !== expected.size) throw new ArchiveError("package size mismatch");
  const got = Buffer.from(sha256Hex(bytes), "hex");
  const want = Buffer.from(expected.sha256, "hex");
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    throw new ArchiveError("package hash mismatch");
  }
}
