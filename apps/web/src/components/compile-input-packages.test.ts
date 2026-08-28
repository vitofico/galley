import { describe, it, expect } from "vitest";
import type { CompileInput, ProjectInput } from "@galley/shared";
import {
  compileInputImportsPackages,
  listPackageImports,
} from "./compile-input-packages.js";

/**
 * Unit tests for the PURE `@preview/…` import detector (Wave-2 Lane A, #2/E2).
 *
 * This is the routing-relevant question — "does this document import Universe
 * packages?" — feeding the compile-mode policy. The load-bearing invariants:
 *   - detects `@preview/…` in a bare-string input AND in any project file;
 *   - matches both the `#import "@preview/x:1.0.0": *` and bare-`#import` forms;
 *   - is conservative about the grammar (only real, server-resolvable coordinates
 *     count — not uppercase, floating-version, or namespace-only mentions);
 *   - is PURE/offline: no network, no DOM, deterministic.
 */

const project = (files: ProjectInput["files"], main = files[0]?.path ?? "/main.typ"): ProjectInput => ({
  kind: "project",
  files,
  main,
});

describe("compileInputImportsPackages (string input)", () => {
  it("detects a `@preview` import with an import list", () => {
    expect(compileInputImportsPackages(`#import "@preview/cetz:0.2.0": canvas\n`)).toBe(true);
  });

  it("detects a bare `@preview` import (no list)", () => {
    expect(compileInputImportsPackages(`#import "@preview/tablex:0.0.8"\n`)).toBe(true);
  });

  it("detects a prerelease version", () => {
    expect(compileInputImportsPackages(`#import "@preview/x:1.0.0-rc.1": y\n`)).toBe(true);
  });

  it("is false for a document with no package imports", () => {
    expect(compileInputImportsPackages("= Just a heading\n\nLorem ipsum.\n")).toBe(false);
  });

  it("is false for a local relative import (not a Universe package)", () => {
    expect(compileInputImportsPackages(`#import "./helpers.typ": foo\n`)).toBe(false);
  });

  it("is false for the empty string", () => {
    expect(compileInputImportsPackages("")).toBe(false);
  });
});

describe("compileInputImportsPackages (project input)", () => {
  it("detects a `@preview` import in `main`", () => {
    const input = project([
      { path: "/main.typ", text: `#import "@preview/cetz:0.2.0": canvas\n#canvas()\n` },
      { path: "/intro.typ", text: `= Intro\n` },
    ]);
    expect(compileInputImportsPackages(input)).toBe(true);
  });

  it("detects a `@preview` import in a NON-main file (anywhere in the project)", () => {
    const input = project(
      [
        { path: "/main.typ", text: `#include "/chapters/plot.typ"\n` },
        { path: "/chapters/plot.typ", text: `#import "@preview/cetz:0.2.0": canvas\n` },
      ],
      "/main.typ",
    );
    expect(compileInputImportsPackages(input)).toBe(true);
  });

  it("is false when no project file imports a package", () => {
    const input = project([
      { path: "/main.typ", text: `#include "/intro.typ"\n= Doc\n` },
      { path: "/intro.typ", text: `Just prose, a local #import "./util.typ": x\n` },
    ]);
    expect(compileInputImportsPackages(input)).toBe(false);
  });

  it("is false for a project with zero files", () => {
    expect(compileInputImportsPackages(project([], "/main.typ"))).toBe(false);
  });
});

describe("grammar conservatism (only real, server-resolvable coordinates count)", () => {
  it("ignores an uppercase package name (not a valid Universe coordinate)", () => {
    expect(compileInputImportsPackages(`#import "@preview/Evil:1.0.0": x\n`)).toBe(false);
  });

  it("ignores a floating / non-3-part version", () => {
    expect(compileInputImportsPackages(`#import "@preview/x:latest"\n`)).toBe(false);
    expect(compileInputImportsPackages(`#import "@preview/x:^1.0.0"\n`)).toBe(false);
    expect(compileInputImportsPackages(`#import "@preview/x:1.0"\n`)).toBe(false);
  });

  it("ignores build-metadata versions (rejected by the resolver grammar)", () => {
    expect(compileInputImportsPackages(`#import "@preview/x:1.0.0+build"\n`)).toBe(false);
  });

  // Trailing-version boundary (egress false-positive defense): a valid version
  // PREFIX inside an INVALID spec must NOT count — otherwise `auto` + trusted
  // server would route an uncompilable doc to the server for nothing.
  it("ignores a version with build metadata even with no closing quote", () => {
    expect(compileInputImportsPackages(`#import "@preview/x:1.0.0+build`)).toBe(false);
  });

  it("ignores a trailing-alpha version (e.g. 1.0.0alpha)", () => {
    expect(compileInputImportsPackages(`#import "@preview/x:1.0.0alpha"\n`)).toBe(false);
  });

  it("ignores an extra dot-segment version (e.g. 1.0.0.1)", () => {
    expect(compileInputImportsPackages(`#import "@preview/x:1.0.0.1"\n`)).toBe(false);
    expect(listPackageImports(`#import "@preview/x:1.0.0.1"\n`)).toEqual([]);
  });

  it("STILL detects a well-formed coordinate terminated by the closing quote", () => {
    expect(compileInputImportsPackages(`#import "@preview/cetz:0.2.0"`)).toBe(true);
    expect(compileInputImportsPackages(`#import "@preview/cetz:0.2.0": *\n`)).toBe(true);
    // And a legitimate prerelease (terminated by the quote) still counts.
    expect(compileInputImportsPackages(`#import "@preview/x:1.0.0-rc.1"\n`)).toBe(true);
  });

  it("ignores a bare `@preview` mention with no coordinate", () => {
    expect(compileInputImportsPackages("the word @preview appears in prose\n")).toBe(false);
  });

  it("ignores a different namespace (only `@preview` maps to Universe)", () => {
    expect(compileInputImportsPackages(`#import "@local/x:1.0.0": y\n`)).toBe(false);
  });
});

describe("listPackageImports", () => {
  it("returns the distinct specifiers across a project, order-preserving", () => {
    const input = project([
      { path: "/main.typ", text: `#import "@preview/a:1.0.0": x\n#import "@preview/b:2.0.0"\n` },
      { path: "/other.typ", text: `#import "@preview/a:1.0.0": y\n` }, // dup of a
    ]);
    expect(listPackageImports(input)).toEqual(["@preview/a:1.0.0", "@preview/b:2.0.0"]);
  });

  it("returns the single specifier for a string input", () => {
    expect(listPackageImports(`#import "@preview/cetz:0.2.0": canvas\n`)).toEqual([
      "@preview/cetz:0.2.0",
    ]);
  });

  it("returns an empty list when nothing is imported", () => {
    expect(listPackageImports("= Heading\n")).toEqual([]);
  });

  it("dedupes the same specifier within one source", () => {
    const src = `#import "@preview/cetz:0.2.0": *\n#import "@preview/cetz:0.2.0"\n`;
    expect(listPackageImports(src)).toEqual(["@preview/cetz:0.2.0"]);
  });

  it("agrees with the boolean detector", () => {
    const withPkg: CompileInput = `#import "@preview/cetz:0.2.0"\n`;
    const noPkg: CompileInput = "= Heading\n";
    expect(listPackageImports(withPkg).length > 0).toBe(compileInputImportsPackages(withPkg));
    expect(listPackageImports(noPkg).length > 0).toBe(compileInputImportsPackages(noPkg));
  });
});

describe("purity / robustness", () => {
  it("does not throw on a very large source and stays bounded", () => {
    const big = "x".repeat(2_000_000) + `#import "@preview/late:1.0.0"\n`;
    // The import is past the 1MB scan cap, so it is NOT detected — bounded by design.
    expect(() => compileInputImportsPackages(big)).not.toThrow();
    expect(compileInputImportsPackages(big)).toBe(false);
  });

  it("repeated calls are stateless (no shared regex lastIndex leak)", () => {
    const src = `#import "@preview/cetz:0.2.0"\n`;
    expect(compileInputImportsPackages(src)).toBe(true);
    expect(compileInputImportsPackages(src)).toBe(true);
    expect(listPackageImports(src)).toEqual(["@preview/cetz:0.2.0"]);
    expect(listPackageImports(src)).toEqual(["@preview/cetz:0.2.0"]);
  });
});
