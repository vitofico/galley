/**
 * Roadmap #3 slice 5b: registry fetch + prewarm. Offline — a fake `fetch` serves a
 * real gzipped ustar built in memory, with the integrity manifest computed from
 * those exact bytes. Asserts the happy path AND the ADR-0016 fail-closed
 * behaviors: missing/mismatched integrity, redirect, non-200, compressed cap,
 * unsafe base URL, and per-package omission in prewarm.
 */
import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { PackageSpec } from "@galley/compiler";
import {
  RegistryError,
  fetchPackageFiles,
  fetchRegistryArtifact,
  prewarmRegistry,
  type IntegrityManifest,
} from "./registry-resolver.js";

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

const PROBE_SPEC: PackageSpec = { namespace: "preview", name: "probe", version: "0.1.0" };
const PROBE_FILES = [
  { path: "typst.toml", text: `[package]\nname = "probe"\nversion = "0.1.0"\nentrypoint = "lib.typ"\n` },
  { path: "lib.typ", text: `#let hi() = [hi]\n` },
];
const PROBE_GZ = new Uint8Array(gzipSync(makeTar(PROBE_FILES)));
const PROBE_INTEGRITY: IntegrityManifest = {
  "@preview/probe:0.1.0": {
    sha256: createHash("sha256").update(PROBE_GZ).digest("hex"),
    size: PROBE_GZ.length,
  },
};

const BASE = "http://127.0.0.1:9/registry"; // loopback fixture base

function fetchReturning(bytes: Uint8Array, status = 200): typeof fetch {
  return (async () => new Response(status === 200 ? bytes : null, { status })) as unknown as typeof fetch;
}

describe("fetchPackageFiles", () => {
  it("fetches, verifies integrity, and strictly extracts a package", async () => {
    const files = await fetchPackageFiles(PROBE_SPEC, {
      baseUrl: BASE,
      integrity: PROBE_INTEGRITY,
      fetch: fetchReturning(PROBE_GZ),
    });
    expect(files.map((f) => f.path)).toEqual(["typst.toml", "lib.typ"]);
  });

  it("builds the URL only from the validated spec + fixed base", async () => {
    const calls: string[] = [];
    const spyFetch = (async (url: string) => {
      calls.push(url);
      return new Response(PROBE_GZ, { status: 200 });
    }) as unknown as typeof fetch;
    await fetchPackageFiles(PROBE_SPEC, { baseUrl: BASE, integrity: PROBE_INTEGRITY, fetch: spyFetch });
    expect(calls[0]).toBe("http://127.0.0.1:9/registry/preview/probe-0.1.0.tar.gz");
  });

  it("fails closed when no integrity entry exists", async () => {
    await expect(
      fetchPackageFiles(PROBE_SPEC, { baseUrl: BASE, integrity: {}, fetch: fetchReturning(PROBE_GZ) }),
    ).rejects.toBeInstanceOf(RegistryError);
  });

  it("fails closed on an integrity hash mismatch", async () => {
    const wrong: IntegrityManifest = {
      "@preview/probe:0.1.0": { sha256: "00".repeat(32), size: PROBE_GZ.length },
    };
    await expect(
      fetchPackageFiles(PROBE_SPEC, { baseUrl: BASE, integrity: wrong, fetch: fetchReturning(PROBE_GZ) }),
    ).rejects.toThrow();
  });

  it("rejects a redirect (manual, no following)", async () => {
    await expect(
      fetchPackageFiles(PROBE_SPEC, {
        baseUrl: BASE,
        integrity: PROBE_INTEGRITY,
        fetch: fetchReturning(PROBE_GZ, 302),
      }),
    ).rejects.toBeInstanceOf(RegistryError);
  });

  it("rejects a non-200 response", async () => {
    await expect(
      fetchPackageFiles(PROBE_SPEC, {
        baseUrl: BASE,
        integrity: PROBE_INTEGRITY,
        fetch: fetchReturning(PROBE_GZ, 404),
      }),
    ).rejects.toBeInstanceOf(RegistryError);
  });

  it("rejects a compressed body over the cap", async () => {
    await expect(
      fetchPackageFiles(PROBE_SPEC, {
        baseUrl: BASE,
        integrity: PROBE_INTEGRITY,
        fetch: fetchReturning(PROBE_GZ),
        maxCompressedBytes: 4,
      }),
    ).rejects.toThrow(/too large/);
  });

  it("rejects a non-preview namespace", async () => {
    await expect(
      fetchPackageFiles(
        { namespace: "local", name: "x", version: "0.1.0" },
        { baseUrl: BASE, integrity: PROBE_INTEGRITY, fetch: fetchReturning(PROBE_GZ) },
      ),
    ).rejects.toThrow(/preview/);
  });

  it("rejects an unsafe (non-https, non-loopback) base URL", async () => {
    await expect(
      fetchPackageFiles(PROBE_SPEC, {
        baseUrl: "http://evil.example.com",
        integrity: PROBE_INTEGRITY,
        fetch: fetchReturning(PROBE_GZ),
      }),
    ).rejects.toThrow(/https/);
  });

  it("rejects a base URL with credentials", async () => {
    await expect(
      fetchPackageFiles(PROBE_SPEC, {
        baseUrl: "https://user:pass@packages.example.com",
        integrity: PROBE_INTEGRITY,
        fetch: fetchReturning(PROBE_GZ),
      }),
    ).rejects.toThrow(/credentials/);
  });

  it("rejects a cloud-metadata / link-local base URL even over https, without fetching (#22.2 SSRF)", async () => {
    for (const baseUrl of [
      "https://169.254.169.254/",
      "https://[fe80::1]/registry",
      "https://metadata.google.internal/",
    ]) {
      let called = false;
      const spyFetch = (async () => {
        called = true;
        return new Response(PROBE_GZ, { status: 200 });
      }) as unknown as typeof fetch;
      await expect(
        fetchPackageFiles(PROBE_SPEC, { baseUrl, integrity: PROBE_INTEGRITY, fetch: spyFetch }),
      ).rejects.toBeInstanceOf(RegistryError);
      expect(called).toBe(false); // refused before any network call
    }
  });
});

describe("fetchRegistryArtifact (shared network edge)", () => {
  it("rejects a spec that does not round-trip the strict parser, without fetching", async () => {
    let called = false;
    const spyFetch = (async () => {
      called = true;
      return new Response(PROBE_GZ, { status: 200 });
    }) as unknown as typeof fetch;
    // A hand-built PackageSpec with an illegal name (bypasses parsePackageSpec).
    await expect(
      fetchRegistryArtifact({ namespace: "preview", name: "../evil", version: "1.0.0" }, { baseUrl: BASE, fetch: spyFetch }),
    ).rejects.toThrow(/invalid package spec/);
    expect(called).toBe(false);
  });

  it("rejects a body whose declared Content-Length exceeds the cap", async () => {
    const oversized = (async () =>
      new Response(PROBE_GZ, {
        status: 200,
        headers: { "content-length": String(PROBE_GZ.length) },
      })) as unknown as typeof fetch;
    await expect(
      fetchRegistryArtifact(PROBE_SPEC, { baseUrl: BASE, fetch: oversized, maxCompressedBytes: 4 }),
    ).rejects.toThrow(/too large/);
  });
});

describe("prewarmRegistry", () => {
  it("builds a synchronous resolver from fetched packages", async () => {
    const resolver = await prewarmRegistry([PROBE_SPEC], {
      baseUrl: BASE,
      integrity: PROBE_INTEGRITY,
      fetch: fetchReturning(PROBE_GZ),
    });
    const resolved = resolver.resolve(PROBE_SPEC);
    expect(resolved!.map((f) => f.path)).toContain("/packages/preview/probe/0.1.0/typst.toml");
  });

  it("omits a package that fails (resolver returns null → compile fails closed)", async () => {
    // No integrity entry → fetch throws → package omitted.
    const resolver = await prewarmRegistry([PROBE_SPEC], {
      baseUrl: BASE,
      integrity: {},
      fetch: fetchReturning(PROBE_GZ),
    });
    expect(resolver.resolve(PROBE_SPEC)).toBeNull();
  });

  it("deduplicates specs", async () => {
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(PROBE_GZ, { status: 200 });
    }) as unknown as typeof fetch;
    await prewarmRegistry([PROBE_SPEC, { ...PROBE_SPEC }], {
      baseUrl: BASE,
      integrity: PROBE_INTEGRITY,
      fetch: counting,
    });
    expect(calls).toBe(1);
  });
});
