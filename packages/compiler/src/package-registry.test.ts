/**
 * Roadmap #3 slice 1: the package-registry bridge. Proves a `@preview/…` import
 * resolves OFFLINE through the ADR-0014 resolver seam when (and only when) a
 * resolver is supplied — and stays fail-closed otherwise. Real typst.ts in Node.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectInput } from "@galley/shared";
import { TypstEngine } from "./typst-engine.js";
import { FakeRegistry } from "./package-resolver.js";

const require = createRequire(import.meta.url);
function wasmFor(pkg: string, file: string): Uint8Array {
  const entry = require.resolve(pkg);
  return new Uint8Array(readFileSync(join(dirname(entry), file)));
}

// A minimal, valid @preview/probe:0.1.0 package (manifest + entrypoint).
const PROBE = [
  {
    path: "typst.toml",
    text: `[package]\nname = "probe"\nversion = "0.1.0"\nentrypoint = "lib.typ"\n`,
  },
  { path: "lib.typ", text: `#let hi() = [Hello from probe]\n#let answer = 42\n` },
];

let compilerModule: Uint8Array;
beforeAll(() => {
  compilerModule = wasmFor(
    "@myriaddreamin/typst-ts-web-compiler",
    "typst_ts_web_compiler_bg.wasm",
  );
});

const IMPORTING_DOC = `#import "@preview/probe:0.1.0": hi, answer\n#hi() — #answer\n`;

describe("package-registry bridge (roadmap #3)", () => {
  // This is the FIRST real-WASM compile in the file, so it pays the one-time cold
  // typst.ts init; under load that can exceed the 5s default (a long-documented
  // flake). Give the cold-start case a generous timeout — the sibling cases below
  // reuse the warm engine and stay well under the default.
  it("resolves a @preview import from a FakeRegistry and compiles clean", async () => {
    const resolver = new FakeRegistry({ "@preview/probe:0.1.0": PROBE });
    const engine = await TypstEngine.create({ compilerModule, packageResolver: resolver });
    const res = await engine.check(IMPORTING_DOC);
    expect(res.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(res.ok).toBe(true);
  }, 30_000);

  it("fails closed when NO resolver is supplied (default engine unchanged)", async () => {
    const engine = await TypstEngine.create({ compilerModule });
    const res = await engine.check(IMPORTING_DOC);
    expect(res.ok).toBe(false);
    const err = res.diagnostics.find((d) => d.severity === "error");
    expect(err).toBeDefined();
    // typst.ts's fail-closed signal is its "Dummy Registry" / package-load error;
    // we only assert it failed with a message, not the exact wording.
    expect(err!.message.length).toBeGreaterThan(0);
  });

  it("fails closed for a package the resolver doesn't have (no crash)", async () => {
    const resolver = new FakeRegistry({ "@preview/other:1.0.0": PROBE });
    const engine = await TypstEngine.create({ compilerModule, packageResolver: resolver });
    const res = await engine.check(IMPORTING_DOC); // imports probe, not other
    expect(res.ok).toBe(false);
    expect(res.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("resolves a package import from inside a multi-file project compile", async () => {
    const resolver = new FakeRegistry({ "@preview/probe:0.1.0": PROBE });
    const engine = await TypstEngine.create({ compilerModule, packageResolver: resolver });
    const project: ProjectInput = {
      kind: "project",
      main: "/main.typ",
      files: [
        { path: "/main.typ", text: `#import "/util.typ": shout\n#shout()\n` },
        {
          path: "/util.typ",
          text: `#import "@preview/probe:0.1.0": hi\n#let shout() = [#hi()!]\n`,
        },
      ],
    };
    const res = await engine.check(project);
    expect(res.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(res.ok).toBe(true);
  });

  it("keeps resolving across repeated compiles (cache survives resetShadow)", async () => {
    const resolver = new FakeRegistry({ "@preview/probe:0.1.0": PROBE });
    const engine = await TypstEngine.create({ compilerModule, packageResolver: resolver });
    // A project compile calls resetShadow(); the package access model must persist.
    const proj: ProjectInput = {
      kind: "project",
      main: "/main.typ",
      files: [{ path: "/main.typ", text: IMPORTING_DOC }],
    };
    const first = await engine.check(proj);
    expect(first.ok).toBe(true);
    const second = await engine.check(IMPORTING_DOC); // single-file, same engine
    expect(second.ok).toBe(true);
  });
});
