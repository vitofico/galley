/**
 * Real-scenario Overleaf `.zip` import (roadmap #5 "import features testing in
 * real scenarios"). Builds a REAL multi-file project archive byte-for-byte from
 * the shared corpus fixtures (main.tex + sections/ + refs.bib + a binary figure
 * placeholder) and drives the FULL real path: readProjectZip → importLatexProject
 * → toSafeProjectFiles / summarizeDroppedPaths — exactly what ImportPanel runs
 * when a user picks an Overleaf export.
 *
 * The exhaustive cap/rejection matrix lives in import-project.test.ts; here we
 * keep one realistic cap check (a forged entry count) and focus on the
 * end-to-end structure of a real project.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { importLatexProject } from "@galley/agent";
import {
  readProjectZip,
  toSafeProjectFiles,
  summarizeDroppedPaths,
  ZipImportError,
} from "./import-project.js";

const fixture = (rel: string): string =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../../packages/agent/src/__fixtures__/import-real/${rel}`, import.meta.url),
    ),
    "utf8",
  );

// ── Minimal stored-method zip builder (test-only) ────────────────────────────
// Method 0 (stored) keeps the builder tiny; the deflate path is covered by
// import-project.test.ts. CRC-32 is computed for real so the archive is valid
// for any external unzip, even though the reader does not verify it.

const te = new TextEncoder();

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

interface StoredEntry {
  name: string;
  data: Uint8Array;
}

function buildStoredZip(entries: StoredEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = te.encode(name);
    const crc = crc32(data);

    const lfh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lfh.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // gp flag
    lv.setUint16(8, 0, true); // method: stored
    lv.setUint32(10, 0, true); // mod time/date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed size (== stored)
    lv.setUint32(22, data.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra len
    lfh.set(nameBytes, 30);
    chunks.push(lfh, data);

    const cdh = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdh.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory header signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // gp flag
    cv.setUint16(10, 0, true); // method: stored
    cv.setUint32(12, 0, true); // mod time/date
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    // extra/comment/disk/attrs all zero
    cv.setUint32(42, offset, true); // local header offset
    cdh.set(nameBytes, 46);
    central.push(cdh);

    offset += lfh.length + data.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true); // entries on this disk
  ev.setUint16(10, entries.length, true); // entries total
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true); // central directory offset
  // comment length stays 0

  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of [...chunks, ...central, eocd]) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** A tiny binary blob with the PNG magic — clearly NOT text. */
const PNG_STUB = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);

function buildOverleafZip(): Uint8Array {
  return buildStoredZip([
    // Directory entries, the way real Overleaf exports carry them.
    { name: "sections/", data: new Uint8Array(0) },
    { name: "figures/", data: new Uint8Array(0) },
    { name: "main.tex", data: te.encode(fixture("overleaf/main.tex")) },
    { name: "sections/intro.tex", data: te.encode(fixture("overleaf/sections/intro.tex")) },
    { name: "sections/methods.tex", data: te.encode(fixture("overleaf/sections/methods.tex")) },
    { name: "refs.bib", data: te.encode(fixture("overleaf/refs.bib")) },
    { name: "figures/setup.png", data: PNG_STUB },
  ]);
}

// ── The real path, end to end ────────────────────────────────────────────────

describe("real corpus — Overleaf .zip import end to end", () => {
  it("unpacks the archive into the project tree (directories skipped, binary flagged)", async () => {
    const tree = await readProjectZip(buildOverleafZip());
    const byPath = new Map(tree.files.map((f) => [f.path, f]));
    expect(tree.files).toHaveLength(5); // the two directory entries are skipped
    expect(byPath.get("main.tex")!.text).toBe(fixture("overleaf/main.tex"));
    expect(byPath.get("sections/intro.tex")!.text).toBe(fixture("overleaf/sections/intro.tex"));
    expect(byPath.get("refs.bib")!.text).toBe(fixture("overleaf/refs.bib"));
    expect(byPath.get("figures/setup.png")!.binary).toBe(true);
    expect(byPath.get("figures/setup.png")!.text).toBeUndefined();
    // #7 (G1): the bytes are now PRESERVED, not dropped.
    expect(byPath.get("figures/setup.png")!.bytes).toEqual(PNG_STUB);
  });

  it("#7 (G1): the conversion surfaces the binary figure's bytes in binaryFiles", async () => {
    const tree = await readProjectZip(buildOverleafZip());
    const result = importLatexProject(tree);
    expect(result.binaryFiles).toEqual([{ path: "/figures/setup.png", bytes: PNG_STUB }]);
  });

  it("converts the unpacked tree into a complete, safe Typst project", async () => {
    const tree = await readProjectZip(buildOverleafZip());
    const result = importLatexProject(tree);

    expect(result.mainPath).toBe("/main.typ");
    const main = result.files.find((f) => f.path === "/main.typ")!;
    expect(main.text).toContain('#include "/sections/intro.typ"');
    expect(main.text).toContain('#include "/sections/methods.typ"');
    expect(main.text).toContain('#bibliography("/refs.bib")');

    // Every converted path passes the VFS gate ImportPanel applies at Accept.
    const { kept, dropped } = toSafeProjectFiles(result.files);
    expect(dropped).toEqual([]);
    expect(kept.map((f) => f.path)).toEqual([
      "/main.typ",
      "/refs.bib",
      "/sections/intro.typ",
      "/sections/methods.typ",
    ]);
  });

  it("surfaces the binary figure as the only dropped path, with honest copy", async () => {
    const tree = await readProjectZip(buildOverleafZip());
    const result = importLatexProject(tree);
    const groups = summarizeDroppedPaths(result.files, result.report);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.reason).toBe("binary-asset");
    expect(groups[0]!.paths).toEqual(["/figures/setup.png"]);
    // …and the asset manifest still records who referenced it.
    expect(result.report.assets).toEqual([
      { path: "/figures/setup.png", referencedBy: ["/main.tex"] },
    ]);
  });

  it("honors the entry-count cap on a forged central-directory count", async () => {
    const zip = buildOverleafZip();
    // The EOCD sits at the end (no comment). Forge the declared entry counts
    // past MAX_ENTRY_COUNT; the reader must reject before reading any entry.
    const view = new DataView(zip.buffer, zip.byteLength - 22, 22);
    view.setUint16(8, 5001, true);
    view.setUint16(10, 5001, true);
    await expect(readProjectZip(zip)).rejects.toMatchObject({
      name: "ZipImportError",
      code: "too-many-entries",
    });
    // Sanity: the error type is the exported one.
    await expect(readProjectZip(zip)).rejects.toBeInstanceOf(ZipImportError);
  });
});
