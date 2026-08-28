import { describe, it, expect } from "vitest";
import {
  FakeRegistry,
  PackageValidationError,
  parsePackageImports,
  parsePackageSpec,
  packageSpecString,
  resolvePackagePaths,
  type PackageSpec,
} from "./package-resolver.js";

const PROBE: PackageSpec = { namespace: "preview", name: "probe", version: "0.1.0" };

describe("parsePackageSpec — strict validation (no spoofing / URLs)", () => {
  it("accepts a well-formed @ns/name:version", () => {
    expect(parsePackageSpec("@preview/cetz:0.2.0")).toEqual({
      namespace: "preview",
      name: "cetz",
      version: "0.2.0",
    });
  });

  it("accepts a prerelease but not build metadata", () => {
    expect(parsePackageSpec("@preview/x:1.0.0-rc.1")?.version).toBe("1.0.0-rc.1");
    expect(parsePackageSpec("@preview/x:1.0.0+build")).toBeNull();
  });

  it("rejects URLs, uppercase, floating versions, traversal, and junk", () => {
    for (const bad of [
      "@preview/x:latest",
      "@preview/x:^1.0.0",
      "@preview/x:1.0", // not 3-part
      "@preview/Evil:1.0.0", // uppercase
      "@preview/x", // no version
      "preview/x:1.0.0", // no @
      "@preview/../etc:1.0.0",
      "@preview/x:1.0.0/../../y",
      "@http://evil.com/x:1.0.0",
      "@préview/x:1.0.0", // unicode confusable
      "",
    ]) {
      expect(parsePackageSpec(bad)).toBeNull();
    }
  });
});

describe("parsePackageImports — bounded, ReDoS-safe scan", () => {
  it("finds distinct specs in source, order-preserving + deduped", () => {
    const src = `#import "@preview/cetz:0.2.0": *\n#import "@preview/cetz:0.2.0"\n#import "@preview/tablex:0.0.8"`;
    expect(parsePackageImports(src).map(packageSpecString)).toEqual([
      "@preview/cetz:0.2.0",
      "@preview/tablex:0.0.8",
    ]);
  });

  it("returns [] when there are no package imports", () => {
    expect(parsePackageImports('#import "/lib.typ": x\n= Title')).toEqual([]);
  });

  it("does not hang on adversarial input (linear scan)", () => {
    const evil = "@".repeat(50_000) + "preview/x:1.0.0";
    const start = Date.now();
    parsePackageImports(evil);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("resolvePackagePaths — namespace-scoped, traversal-proof, size-capped", () => {
  it("normalizes files under the package's own canonical root", () => {
    const out = resolvePackagePaths(PROBE, [
      { path: "lib.typ", text: "#let hi = []" },
      { path: "typst.toml", text: "[package]" },
    ]);
    expect(out.map((f) => f.path)).toEqual([
      "/packages/preview/probe/0.1.0/lib.typ",
      "/packages/preview/probe/0.1.0/typst.toml",
    ]);
  });

  it("rejects path traversal and absolute paths (no escaping the namespace)", () => {
    for (const bad of ["../escape.typ", "/abs.typ", "a/../../b.typ", "sub/../../x.typ", ".\\win.typ"]) {
      expect(() => resolvePackagePaths(PROBE, [{ path: bad, text: "x" }])).toThrow(
        PackageValidationError,
      );
    }
  });

  it("rejects disallowed file types (no plugin/WASM/asset smuggling)", () => {
    expect(() => resolvePackagePaths(PROBE, [{ path: "evil.wasm", text: "x" }])).toThrow(
      PackageValidationError,
    );
  });

  it("enforces file-count and size caps (DoS guard)", () => {
    const tiny = { maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 100 };
    expect(() =>
      resolvePackagePaths(
        PROBE,
        [
          { path: "a.typ", text: "x" },
          { path: "b.typ", text: "y" },
          { path: "c.typ", text: "z" },
        ],
        tiny,
      ),
    ).toThrow(/max 2/);
    expect(() =>
      resolvePackagePaths(PROBE, [{ path: "a.typ", text: "x".repeat(50) }], tiny),
    ).toThrow(PackageValidationError);
  });

  it("rejects duplicate normalized paths", () => {
    expect(() =>
      resolvePackagePaths(PROBE, [
        { path: "lib.typ", text: "a" },
        { path: "lib.typ", text: "b" },
      ]),
    ).toThrow(/duplicate/);
  });
});

describe("FakeRegistry — offline, in-memory, pre-validated", () => {
  it("resolves a known package to namespace-scoped files; null for unknown", () => {
    const reg = new FakeRegistry({
      "@preview/probe:0.1.0": [{ path: "lib.typ", text: "#let hi = [pkg]" }],
    });
    expect(reg.resolve(PROBE)?.[0]?.path).toBe("/packages/preview/probe/0.1.0/lib.typ");
    expect(reg.resolve({ namespace: "preview", name: "missing", version: "1.0.0" })).toBeNull();
  });

  it("fails fast on an invalid spec key or unsafe files at construction", () => {
    expect(() => new FakeRegistry({ "not a spec": [] })).toThrow(PackageValidationError);
    expect(
      () => new FakeRegistry({ "@preview/x:1.0.0": [{ path: "../escape.typ", text: "x" }] }),
    ).toThrow(PackageValidationError);
  });
});
