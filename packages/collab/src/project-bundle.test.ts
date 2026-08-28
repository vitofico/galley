/**
 * Roadmap #17.5 (Lane D) — export-as-bundle core. "Data outlives the app": a
 * project can be downloaded as a single deterministic **ustar tar** containing
 * every materialized file at its relative path plus the `.galley/project.json`
 * manifest. This is the cheapest first cut — only the `.typ`/tar bundle; HTML,
 * per-page raster, and real git-repo export are deferred (wave4).
 *
 * Pure + deterministic + offline. We build the tar from a `ProjectSnapshot` and
 * parse it back with a tiny inline ustar reader (below) to prove each file +
 * the manifest round-trips, and that identical snapshots yield identical bytes.
 */
import { describe, it, expect } from "vitest";
import { bundleProject, writeUstar } from "./project-bundle.js";
import { PROJECT_MANIFEST_PATH } from "./materialize.js";
import type { ProjectSnapshot } from "./collab-project.js";

function snap(
  files: { fileId: string; path: string; text: string; deleted?: boolean }[],
  mainFileId: string | null,
  duplicatePaths: string[] = [],
): ProjectSnapshot {
  return { files: files.map((f) => ({ deleted: false, ...f })), mainFileId, duplicatePaths };
}

// --- Tiny inline ustar reader (test-only, independent of the writer) ---------
interface TarEntry {
  name: string;
  size: number;
  mode: string;
  typeflag: string;
  magic: string;
  version: string;
  bytes: Uint8Array;
  checksumOk: boolean;
}

const dec = new TextDecoder();

/** Read a NUL-terminated ASCII field from a 512-byte header block. */
function field(block: Uint8Array, off: number, len: number): string {
  const slice = block.subarray(off, off + len);
  let end = slice.indexOf(0);
  if (end === -1) end = slice.length;
  return dec.decode(slice.subarray(0, end)).replace(/[\s\0]+$/, "");
}

/** Verify the ustar header checksum (sum of all header bytes with the 8-byte
 * checksum field read as spaces). */
function verifyChecksum(block: Uint8Array): boolean {
  const stored = parseInt(field(block, 148, 8), 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  }
  return sum === stored;
}

function parseTar(bytes: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let off = 0;
  while (off + 512 <= bytes.length) {
    const header = bytes.subarray(off, off + 512);
    // Two consecutive zero blocks terminate the archive.
    if (header.every((b) => b === 0)) break;
    const name = field(header, 0, 100);
    const mode = field(header, 100, 8);
    const size = parseInt(field(header, 124, 12), 8);
    const typeflag = String.fromCharCode(header[156]!);
    // magic is "ustar\0" (6 bytes); compare against the 5-char prefix.
    const magic = dec.decode(header.subarray(257, 262));
    const version = dec.decode(header.subarray(263, 265));
    const checksumOk = verifyChecksum(header);
    off += 512;
    const data = bytes.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    entries.push({ name, size, mode, typeflag, magic, version, bytes: data, checksumOk });
  }
  return entries;
}

describe("bundleProject (export-as-tar bundle)", () => {
  it("bundles a 2-file project + manifest into a round-trippable ustar tar", () => {
    const s = snap(
      [
        { fileId: "f0", path: "/main.typ", text: '#import "intro.typ"\n= Title' },
        { fileId: "f1", path: "/intro.typ", text: "Intro body" },
      ],
      "f0",
    );
    const out = bundleProject(s);
    expect("error" in out).toBe(false);
    if ("error" in out) return;

    expect(out.filename).toMatch(/\.tar$/);
    // Tar length is always a 512 multiple (headers + padded data + 2 end blocks).
    expect(out.bytes.length % 512).toBe(0);

    const entries = parseTar(out.bytes);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));

    // Every entry has a valid header checksum, ustar magic, regular-file type.
    for (const e of entries) {
      expect(e.checksumOk).toBe(true);
      expect(e.magic).toBe("ustar");
      expect(e.version).toBe("00");
      expect(e.typeflag).toBe("0");
      expect(e.mode).toBe("000644");
    }

    // Both source files round-trip at their relative paths.
    const mainEntry = byName["main.typ"]!;
    const introEntry = byName["intro.typ"]!;
    expect(dec.decode(mainEntry.bytes)).toBe('#import "intro.typ"\n= Title');
    expect(dec.decode(introEntry.bytes)).toBe("Intro body");
    expect(mainEntry.size).toBe(
      new TextEncoder().encode('#import "intro.typ"\n= Title').length,
    );

    // The manifest is present and is valid JSON recording structure.
    const manifestRaw = dec.decode(byName[PROJECT_MANIFEST_PATH]!.bytes);
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.schema).toBe("galley.project/v1");
    expect(manifest.main).toBe("/main.typ");
    expect(manifest.files).toEqual([
      { path: "/intro.typ", fileId: "f1" },
      { path: "/main.typ", fileId: "f0" },
    ]);

    // Entries are sorted by path → deterministic ordering in the archive.
    const names = entries.map((e) => e.name);
    expect(names).toEqual([...names].slice().sort());
    expect(names).toContain(".galley/project.json");
  });

  it("is deterministic: identical snapshots produce byte-identical bundles", () => {
    const build = () =>
      bundleProject(
        snap(
          [
            { fileId: "f0", path: "/main.typ", text: "= Doc" },
            { fileId: "f1", path: "/a/b.typ", text: "nested" },
          ],
          "f0",
        ),
      );
    const a = build();
    const b = build();
    expect("error" in a).toBe(false);
    expect("error" in b).toBe(false);
    if ("error" in a || "error" in b) return;
    expect(Array.from(a.bytes)).toEqual(Array.from(b.bytes));
  });

  it("pads non-512-aligned file content to a 512 boundary", () => {
    const out = bundleProject(snap([{ fileId: "f0", path: "/x.typ", text: "abc" }], "f0"));
    if ("error" in out) throw new Error(out.error);
    // 3-byte file → its data block is padded to 512.
    const entries = parseTar(out.bytes);
    const x = entries.find((e) => e.name === "x.typ")!;
    expect(x.size).toBe(3);
    expect(dec.decode(x.bytes)).toBe("abc");
    expect(out.bytes.length % 512).toBe(0);
  });

  it("carries the .galley/instructions config in the bundle (14-D export round-trip)", () => {
    const s = snap(
      [
        { fileId: "f0", path: "/main.typ", text: "= Doc" },
        { fileId: "fi", path: "/.galley/instructions", text: "Write tersely.\n\n## Constraints\nmax-words: 800" },
      ],
      "f0",
    );
    const out = bundleProject(s);
    if ("error" in out) throw new Error(out.error);
    const entries = parseTar(out.bytes);
    const instr = entries.find((e) => e.name === ".galley/instructions");
    expect(instr).toBeDefined();
    expect(dec.decode(instr!.bytes)).toBe("Write tersely.\n\n## Constraints\nmax-words: 800");
    // Still deterministic + sorted, manifest untouched by the config entry.
    const names = entries.map((e) => e.name);
    expect(names).toEqual([...names].slice().sort());
    const manifest = JSON.parse(dec.decode(entries.find((e) => e.name === PROJECT_MANIFEST_PATH)!.bytes));
    expect(manifest.files).toEqual([{ path: "/main.typ", fileId: "f0" }]);
  });

  it("a project without instructions bundles byte-identically to before (no config entry)", () => {
    const out = bundleProject(snap([{ fileId: "f0", path: "/main.typ", text: "= Doc" }], "f0"));
    if ("error" in out) throw new Error(out.error);
    const names = parseTar(out.bytes).map((e) => e.name);
    expect(names).toEqual([".galley/project.json", "main.typ"]);
  });

  it("carries binary file bytes through the bundle at their relative path (#7 7C-4)", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const s: ProjectSnapshot = {
      ...snap([{ fileId: "f0", path: "/main.typ", text: "= D" }], "f0"),
      binaryFiles: [
        { fileId: "b0", path: "/figures/logo.png", hash: "h1", size: png.length, mime: "image/png", deleted: false },
      ],
    };
    const out = bundleProject(s, new Map([["h1", png]]));
    if ("error" in out) throw new Error(out.error);
    expect(out.omitted).toBeUndefined();
    const entries = parseTar(out.bytes);
    const logo = entries.find((e) => e.name === "figures/logo.png")!;
    expect(logo).toBeDefined();
    expect(Array.from(logo.bytes)).toEqual(Array.from(png));
    expect(logo.size).toBe(png.length);
    // Still sorted + deterministic, manifest unaffected by the binary.
    const names = entries.map((e) => e.name);
    expect(names).toEqual([...names].slice().sort());
  });

  it("omits a binary whose bytes aren't supplied and reports it (graceful degrade)", () => {
    const s: ProjectSnapshot = {
      ...snap([{ fileId: "f0", path: "/main.typ", text: "= D" }], "f0"),
      binaryFiles: [
        { fileId: "b0", path: "/missing.png", hash: "absent", size: 3, mime: "image/png", deleted: false },
      ],
    };
    const out = bundleProject(s); // no blob map → bytes unavailable
    if ("error" in out) throw new Error(out.error);
    expect(out.omitted).toEqual(["/missing.png"]);
    const names = parseTar(out.bytes).map((e) => e.name);
    expect(names).not.toContain("missing.png");
  });

  it("a project with no binaries bundles byte-identically with or without a blob map", () => {
    const s = snap([{ fileId: "f0", path: "/main.typ", text: "= D" }], "f0");
    const a = bundleProject(s);
    const b = bundleProject(s, new Map([["unused", new Uint8Array([1, 2])]]));
    if ("error" in a || "error" in b) throw new Error("unexpected error");
    expect(Array.from(a.bytes)).toEqual(Array.from(b.bytes));
  });

  it("fails closed on a duplicate live path (materialize failure → error)", () => {
    const s = snap(
      [
        { fileId: "f0", path: "/dup.typ", text: "one" },
        { fileId: "f1", path: "/dup.typ", text: "two" },
      ],
      "f0",
    );
    const out = bundleProject(s);
    expect("error" in out).toBe(true);
    if ("error" in out) expect(out.error).toContain("dup.typ");
  });

  it("fails closed when the project has no main file", () => {
    const s = snap([{ fileId: "f0", path: "/orphan.typ", text: "x" }], null);
    const out = bundleProject(s);
    expect("error" in out).toBe(true);
    if ("error" in out) expect(out.error.toLowerCase()).toContain("main");
  });
});

describe("writeUstar (reusable archive core — shared with the git-repo export)", () => {
  it("writes directory entries (typeflag '5', mode 0755, trailing slash, no data)", () => {
    const bytes = writeUstar([
      { type: "dir", path: "repo" },
      { type: "dir", path: "repo/refs/" },
      { type: "file", path: "repo/HEAD", bytes: new TextEncoder().encode("ref: refs/heads/main\n") },
    ]);
    expect(bytes.length % 512).toBe(0);
    const entries = parseTar(bytes);
    expect(entries.map((e) => [e.name, e.typeflag, e.mode])).toEqual([
      ["repo/", "5", "000755"],
      ["repo/refs/", "5", "000755"],
      ["repo/HEAD", "0", "000644"],
    ]);
    for (const e of entries) expect(e.checksumOk).toBe(true);
    expect(entries[0]!.size).toBe(0);
    expect(dec.decode(entries[2]!.bytes)).toBe("ref: refs/heads/main\n");
  });

  it("carries binary file bytes through unchanged (git loose objects are zlib, not text)", () => {
    const blob = new Uint8Array([0x78, 0x9c, 0x00, 0xff, 0x01, 0x80]);
    const entries = parseTar(writeUstar([{ type: "file", path: "objects/ab/cd", bytes: blob }]));
    expect(Array.from(entries[0]!.bytes)).toEqual(Array.from(blob));
  });
});
