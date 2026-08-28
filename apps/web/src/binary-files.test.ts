import { describe, it, expect, beforeEach } from "vitest";
import type { BinaryAsset } from "@galley/collab";
import {
  pendingHashes,
  buildBinaryFilesInput,
  normalizeImportedBinaries,
  rememberImportedBinaries,
  takeImportedBinaries,
  setPendingBinarySeed,
  takePendingBinarySeed,
  formatBytes,
  type ResolvedBinaryCache,
  type PendingBinaryPointer,
} from "./binary-files.js";

/**
 * `binary-files` is the PURE core of #7 slice 7D (binary-file app wiring). It
 * holds the logic that must work WITHOUT React or IndexedDB so it can be unit
 * tested: which binary hashes still need fetching from the BlobStore, how the
 * resolved-bytes cache becomes the compiler's `binaryFiles` input, how imported
 * binary entries are sanitized, and the two in-process handoff slots (latest
 * imported binaries; per-project pending CRDT pointers).
 */

/** A tiny BinaryFileSnapshot-shaped object for the pure resolver helpers. */
function snap(path: string, hash: string, deleted = false) {
  return { fileId: `f-${hash}`, path, hash, size: 3, mime: "image/png", deleted };
}

describe("pendingHashes", () => {
  it("returns the non-deleted hashes that are MISSING from the cache", () => {
    const cache: ResolvedBinaryCache = new Map([["aaa", new Uint8Array([1])]]);
    const files = [snap("/a.png", "aaa"), snap("/b.png", "bbb"), snap("/c.png", "ccc")];
    expect(pendingHashes(files, cache).sort()).toEqual(["bbb", "ccc"]);
  });

  it("skips deleted pointers — a tombstoned binary is not fetched", () => {
    const cache: ResolvedBinaryCache = new Map();
    const files = [snap("/a.png", "aaa", true), snap("/b.png", "bbb")];
    expect(pendingHashes(files, cache)).toEqual(["bbb"]);
  });

  it("dedupes — two pointers sharing one hash yield a single fetch", () => {
    const cache: ResolvedBinaryCache = new Map();
    const files = [snap("/a.png", "dup"), snap("/b.png", "dup")];
    expect(pendingHashes(files, cache)).toEqual(["dup"]);
  });

  it("is empty when there are no binary files", () => {
    expect(pendingHashes([], new Map())).toEqual([]);
    expect(pendingHashes(undefined, new Map())).toEqual([]);
  });

  it("is empty when every hash is already cached", () => {
    const cache: ResolvedBinaryCache = new Map([["aaa", new Uint8Array()]]);
    expect(pendingHashes([snap("/a.png", "aaa")], cache)).toEqual([]);
  });
});

describe("buildBinaryFilesInput", () => {
  it("maps RESOLVED pointers to {path, bytes}, sorted by path", () => {
    const cache: ResolvedBinaryCache = new Map([
      ["aaa", new Uint8Array([1, 2])],
      ["bbb", new Uint8Array([3])],
    ]);
    const files = [snap("/z.png", "bbb"), snap("/a.png", "aaa")];
    expect(buildBinaryFilesInput(files, cache)).toEqual([
      { path: "/a.png", bytes: new Uint8Array([1, 2]) },
      { path: "/z.png", bytes: new Uint8Array([3]) },
    ]);
  });

  it("SKIPS pointers whose bytes are not yet resolved (no throw)", () => {
    const cache: ResolvedBinaryCache = new Map([["aaa", new Uint8Array([1])]]);
    const files = [snap("/a.png", "aaa"), snap("/b.png", "bbb")];
    expect(buildBinaryFilesInput(files, cache)).toEqual([
      { path: "/a.png", bytes: new Uint8Array([1]) },
    ]);
  });

  it("SKIPS deleted pointers even if their bytes are cached", () => {
    const cache: ResolvedBinaryCache = new Map([["aaa", new Uint8Array([1])]]);
    const files = [snap("/a.png", "aaa", true)];
    expect(buildBinaryFilesInput(files, cache)).toEqual([]);
  });

  it("is empty for no binaries (text-only stays binaryFiles-free)", () => {
    expect(buildBinaryFilesInput(undefined, new Map())).toEqual([]);
    expect(buildBinaryFilesInput([], new Map())).toEqual([]);
  });
});

describe("normalizeImportedBinaries", () => {
  it("canonicalizes a relative path to a leading slash", () => {
    const out = normalizeImportedBinaries([{ path: "img/logo.png", bytes: new Uint8Array([1]) }]);
    expect(out).toEqual([{ path: "/img/logo.png", bytes: new Uint8Array([1]) }]);
  });

  it("keeps an already-canonical path", () => {
    const out = normalizeImportedBinaries([{ path: "/a.png", bytes: new Uint8Array() }]);
    expect(out[0]?.path).toBe("/a.png");
  });

  it("drops VFS-unsafe paths (traversal, reserved namespace, control chars)", () => {
    const out = normalizeImportedBinaries([
      { path: "../escape.png", bytes: new Uint8Array() },
      { path: ".galley/x.png", bytes: new Uint8Array() },
      { path: "ok.png", bytes: new Uint8Array() },
    ]);
    expect(out.map((b) => b.path)).toEqual(["/ok.png"]);
  });

  it("dedupes by path (first wins)", () => {
    const out = normalizeImportedBinaries([
      { path: "a.png", bytes: new Uint8Array([1]) },
      { path: "a.png", bytes: new Uint8Array([2]) },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.bytes).toEqual(new Uint8Array([1]));
  });

  it("is empty for empty input", () => {
    expect(normalizeImportedBinaries([])).toEqual([]);
    expect(normalizeImportedBinaries(undefined)).toEqual([]);
  });
});

describe("imported-binaries handoff (latest slot)", () => {
  beforeEach(() => {
    takeImportedBinaries(); // clear
  });

  it("remembers the latest set and takes it once", () => {
    rememberImportedBinaries([{ path: "/a.png", bytes: new Uint8Array([1]) }]);
    expect(takeImportedBinaries()).toEqual([{ path: "/a.png", bytes: new Uint8Array([1]) }]);
    // consumed
    expect(takeImportedBinaries()).toEqual([]);
  });

  it("a later remember replaces an earlier one (one pick at a time)", () => {
    rememberImportedBinaries([{ path: "/a.png", bytes: new Uint8Array([1]) }]);
    rememberImportedBinaries([{ path: "/b.png", bytes: new Uint8Array([2]) }]);
    expect(takeImportedBinaries()).toEqual([{ path: "/b.png", bytes: new Uint8Array([2]) }]);
  });

  it("returns [] when nothing was remembered", () => {
    expect(takeImportedBinaries()).toEqual([]);
  });
});

describe("formatBytes", () => {
  it("renders bytes below a kilobyte as whole B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(812)).toBe("812 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });
  it("renders kilobytes/megabytes with one decimal", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
  });
  it("is defensive about bad input", () => {
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(NaN)).toBe("0 B");
  });
});

describe("pending-binary-seed handoff (per-project)", () => {
  const asset = (hash: string): BinaryAsset => ({ type: "binary", hash, size: 1, mime: "image/png" });

  it("stashes pointers per project and takes them ONCE (consume-once)", () => {
    const pointers: PendingBinaryPointer[] = [{ path: "/a.png", asset: asset("aaa") }];
    setPendingBinarySeed("proj-1", pointers);
    expect(takePendingBinarySeed("proj-1")).toEqual(pointers);
    expect(takePendingBinarySeed("proj-1")).toBeUndefined();
  });

  it("isolates projects — taking one never drains another", () => {
    setPendingBinarySeed("proj-1", [{ path: "/a.png", asset: asset("aaa") }]);
    setPendingBinarySeed("proj-2", [{ path: "/b.png", asset: asset("bbb") }]);
    expect(takePendingBinarySeed("proj-1")?.[0]?.path).toBe("/a.png");
    expect(takePendingBinarySeed("proj-2")?.[0]?.path).toBe("/b.png");
  });

  it("is undefined for an unknown project", () => {
    expect(takePendingBinarySeed("nope")).toBeUndefined();
  });
});
