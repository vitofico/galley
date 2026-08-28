/**
 * Universe integrity-manifest builder. Offline: a fake `fetch` serves real gzipped
 * ustar tarballs built in memory. Asserts the happy path, per-package omission
 * (invalid spec, 404, unsafe base, oversized, undecodable archive), dedup + cap,
 * and the KEYSTONE round-trip: a manifest the builder produces is accepted by the
 * runtime `fetchPackageFiles` against the SAME bytes (the two halves fit).
 */
import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { PackageSpec } from "@galley/compiler";
import { buildIntegrityManifest } from "./build-manifest.js";
import { fetchPackageFiles } from "./registry-resolver.js";

const BLOCK = 512;
const enc = new TextEncoder();

/** Minimal strict-ustar writer (regular files only) → bytes. */
function makeTar(files: Array<{ path: string; text: string }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const f of files) {
    const data = enc.encode(f.text);
    const h = new Uint8Array(BLOCK);
    const put = (s: string, at: number, len: number) => {
      for (let i = 0; i < Math.min(s.length, len); i++) h[at + i] = s.charCodeAt(i);
    };
    const octal = (v: number, at: number, len: number) => {
      put(v.toString(8).padStart(len - 1, "0"), at, len - 1);
      h[at + len - 1] = 0;
    };
    put(f.path, 0, 100);
    octal(0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(data.length, 124, 12);
    octal(0, 136, 12);
    h[156] = 0x30; // regular
    put("ustar\0", 257, 6);
    put("00", 263, 2);
    for (let i = 148; i < 156; i++) h[i] = 0x20;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += h[i]!;
    put(sum.toString(8).padStart(6, "0"), 148, 6);
    h[154] = 0;
    h[155] = 0x20;
    const padded = Math.ceil(data.length / BLOCK) * BLOCK;
    const blk = new Uint8Array(BLOCK + padded);
    blk.set(h, 0);
    blk.set(data, BLOCK);
    blocks.push(blk);
  }
  const end = new Uint8Array(BLOCK * 2);
  const len = blocks.reduce((n, b) => n + b.length, 0) + end.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  out.set(end, off);
  return out;
}

function pkgGz(name: string, version: string): Uint8Array {
  return new Uint8Array(
    gzipSync(
      makeTar([
        { path: "typst.toml", text: `[package]\nname = "${name}"\nversion = "${version}"\nentrypoint = "lib.typ"\n` },
        { path: "lib.typ", text: `#let id(x) = x\n` },
      ]),
    ),
  );
}

const BASE = "http://127.0.0.1:9/registry"; // loopback fixture base

/** A fake registry keyed by the exact artifact path the builder requests. */
function fakeRegistry(map: Record<string, Uint8Array | number>): typeof fetch {
  return (async (url: string) => {
    const m = /\/preview\/([^/]+)$/.exec(url);
    const entry = m ? map[m[1]!] : undefined;
    if (entry === undefined) return new Response(null, { status: 404 });
    if (typeof entry === "number") return new Response(null, { status: entry });
    return new Response(entry, { status: 200 });
  }) as unknown as typeof fetch;
}

describe("buildIntegrityManifest", () => {
  it("snapshots a pinned package into a correct {sha256,size} entry", async () => {
    const gz = pkgGz("alpha", "1.0.0");
    const { manifest, ok, failed } = await buildIntegrityManifest(["@preview/alpha:1.0.0"], {
      baseUrl: BASE,
      fetch: fakeRegistry({ "alpha-1.0.0.tar.gz": gz }),
    });
    expect(ok).toEqual(["@preview/alpha:1.0.0"]);
    expect(failed).toEqual([]);
    expect(manifest["@preview/alpha:1.0.0"]).toEqual({
      sha256: createHash("sha256").update(gz).digest("hex"),
      size: gz.length,
    });
  });

  it("round-trips: a built manifest is accepted by the runtime fetchPackageFiles", async () => {
    const gz = pkgGz("beta", "2.3.4");
    const fetchImpl = fakeRegistry({ "beta-2.3.4.tar.gz": gz });
    const spec: PackageSpec = { namespace: "preview", name: "beta", version: "2.3.4" };

    const { manifest } = await buildIntegrityManifest(["@preview/beta:2.3.4"], { baseUrl: BASE, fetch: fetchImpl });
    // The runtime path verifies the SAME bytes against the builder's manifest.
    const files = await fetchPackageFiles(spec, { baseUrl: BASE, integrity: manifest, fetch: fetchImpl });
    expect(files.map((f) => f.path)).toEqual(["typst.toml", "lib.typ"]);
  });

  it("omits an invalid/unpinned spec (reported in failed)", async () => {
    const { manifest, ok, failed } = await buildIntegrityManifest(
      ["@preview/x:latest", "not-a-spec", "@preview/y:^1.0.0"],
      { baseUrl: BASE, fetch: fakeRegistry({}) },
    );
    expect(ok).toEqual([]);
    expect(Object.keys(manifest)).toEqual([]);
    expect(failed.map((f) => f.spec)).toEqual(["@preview/x:latest", "not-a-spec", "@preview/y:^1.0.0"]);
  });

  it("omits a package that 404s (fail closed, run still succeeds for the rest)", async () => {
    const gz = pkgGz("good", "1.0.0");
    const { manifest, ok, failed } = await buildIntegrityManifest(
      ["@preview/good:1.0.0", "@preview/missing:1.0.0"],
      { baseUrl: BASE, fetch: fakeRegistry({ "good-1.0.0.tar.gz": gz }) },
    );
    expect(ok).toEqual(["@preview/good:1.0.0"]);
    expect(failed.map((f) => f.spec)).toEqual(["@preview/missing:1.0.0"]);
  });

  it("omits when the base URL is unsafe (every package fails closed)", async () => {
    const { ok, failed } = await buildIntegrityManifest(["@preview/alpha:1.0.0"], {
      baseUrl: "http://evil.example.com",
      fetch: fakeRegistry({ "alpha-1.0.0.tar.gz": pkgGz("alpha", "1.0.0") }),
    });
    expect(ok).toEqual([]);
    expect(failed[0]!.reason).toMatch(/https/);
  });

  it("omits an artifact whose compressed body exceeds the cap", async () => {
    const gz = pkgGz("big", "1.0.0");
    const { ok, failed } = await buildIntegrityManifest(["@preview/big:1.0.0"], {
      baseUrl: BASE,
      fetch: fakeRegistry({ "big-1.0.0.tar.gz": gz }),
      maxCompressedBytes: 4,
    });
    expect(ok).toEqual([]);
    expect(failed[0]!.reason).toMatch(/too large/);
  });

  it("omits a non-archive body (gunzip/extract fails → not hashed)", async () => {
    const { ok, failed } = await buildIntegrityManifest(["@preview/junk:1.0.0"], {
      baseUrl: BASE,
      fetch: fakeRegistry({ "junk-1.0.0.tar.gz": new Uint8Array([1, 2, 3, 4, 5]) }),
    });
    expect(ok).toEqual([]);
    expect(failed.map((f) => f.spec)).toEqual(["@preview/junk:1.0.0"]);
  });

  it("deduplicates specs (one fetch per distinct package)", async () => {
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(pkgGz("dup", "1.0.0"), { status: 200 });
    }) as unknown as typeof fetch;
    const { ok } = await buildIntegrityManifest(["@preview/dup:1.0.0", "@preview/dup:1.0.0"], {
      baseUrl: BASE,
      fetch: counting,
    });
    expect(ok).toEqual(["@preview/dup:1.0.0"]);
    expect(calls).toBe(1);
  });

  it("caps the number of packages built per run", async () => {
    const gz = pkgGz("p", "1.0.0");
    const { ok, failed } = await buildIntegrityManifest(
      ["@preview/a:1.0.0", "@preview/b:1.0.0", "@preview/c:1.0.0"],
      { baseUrl: BASE, fetch: fakeRegistry({ "a-1.0.0.tar.gz": gz, "b-1.0.0.tar.gz": gz, "c-1.0.0.tar.gz": gz }), maxPackages: 2 },
    );
    expect(ok.length).toBe(2);
    expect(failed.some((f) => /maxPackages/.test(f.reason))).toBe(true);
  });
});
