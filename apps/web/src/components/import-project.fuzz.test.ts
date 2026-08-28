/**
 * Roadmap #22.2 — adversarial fuzz harness for the highest-risk import surface:
 * the Overleaf `.zip` reader (`readProjectZip` in `import-project.ts`). It turns
 * UNTRUSTED archive bytes into a project tree, so the threat model is the full
 * untrusted-archive set: path traversal (zip-slip), zip bombs, entry-count /
 * total-size / per-entry-size exhaustion, and truncated/garbage bytes.
 *
 * The reader's design caps are: per-entry 32 MiB, total 128 MiB, raw-zip 128 MiB,
 * 5000 entries — all enforced WHILE streaming (the inflater has no output cap, so
 * the count is enforced as bytes arrive). This harness VERIFIES those caps fire
 * and that every hostile shape is rejected with a typed `ZipImportError` (or, for
 * a safe `..`-bearing-but-not-escaping path, accepted only when downstream-safe),
 * within a tight wall-clock budget — never a hang, never an OOM, never a path
 * escape.
 *
 * Cases are DETERMINISTIC (hand-built byte fixtures, no randomness) and FAST
 * (the bomb cases use a small-but-over-cap deflate stream, not a multi-GB blob).
 */
import { describe, it, expect } from "vitest";
import {
  readProjectZip,
  sanitizePath,
  toSafeProjectFiles,
  ZipImportError,
  MAX_ENTRY_BYTES,
  MAX_TOTAL_BYTES,
  MAX_ENTRY_COUNT,
  MAX_ZIP_BYTES,
} from "./import-project.js";

const TIME_BUDGET_MS = 5000; // generous; bomb inflation still finishes in ~ms.
const te = new TextEncoder();

// ── Minimal byte-level zip builder (mirrors import-project.test.ts) ───────────
interface BuildEntry {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
  gpFlag?: number;
}

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

async function buildZip(entries: BuildEntry[]): Promise<Uint8Array> {
  const localChunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const method = e.method ?? 0;
    const stored = method === 8 ? await deflateRaw(e.data) : e.data;
    const crc = crc32(e.data);
    const name = te.encode(e.name);
    const gp = e.gpFlag ?? 0;

    const lfh = new DataView(new ArrayBuffer(30));
    lfh.setUint32(0, 0x04034b50, true);
    lfh.setUint16(4, 20, true);
    lfh.setUint16(6, gp, true);
    lfh.setUint16(8, method, true);
    lfh.setUint32(14, crc, true);
    lfh.setUint32(18, stored.length, true);
    lfh.setUint32(22, e.data.length, true);
    lfh.setUint16(26, name.length, true);
    lfh.setUint16(28, 0, true);
    const lfhBytes = new Uint8Array(lfh.buffer);

    const localOffset = offset;
    localChunks.push(lfhBytes, name, stored);
    offset += lfhBytes.length + name.length + stored.length;

    const cdh = new DataView(new ArrayBuffer(46));
    cdh.setUint32(0, 0x02014b50, true);
    cdh.setUint16(4, 20, true);
    cdh.setUint16(6, 20, true);
    cdh.setUint16(8, gp, true);
    cdh.setUint16(10, method, true);
    cdh.setUint32(16, crc, true);
    cdh.setUint32(20, stored.length, true);
    cdh.setUint32(24, e.data.length, true);
    cdh.setUint16(28, name.length, true);
    cdh.setUint32(42, localOffset, true);
    central.push(new Uint8Array(cdh.buffer), name);
  }

  const cdStart = offset;
  const cdSize = central.reduce((n, c) => n + c.length, 0);

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);

  const all = [...localChunks, ...central, new Uint8Array(eocd.buffer)];
  const total = all.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of all) {
    buf.set(c, at);
    at += c.length;
  }
  return buf;
}

/** Await a parse and assert it rejects with the given ZipImportError code, fast. */
async function expectReject(
  label: string,
  zip: Uint8Array,
  code?: string,
): Promise<void> {
  const t0 = Date.now();
  let err: unknown;
  try {
    await readProjectZip(zip);
  } catch (e) {
    err = e;
  }
  const ms = Date.now() - t0;
  expect(ms, `${label} took ${ms}ms`).toBeLessThan(TIME_BUDGET_MS);
  expect(err, `${label} should reject`).toBeInstanceOf(ZipImportError);
  if (code) expect((err as ZipImportError).code).toBe(code);
}

// ─────────────────────────────────────────────────────────────────────────────
// Zip-slip / path traversal — the canonical archive attack
// ─────────────────────────────────────────────────────────────────────────────
describe("fuzz: zip-slip and unsafe paths are rejected", () => {
  it("rejects ../ traversal entries", async () => {
    for (const name of [
      "../../etc/passwd",
      "a/../../b.tex",
      "../escape.tex",
      "foo/../../../bar.tex",
    ]) {
      const zip = await buildZip([{ name, data: te.encode("x") }]);
      await expectReject(`traversal:${name}`, zip, "unsafe-path");
    }
  });

  it("rejects absolute, drive-letter, backslash and NUL paths", async () => {
    for (const name of [
      "/etc/passwd",
      "/abs.tex",
      "C:windows.tex",
      "a\\b.tex",
      "a\\..\\b.tex",
      "evil\0.tex",
    ]) {
      const zip = await buildZip([{ name, data: te.encode("x") }]);
      await expectReject(`unsafe:${JSON.stringify(name)}`, zip, "unsafe-path");
    }
  });

  it("rejects a hostile directory-only ../ entry (not silently skipped)", async () => {
    const zip = await buildZip([{ name: "../", data: new Uint8Array(0) }]);
    await expectReject("dir-traversal", zip, "unsafe-path");
  });

  it("sanitizePath unit matrix — null for every dangerous form", () => {
    for (const bad of [
      "",
      "/abs",
      "../x",
      "a/../../b",
      "a\\b",
      "C:\\x",
      "C:x",
      "x\0y",
      "..",
      "deep/../../../../etc",
    ]) {
      expect(sanitizePath(bad), `should reject ${JSON.stringify(bad)}`).toBeNull();
    }
    // Safe paths (including harmless single `.` and doubled-slash segments).
    for (const ok of ["main.tex", "chapters/intro.tex", "./a.tex", "a//b.tex"]) {
      expect(sanitizePath(ok), `should accept ${JSON.stringify(ok)}`).not.toBeNull();
    }
  });

  it("toSafeProjectFiles drops control-char and reserved-namespace paths", () => {
    const { kept, dropped } = toSafeProjectFiles([
      { path: "/main.typ", text: "ok" },
      { path: "/.galley/instructions", text: "reserved" },
      { path: "/bad.typ", text: "bell" },
      { path: "/../escape.typ", text: "esc" },
    ]);
    expect(kept.map((f) => f.path)).toEqual(["/main.typ"]);
    expect(dropped.sort()).toEqual(
      ["/.galley/instructions", "/../escape.typ", "/bad.typ"].sort(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Zip bombs / cap enforcement — must abort WHILE streaming, never OOM
// ─────────────────────────────────────────────────────────────────────────────
describe("fuzz: size/count caps fire and abort cleanly", () => {
  it("a single deflate entry over the per-entry cap aborts mid-stream", async () => {
    // A highly-compressible blob just over MAX_ENTRY_BYTES: zeros deflate ~1000:1,
    // so the compressed zip is tiny but decompresses past the 32 MiB per-entry cap.
    const bomb = new Uint8Array(MAX_ENTRY_BYTES + 64 * 1024); // all zeros
    const zip = await buildZip([{ name: "bomb.tex", data: bomb, method: 8 }]);
    expect(zip.length).toBeLessThan(MAX_ZIP_BYTES); // the zip itself is small
    await expectReject("entry-bomb", zip, "entry-too-large");
  });

  it("a stored entry over the per-entry cap is rejected without inflating", async () => {
    const big = new Uint8Array(MAX_ENTRY_BYTES + 1024);
    const zip = await buildZip([{ name: "big.tex", data: big, method: 0 }]);
    await expectReject("stored-too-large", zip, "entry-too-large");
  });

  it("entries that together cross the archive total cap abort", async () => {
    // Several deflate entries each under the per-entry cap but together over the
    // 128 MiB total — the running budget must abort, not buffer all of them.
    const each = new Uint8Array(30 * 1024 * 1024); // 30 MiB zeros, well-compressible
    const entries: BuildEntry[] = [];
    for (let i = 0; i < 6; i++) entries.push({ name: `c${i}.tex`, data: each, method: 8 });
    const zip = await buildZip(entries);
    expect(zip.length).toBeLessThan(MAX_ZIP_BYTES);
    await expectReject("total-bomb", zip, "archive-too-large");
  });

  it("an archive declaring too many entries is rejected up front", async () => {
    // The EOCD count is checked before scanning, so a forged huge count fails fast
    // even with a tiny body. Build a minimal valid zip then bump the EOCD counts.
    const zip = await buildZip([{ name: "a.tex", data: te.encode("x") }]);
    const view = new DataView(zip.buffer);
    // EOCD is the last 22 bytes (no comment). Patch entry counts to over the cap.
    const eocd = zip.length - 22;
    view.setUint16(eocd + 8, MAX_ENTRY_COUNT + 1, true);
    view.setUint16(eocd + 10, MAX_ENTRY_COUNT + 1, true);
    await expectReject("too-many", zip, "too-many-entries");
  });

  it("a raw zip larger than MAX_ZIP_BYTES is rejected before parsing", async () => {
    const huge = new Uint8Array(MAX_ZIP_BYTES + 1);
    await expectReject("oversize-raw", huge, "archive-too-large");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Truncated / garbage / malformed bytes — never hang, never throw a raw error
// ─────────────────────────────────────────────────────────────────────────────
describe("fuzz: truncated and garbage archives fail closed", () => {
  it("non-zip / empty / tiny garbage rejects as not-a-zip", async () => {
    for (const g of [
      new Uint8Array(0),
      te.encode("not a zip at all"),
      new Uint8Array([0x50, 0x4b]), // partial PK signature
      new Uint8Array(10), // zeros, no EOCD
    ]) {
      await expectReject("garbage", g, "not-a-zip");
    }
  });

  it("a valid zip with its tail truncated rejects (no hang)", async () => {
    const zip = await buildZip([
      { name: "a.tex", data: te.encode("hello"), method: 8 },
    ]);
    // Lop off the central directory + EOCD — the structure is now broken.
    const truncated = zip.subarray(0, Math.floor(zip.length / 2));
    let err: unknown;
    const t0 = Date.now();
    try {
      await readProjectZip(truncated);
    } catch (e) {
      err = e;
    }
    expect(Date.now() - t0).toBeLessThan(TIME_BUDGET_MS);
    expect(err).toBeInstanceOf(ZipImportError);
  });

  it("a forged central-directory offset past EOF rejects as truncated", async () => {
    const zip = await buildZip([{ name: "a.tex", data: te.encode("x") }]);
    const view = new DataView(zip.buffer);
    const eocd = zip.length - 22;
    view.setUint32(eocd + 16, zip.length + 1000, true); // cdOffset past EOF
    await expectReject("forged-cd-offset", zip, "truncated");
  });

  it("an encrypted entry (GP bit 0) is rejected", async () => {
    const zip = await buildZip([
      { name: "enc.tex", data: te.encode("secret"), gpFlag: 0x0001 },
    ]);
    await expectReject("encrypted", zip, "encrypted");
  });

  it("an unsupported compression method is rejected", async () => {
    const zip = await buildZip([{ name: "x.tex", data: te.encode("x") }]);
    const view = new DataView(zip.buffer);
    // Patch the central-directory method to 99 (AES) — first CDH after locals.
    // Find the CDH signature scan: simplest is to patch both LFH+CDH method words.
    // The reader trusts the CENTRAL directory method; locate the CDH by signature.
    for (let i = 0; i + 4 <= zip.length; i++) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint16(i + 10, 99, true);
        break;
      }
    }
    await expectReject("bad-method", zip, "unsupported-compression");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy-path sanity — hardening must not break valid archives
// ─────────────────────────────────────────────────────────────────────────────
describe("fuzz: valid archives still import (no regression)", () => {
  it("a mixed stored+deflate tree round-trips to the expected files", async () => {
    const zip = await buildZip([
      { name: "main.tex", data: te.encode("\\documentclass{article}"), method: 0 },
      { name: "chapters/intro.tex", data: te.encode("intro"), method: 8 },
      { name: "refs.bib", data: te.encode("@misc{a}"), method: 8 },
      { name: "fig.png", data: new Uint8Array([1, 2, 3, 4]), method: 0 },
    ]);
    const t0 = Date.now();
    const tree = await readProjectZip(zip);
    expect(Date.now() - t0).toBeLessThan(TIME_BUDGET_MS);
    const paths = tree.files.map((f) => f.path).sort();
    expect(paths).toEqual(["chapters/intro.tex", "fig.png", "main.tex", "refs.bib"]);
    // The binary asset carries `binary: true`; text entries carry decoded text.
    const png = tree.files.find((f) => f.path === "fig.png")!;
    expect(png.binary).toBe(true);
    const intro = tree.files.find((f) => f.path === "chapters/intro.tex")!;
    expect(intro.text).toBe("intro");
  });
});
