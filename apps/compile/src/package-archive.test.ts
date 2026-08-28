/**
 * Roadmap #3 slice 5a: the security-critical package-archive core. Pure/offline —
 * builds ustar + gzip bytes in memory and asserts both the happy path and the
 * Security-Analyst's (ADR-0016) rejection matrix: bad checksum, truncation,
 * trailing garbage, base-256 size, non-regular entries (symlink/PAX), oversize,
 * invalid UTF-8, decompression cap, and SHA-256 integrity.
 */
import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { FakeRegistry } from "@galley/compiler";
import {
  ArchiveError,
  DEFAULT_ARCHIVE_LIMITS,
  gunzipWithCap,
  sha256Hex,
  untarStrict,
  verifyIntegrity,
} from "./package-archive.js";

const BLOCK = 512;
const enc = new TextEncoder();

interface Entry {
  path: string;
  text?: string;
  typeflag?: number; // default '0' (regular)
}

/** Build a strict-ustar header+data for one entry. */
function entryBlocks(e: Entry): Uint8Array {
  const text = e.text ?? "";
  const dataBytes = enc.encode(text);
  const header = new Uint8Array(BLOCK);
  const put = (s: string, at: number, len: number) => {
    for (let i = 0; i < Math.min(s.length, len); i++) header[at + i] = s.charCodeAt(i);
  };
  const octal = (v: number, at: number, len: number) => {
    const s = v.toString(8).padStart(len - 1, "0");
    put(s, at, len - 1);
    header[at + len - 1] = 0;
  };
  put(e.path, 0, 100);
  octal(0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(dataBytes.length, 124, 12);
  octal(0, 136, 12);
  header[156] = e.typeflag ?? 0x30; // '0' regular
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  // checksum: sum with the chksum field [148,156) as spaces.
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i]!;
  const cs = sum.toString(8).padStart(6, "0");
  put(cs, 148, 6);
  header[154] = 0;
  header[155] = 0x20;

  const padded = Math.ceil(dataBytes.length / BLOCK) * BLOCK;
  const body = new Uint8Array(padded);
  body.set(dataBytes, 0);
  const block = new Uint8Array(BLOCK + padded);
  block.set(header, 0);
  block.set(body, BLOCK);
  return block;
}

/** Assemble a full ustar archive (entries + two zero end blocks). */
function makeTar(entries: Entry[]): Uint8Array {
  const parts = entries.map(entryBlocks);
  const end = new Uint8Array(BLOCK * 2);
  const totalLen = parts.reduce((n, p) => n + p.length, 0) + end.length;
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  out.set(end, off);
  return out;
}

const PROBE: Entry[] = [
  { path: "typst.toml", text: `[package]\nname = "probe"\nversion = "0.1.0"\nentrypoint = "lib.typ"\n` },
  { path: "lib.typ", text: `#let hi() = [hi]\n` },
];

describe("untarStrict", () => {
  it("round-trips regular files", () => {
    const files = untarStrict(makeTar(PROBE));
    expect(files.map((f) => f.path)).toEqual(["typst.toml", "lib.typ"]);
    expect(files[1]!.text).toContain("#let hi()");
  });

  it("skips directory entries but keeps regular files", () => {
    const files = untarStrict(makeTar([{ path: "src/", typeflag: 0x35 }, ...PROBE]));
    expect(files.map((f) => f.path)).toEqual(["typst.toml", "lib.typ"]);
  });

  it("feeds the ADR-0014 FakeRegistry (re-root + validation gate)", () => {
    const files = untarStrict(makeTar(PROBE));
    const reg = new FakeRegistry({ "@preview/probe:0.1.0": files });
    const resolved = reg.resolve({ namespace: "preview", name: "probe", version: "0.1.0" });
    expect(resolved!.map((f) => f.path)).toContain("/packages/preview/probe/0.1.0/typst.toml");
  });

  it("rejects a symlink entry", () => {
    expect(() => untarStrict(makeTar([{ path: "evil", typeflag: 0x32 }]))).toThrow(ArchiveError);
  });

  it("rejects a PAX extended-header entry", () => {
    expect(() => untarStrict(makeTar([{ path: "x", typeflag: 0x78 }]))).toThrow(/unsupported/);
  });

  it("rejects a file over the per-file cap", () => {
    const big = "a".repeat(BLOCK * 3);
    expect(() =>
      untarStrict(makeTar([{ path: "big.typ", text: big }]), { ...DEFAULT_ARCHIVE_LIMITS, maxFileBytes: 100 }),
    ).toThrow(/size cap/);
  });

  it("rejects exceeding the total-bytes cap", () => {
    expect(() =>
      untarStrict(makeTar(PROBE), { maxFiles: 64, maxFileBytes: 1024, maxTotalBytes: 10 }),
    ).toThrow(/total size cap/);
  });

  it("rejects exceeding the file-count cap", () => {
    expect(() =>
      untarStrict(makeTar(PROBE), { maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 1024 }),
    ).toThrow(/file-count cap/);
  });

  it("rejects a bad header checksum", () => {
    const tar = makeTar(PROBE);
    tar[0] = tar[0]! ^ 0xff; // corrupt the name → checksum no longer matches
    expect(() => untarStrict(tar)).toThrow(/checksum/);
  });

  it("rejects a truncated archive", () => {
    const tar = makeTar(PROBE).slice(0, BLOCK + 8); // header but no full data
    expect(() => untarStrict(tar)).toThrow(ArchiveError);
  });

  it("rejects non-zero data after the end-of-archive marker", () => {
    const tar = makeTar([PROBE[0]!]);
    tar[tar.length - 1] = 0x41; // poison the final padding byte
    expect(() => untarStrict(tar)).toThrow(/end-of-archive/);
  });

  it("rejects a base-256 (high-bit) numeric field", () => {
    const tar = makeTar(PROBE);
    tar[124] = 0x80; // set high bit in the size field
    // Recompute the header checksum so we reach the size-field parse (not the
    // checksum guard) — isolating base-256 rejection.
    for (let i = 148; i < 156; i++) tar[i] = 0x20;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += tar[i]!;
    const cs = sum.toString(8).padStart(6, "0");
    for (let i = 0; i < 6; i++) tar[148 + i] = cs.charCodeAt(i);
    tar[154] = 0;
    tar[155] = 0x20;
    expect(() => untarStrict(tar)).toThrow(/base-256|octal/);
  });

  it("rejects invalid UTF-8 content", () => {
    // Build a 1-byte regular file, then poison that byte to a lone 0xFF (invalid UTF-8).
    const tar = makeTar([{ path: "bad.typ", text: "x" }]);
    tar[BLOCK] = 0xff; // the single data byte sits right after the 512-byte header
    expect(() => untarStrict(tar)).toThrow(ArchiveError);
  });
});

describe("gunzipWithCap", () => {
  it("round-trips within the cap", async () => {
    const original = enc.encode("hello ".repeat(50));
    const gz = new Uint8Array(gzipSync(original));
    const out = await gunzipWithCap(gz, 10_000);
    expect(out).toEqual(original);
  });

  it("throws past the decompressed cap (zip-bomb guard)", async () => {
    const gz = new Uint8Array(gzipSync(enc.encode("a".repeat(5000))));
    await expect(gunzipWithCap(gz, 100)).rejects.toBeInstanceOf(ArchiveError);
  });

  it("throws on non-gzip input", async () => {
    await expect(gunzipWithCap(enc.encode("not gzip"), 1000)).rejects.toBeInstanceOf(ArchiveError);
  });
});

describe("integrity", () => {
  it("verifies a matching sha256 + size", () => {
    const bytes = enc.encode("artifact");
    expect(() => verifyIntegrity(bytes, { sha256: sha256Hex(bytes), size: bytes.length })).not.toThrow();
  });

  it("rejects a wrong hash", () => {
    const bytes = enc.encode("artifact");
    const wrong = sha256Hex(enc.encode("other"));
    expect(() => verifyIntegrity(bytes, { sha256: wrong, size: bytes.length })).toThrow(/hash mismatch/);
  });

  it("rejects a wrong size", () => {
    const bytes = enc.encode("artifact");
    expect(() => verifyIntegrity(bytes, { sha256: sha256Hex(bytes), size: 999 })).toThrow(/size mismatch/);
  });
});
