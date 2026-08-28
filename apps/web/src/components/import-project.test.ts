import { describe, it, expect } from "vitest";
import { importLatexProject } from "@galley/agent";
import type { LatexProjectReport } from "@galley/agent";
import {
  readProjectZip,
  sanitizePath,
  summarizeDroppedPaths,
  toSafeProjectFiles,
  ZipImportError,
  DROPPED_REASON_LABELS,
  MAX_ENTRY_BYTES,
  MAX_TOTAL_BYTES,
  MAX_ENTRY_COUNT,
  MAX_ZIP_BYTES,
} from "./import-project.js";
import { takeImportedBinaries } from "../binary-files.js";

/**
 * The zip reader is the risky part: a hand-rolled, deliberately narrow parser
 * (EOCD + central directory, methods 0/8 only) with hard streaming caps. These
 * tests construct real zips byte-for-byte — stored entries by hand and deflate
 * entries via the native `CompressionStream("deflate-raw")` — and assert both the
 * happy path (mixed stored + deflate → correct tree, feeding importLatexProject)
 * and the full rejection matrix (encrypted / ZIP64 / multi-disk / unsafe path /
 * over-cap), proving aborts happen WHILE streaming rather than OOMing.
 */

// ── Minimal zip builder (test-only) ─────────────────────────────────────────

interface BuildEntry {
  name: string;
  /** Raw uncompressed bytes (text encoded to UTF-8 by the caller). */
  data: Uint8Array;
  /** 0 = stored, 8 = deflate. Default stored. */
  method?: 0 | 8;
  /** Force the general-purpose flag (e.g. encryption bit). */
  gpFlag?: number;
}

const te = new TextEncoder();
function bytes(s: string): Uint8Array {
  return te.encode(s);
}

// CRC-32 (the zip polynomial) — required so a real unzip would accept the output;
// our reader doesn't check it, but keeping it correct keeps the fixtures honest.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  const chunk = new Uint8Array(data.length);
  chunk.set(data);
  void writer.write(chunk);
  void writer.close();
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Build a valid zip from entries. `mutate` can patch the assembled buffer for the
 * negative-test variants (set ZIP64 sentinels, multi-disk counts, etc.).
 */
async function buildZip(
  entries: BuildEntry[],
  mutate?: (parts: ZipParts) => void,
): Promise<Uint8Array> {
  const localChunks: Uint8Array[] = [];
  const central: { header: Uint8Array; name: Uint8Array }[] = [];
  let offset = 0;

  const eocdFields: { count: number } = { count: entries.length };

  for (const e of entries) {
    const method = e.method ?? 0;
    const stored = method === 8 ? await deflateRaw(e.data) : e.data;
    const crc = crc32(e.data);
    const name = bytes(e.name);
    const gp = e.gpFlag ?? 0;

    const lfh = new DataView(new ArrayBuffer(30));
    lfh.setUint32(0, 0x04034b50, true);
    lfh.setUint16(4, 20, true); // version needed
    lfh.setUint16(6, gp, true);
    lfh.setUint16(8, method, true);
    lfh.setUint16(10, 0, true); // time
    lfh.setUint16(12, 0, true); // date
    lfh.setUint32(14, crc, true);
    lfh.setUint32(18, stored.length, true);
    lfh.setUint32(22, e.data.length, true);
    lfh.setUint16(26, name.length, true);
    lfh.setUint16(28, 0, true); // extra len
    const lfhBytes = new Uint8Array(lfh.buffer);

    const localOffset = offset;
    localChunks.push(lfhBytes, name, stored);
    offset += lfhBytes.length + name.length + stored.length;

    const cdh = new DataView(new ArrayBuffer(46));
    cdh.setUint32(0, 0x02014b50, true);
    cdh.setUint16(4, 20, true); // version made by
    cdh.setUint16(6, 20, true); // version needed
    cdh.setUint16(8, gp, true);
    cdh.setUint16(10, method, true);
    cdh.setUint16(12, 0, true);
    cdh.setUint16(14, 0, true);
    cdh.setUint32(16, crc, true);
    cdh.setUint32(20, stored.length, true);
    cdh.setUint32(24, e.data.length, true);
    cdh.setUint16(28, name.length, true);
    cdh.setUint16(30, 0, true); // extra
    cdh.setUint16(32, 0, true); // comment
    cdh.setUint16(34, 0, true); // disk start
    cdh.setUint16(36, 0, true); // internal attrs
    cdh.setUint32(38, 0, true); // external attrs
    cdh.setUint32(42, localOffset, true);
    const cdhBytes = new Uint8Array(cdh.buffer);
    central.push({ header: cdhBytes, name });
  }

  const cdStart = offset;
  const centralChunks: Uint8Array[] = [];
  for (const c of central) {
    centralChunks.push(c.header, c.name);
  }
  const cdSize = centralChunks.reduce((n, c) => n + c.length, 0);

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true); // disk number
  eocd.setUint16(6, 0, true); // cd start disk
  eocd.setUint16(8, eocdFields.count, true); // entries this disk
  eocd.setUint16(10, eocdFields.count, true); // entries total
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  eocd.setUint16(20, 0, true); // comment len

  const parts: ZipParts = {
    local: localChunks,
    central: centralChunks,
    eocd: new Uint8Array(eocd.buffer),
  };
  if (mutate) mutate(parts);

  const all = [...parts.local, ...parts.central, parts.eocd];
  const total = all.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of all) {
    buf.set(c, at);
    at += c.length;
  }
  return buf;
}

interface ZipParts {
  local: Uint8Array[];
  central: Uint8Array[];
  eocd: Uint8Array;
}

// ── Happy path ──────────────────────────────────────────────────────────────

describe("readProjectZip — valid archives", () => {
  it("unpacks a mixed stored + deflate archive into the agent's input tree", async () => {
    const main = "\\documentclass{article}\\begin{document}Hello\\end{document}";
    const chap = "\\section{Intro}";
    const zip = await buildZip([
      { name: "main.tex", data: bytes(main), method: 0 },
      { name: "chapters/intro.tex", data: bytes(chap), method: 8 },
    ]);

    const input = await readProjectZip(zip);
    const byPath = new Map(input.files.map((f) => [f.path, f]));
    expect(byPath.get("main.tex")?.text).toBe(main);
    expect(byPath.get("chapters/intro.tex")?.text).toBe(chap);

    // It feeds importLatexProject end-to-end.
    const result = importLatexProject(input);
    expect(result.mainPath).toBe("/main.typ");
    expect(result.files.some((f) => f.path === "/chapters/intro.typ")).toBe(true);
  });

  it("skips directory entries and marks non-text files as binary assets", async () => {
    const zip = await buildZip([
      { name: "figs/", data: new Uint8Array(0), method: 0 },
      { name: "figs/plot.png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), method: 0 },
      { name: "main.tex", data: bytes("\\documentclass{article}\\begin{document}x\\end{document}"), method: 8 },
    ]);
    const input = await readProjectZip(zip);
    const paths = input.files.map((f) => f.path);
    expect(paths).not.toContain("figs/"); // directory skipped
    const png = input.files.find((f) => f.path === "figs/plot.png");
    expect(png?.binary).toBe(true);
    expect(png?.text).toBeUndefined();
  });

  it("round-trips an empty-content deflate entry", async () => {
    const zip = await buildZip([{ name: "main.tex", data: bytes(""), method: 8 }]);
    const input = await readProjectZip(zip);
    expect(input.files.find((f) => f.path === "main.tex")?.text).toBe("");
  });

  // #7 7D: the reader records the picked archive's binary bytes into the
  // in-process handoff slot so the Accept handler can persist them into the new
  // project's BlobStore. (The new project navigates away; ImportPanel is frozen,
  // so the bytes cross via this side channel — mirroring the text pending-seed.)
  it("records binary entries into the imported-binaries handoff slot", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const zip = await buildZip([
      { name: "figs/plot.png", data: png, method: 0 },
      { name: "main.tex", data: bytes("\\documentclass{article}\\begin{document}x\\end{document}"), method: 8 },
    ]);
    await readProjectZip(zip);
    const recorded = takeImportedBinaries();
    expect(recorded).toEqual([{ path: "figs/plot.png", bytes: png }]);
    // consume-once: a second take is empty
    expect(takeImportedBinaries()).toEqual([]);
  });

  it("records an EMPTY handoff for a text-only archive (no binaries dropped in)", async () => {
    const zip = await buildZip([{ name: "main.tex", data: bytes("\\documentclass{article}"), method: 8 }]);
    await readProjectZip(zip);
    expect(takeImportedBinaries()).toEqual([]);
  });
});

// ── Rejection matrix ──────────────────────────────────────────────────────────

async function expectReject(
  zip: Uint8Array,
  code: ZipImportError["code"],
): Promise<void> {
  await expect(readProjectZip(zip)).rejects.toMatchObject({
    name: "ZipImportError",
    code,
  });
}

describe("readProjectZip — typed rejections", () => {
  it("rejects a non-zip blob", async () => {
    await expectReject(bytes("not a zip at all, no EOCD here"), "not-a-zip");
  });

  it("rejects an encrypted entry (GP-flag bit 0)", async () => {
    const zip = await buildZip([{ name: "main.tex", data: bytes("x"), gpFlag: 0x0001 }]);
    await expectReject(zip, "encrypted");
  });

  it("rejects a ZIP64 archive (sentinel CD offset + EOCD locator)", async () => {
    // Patch the EOCD's CD-offset field to the 0xFFFFFFFF sentinel.
    const zip = await buildZip([{ name: "main.tex", data: bytes("x") }], (parts) => {
      const dv = new DataView(parts.eocd.buffer, parts.eocd.byteOffset, parts.eocd.byteLength);
      dv.setUint32(16, 0xffffffff, true);
    });
    await expectReject(zip, "zip64");
  });

  it("rejects a multi-disk archive", async () => {
    const zip = await buildZip([{ name: "main.tex", data: bytes("x") }], (parts) => {
      const dv = new DataView(parts.eocd.buffer, parts.eocd.byteOffset, parts.eocd.byteLength);
      dv.setUint16(4, 1, true); // this is disk #1
      dv.setUint16(6, 1, true); // cd starts on disk #1
    });
    await expectReject(zip, "multi-disk");
  });

  it("rejects an unsupported compression method (bzip2 = 12)", async () => {
    const zip = await buildZip([{ name: "main.tex", data: bytes("x") }], (parts) => {
      // Patch the method in BOTH the central header and the local header to 12.
      const cdh = parts.central[0]!;
      new DataView(cdh.buffer, cdh.byteOffset, cdh.byteLength).setUint16(10, 12, true);
      const lfh = parts.local[0]!;
      new DataView(lfh.buffer, lfh.byteOffset, lfh.byteLength).setUint16(8, 12, true);
    });
    await expectReject(zip, "unsupported-compression");
  });

  it.each([
    ["../escape.tex", "parent traversal"],
    ["/etc/passwd", "absolute leading slash"],
    ["a\\b.tex", "backslash separator"],
    ["sub/../../x.tex", "nested traversal"],
    ["C:windows.tex", "drive letter"],
  ])("rejects unsafe path %s (%s)", async (name) => {
    const zip = await buildZip([{ name, data: bytes("x") }]);
    await expectReject(zip, "unsafe-path");
  });

  it("aborts a single over-cap deflate entry without OOM (entry-too-large)", async () => {
    // Highly compressible payload that decompresses past MAX_ENTRY_BYTES.
    const big = new Uint8Array(MAX_ENTRY_BYTES + 1024); // all zeros → tiny deflate
    const zip = await buildZip([{ name: "bomb.tex", data: big, method: 8 }]);
    await expectReject(zip, "entry-too-large");
  });

  it("aborts a stored entry that exceeds the per-entry cap", async () => {
    const big = new Uint8Array(MAX_ENTRY_BYTES + 1);
    const zip = await buildZip([{ name: "big.tex", data: big, method: 0 }]);
    await expectReject(zip, "entry-too-large");
  });

  it("aborts when the archive total exceeds the total cap (zip-bomb-ish)", async () => {
    // Several entries each under the per-entry cap but together over the total.
    const chunk = new Uint8Array(MAX_ENTRY_BYTES); // ~32 MiB of zeros, deflates tiny
    const count = Math.ceil(MAX_TOTAL_BYTES / MAX_ENTRY_BYTES) + 1;
    const entries: BuildEntry[] = [];
    for (let i = 0; i < count; i++) {
      entries.push({ name: `f${i}.tex`, data: chunk, method: 8 });
    }
    const zip = await buildZip(entries);
    await expectReject(zip, "archive-too-large");
  }, 20_000);

  it("rejects an archive declaring too many entries", async () => {
    // A single real entry, but the EOCD lies about the count being over the cap.
    const zip = await buildZip([{ name: "main.tex", data: bytes("x") }], (parts) => {
      const dv = new DataView(parts.eocd.buffer, parts.eocd.byteOffset, parts.eocd.byteLength);
      dv.setUint16(8, (MAX_ENTRY_COUNT + 1) & 0xffff, true);
      dv.setUint16(10, (MAX_ENTRY_COUNT + 1) & 0xffff, true);
    });
    await expectReject(zip, "too-many-entries");
  });
});

// ── Security hardening (pre-merge review) ─────────────────────────────────────

describe("readProjectZip — input-size guard (MAX_ZIP_BYTES)", () => {
  it("exposes a raw-zip byte cap equal to the total-decompressed cap", () => {
    expect(MAX_ZIP_BYTES).toBe(MAX_TOTAL_BYTES);
  });

  it("rejects raw bytes larger than MAX_ZIP_BYTES before parsing", async () => {
    // A buffer over the cap. We don't even build a valid zip — the size guard
    // must fire FIRST (defensive re-check for non-panel callers like tests).
    const oversize = new Uint8Array(MAX_ZIP_BYTES + 1);
    await expectReject(oversize, "archive-too-large");
  });
});

describe("readProjectZip — directory-entry name validation", () => {
  it("rejects an unsafe directory entry (../) instead of silently skipping it", async () => {
    // A directory entry whose name traverses out of the tree. Before the fix the
    // `endsWith('/')` skip ran BEFORE sanitizePath, so this was silently accepted.
    const zip = await buildZip([{ name: "../escape/", data: new Uint8Array(0), method: 0 }]);
    await expectReject(zip, "unsafe-path");
  });

  it("still skips a SAFE directory entry without materializing it", async () => {
    const zip = await buildZip([
      { name: "chapters/", data: new Uint8Array(0), method: 0 },
      { name: "chapters/intro.tex", data: bytes("\\section{x}"), method: 0 },
    ]);
    const input = await readProjectZip(zip);
    expect(input.files.map((f) => f.path)).toEqual(["chapters/intro.tex"]);
  });
});

describe("readProjectZip — central-directory cursor overrun", () => {
  it("fails closed when an entry's name+extra+comment overruns the directory", async () => {
    // Inflate the FIRST central-directory header's comment length so the cursor
    // advances past cdEnd; the reader must throw `truncated`, not read past it.
    const zip = await buildZip(
      [
        { name: "main.tex", data: bytes("x") },
        { name: "second.tex", data: bytes("y") },
      ],
      (parts) => {
        // central[0] is the first CDH (46 bytes); offset 32 is the comment length.
        const cdh = parts.central[0]!;
        new DataView(cdh.buffer, cdh.byteOffset, cdh.byteLength).setUint16(32, 0xffff, true);
      },
    );
    await expectReject(zip, "truncated");
  });
});

describe("toSafeProjectFiles — VFS path gate before materialization", () => {
  it("drops files whose /-rooted path the project VFS would reject", () => {
    // importLatexProject emits /-rooted paths; some (control chars, the reserved
    // .galley namespace) would poison materializeProject. Gate them out.
    const ctrlPath = "/bad" + String.fromCharCode(1) + "name.typ";
    const out = toSafeProjectFiles([
      { path: "/main.typ", text: "ok" },
      { path: "/.galley/x.typ", text: "reserved namespace" },
      { path: ctrlPath, text: "control char" },
      { path: "/chapters/intro.typ", text: "ok2" },
    ]);
    expect(out.kept.map((f) => f.path)).toEqual(["/main.typ", "/chapters/intro.typ"]);
    expect(out.dropped).toEqual(["/.galley/x.typ", ctrlPath]);
  });

  it("keeps a clean tree untouched", () => {
    const files = [
      { path: "/main.typ", text: "a" },
      { path: "/refs.bib", text: "b" },
    ];
    const out = toSafeProjectFiles(files);
    expect(out.kept).toEqual(files);
    expect(out.dropped).toEqual([]);
  });
});

// ── sanitizePath unit coverage ────────────────────────────────────────────────

describe("sanitizePath", () => {
  it("accepts clean relative paths", () => {
    expect(sanitizePath("main.tex")).toBe("main.tex");
    expect(sanitizePath("chapters/intro.tex")).toBe("chapters/intro.tex");
  });
  it.each(["../x", "/abs", "a\\b", "x\0y", "C:foo", "a/../../b"])(
    "rejects unsafe %s",
    (p) => {
      expect(sanitizePath(p)).toBeNull();
    },
  );
});

// ── summarizeDroppedPaths — grouped "won't be imported" surfacing ─────────────

describe("summarizeDroppedPaths", () => {
  const emptyReport = (): LatexProjectReport => ({
    outcomes: [],
    unconverted: [],
    unresolvedIncludes: [],
    assets: [],
    warnings: [],
  });

  it("returns no groups for a clean import", () => {
    const report = emptyReport();
    report.outcomes.push({
      sourcePath: "/main.tex",
      outputPath: "/main.typ",
      action: "converted",
      orphaned: false,
    });
    expect(summarizeDroppedPaths([{ path: "/main.typ", text: "ok" }], report)).toEqual([]);
  });

  it("groups binary assets and .cls/.sty skips from the report outcomes", () => {
    const report = emptyReport();
    report.outcomes.push(
      { sourcePath: "/figs/b.png", outputPath: null, action: "asset", orphaned: false },
      { sourcePath: "/figs/a.png", outputPath: null, action: "asset", orphaned: false },
      { sourcePath: "/thesis.cls", outputPath: null, action: "skipped", orphaned: false },
      { sourcePath: "/main.tex", outputPath: "/main.typ", action: "converted", orphaned: false },
    );
    const groups = summarizeDroppedPaths([{ path: "/main.typ", text: "ok" }], report);
    expect(groups.map((g) => g.reason)).toEqual(["binary-asset", "latex-style"]);
    // Sorted within the group; the label is the calm shared copy.
    expect(groups[0]!.paths).toEqual(["/figs/a.png", "/figs/b.png"]);
    expect(groups[0]!.label).toBe(DROPPED_REASON_LABELS["binary-asset"]);
    expect(groups[1]!.paths).toEqual(["/thesis.cls"]);
  });

  it("splits VFS-gate drops into reserved-namespace vs unsafe-path", () => {
    const ctrlPath = "/bad" + String.fromCharCode(1) + "name.typ";
    const files = [
      { path: "/main.typ", text: "ok" },
      { path: "/.galley/instructions", text: "reserved" },
      { path: ctrlPath, text: "ctrl" },
    ];
    const groups = summarizeDroppedPaths(files, emptyReport());
    expect(groups.map((g) => g.reason)).toEqual(["unsafe-path", "reserved-namespace"]);
    expect(groups.find((g) => g.reason === "reserved-namespace")!.paths).toEqual([
      "/.galley/instructions",
    ]);
    expect(groups.find((g) => g.reason === "unsafe-path")!.paths).toEqual([ctrlPath]);
  });

  it("counts entry-level traversal/invalid/duplicate warnings, NOT include-target traversal", () => {
    const report = emptyReport();
    report.outcomes.push({
      sourcePath: "/main.tex",
      outputPath: "/main.typ",
      action: "converted",
      orphaned: false,
    });
    report.warnings.push(
      // Entry-level: the raw entry path was ignored at normalization (no outcome).
      { kind: "path-traversal", message: "entry path escapes the project root", path: "../evil.tex" },
      { kind: "invalid-entry", message: "bad entry", path: "/ " },
      // A duplicate's path IS imported once; the ignored copy is still surfaced.
      { kind: "duplicate-path", message: "duplicate entry", path: "/main.tex" },
      // Include-TARGET traversal inside a kept file: path is the including file,
      // which has an outcome — must NOT be listed as dropped.
      { kind: "path-traversal", message: "include target escapes", path: "/main.tex" },
      // Warnings without a path never contribute.
      { kind: "invalid-entry", message: "entry without a string path" },
    );
    const groups = summarizeDroppedPaths([{ path: "/main.typ", text: "ok" }], report);
    expect(groups.map((g) => g.reason)).toEqual(["ignored-entry"]);
    expect(groups[0]!.paths).toEqual(["../evil.tex", "/ ", "/main.tex"]);
  });

  it("flows through the REAL core: binary asset + .sty + .galley entry end up grouped", () => {
    const result = importLatexProject({
      files: [
        { path: "main.tex", text: "\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n" },
        { path: "logo.png", binary: true },
        { path: "thesis.sty", text: "% style" },
        { path: ".galley/instructions", text: "smuggled" },
      ],
    });
    const groups = summarizeDroppedPaths(result.files, result.report);
    const byReason = new Map(groups.map((g) => [g.reason, g.paths]));
    expect(byReason.get("binary-asset")).toEqual(["/logo.png"]);
    expect(byReason.get("latex-style")).toEqual(["/thesis.sty"]);
    // `.galley/instructions` passes through the converter as text but is dropped
    // by the VFS gate — the reserved namespace never lands from an archive.
    expect(byReason.get("reserved-namespace")).toEqual(["/.galley/instructions"]);
    // And the kept set (what Accept will actually add) excludes it.
    expect(toSafeProjectFiles(result.files).kept.map((f) => f.path)).toEqual(["/main.typ"]);
  });

  it("is deterministic: groups in fixed reason order, paths deduped + sorted", () => {
    const report = emptyReport();
    report.outcomes.push(
      { sourcePath: "/z.png", outputPath: null, action: "asset", orphaned: false },
      { sourcePath: "/a.png", outputPath: null, action: "asset", orphaned: false },
    );
    report.warnings.push(
      { kind: "duplicate-path", message: "dup", path: "/dup.tex" },
      { kind: "duplicate-path", message: "dup again", path: "/dup.tex" },
    );
    const groups = summarizeDroppedPaths([{ path: "/.galley/x", text: "" }], report);
    expect(groups.map((g) => g.reason)).toEqual([
      "binary-asset",
      "reserved-namespace",
      "ignored-entry",
    ]);
    expect(groups[0]!.paths).toEqual(["/a.png", "/z.png"]);
    expect(groups[2]!.paths).toEqual(["/dup.tex"]); // deduped
  });
});
