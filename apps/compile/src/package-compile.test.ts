/**
 * Roadmap #3 slice 6: package-enabled server compile wiring. A fake engine +
 * fake prewarm prove the scan → prewarm → set-holder → compile → clear-holder
 * dance without needing WASM or the network (slices 1 + 5 already proved those
 * ends with the real engine and the real fetch/extract).
 */
import { describe, it, expect, vi } from "vitest";
import type { PackageResolver, PackageSpec } from "@galley/compiler";
import type { CheckResult, ExportResult, ProjectInput, RenderResult } from "@galley/shared";
import type { CompileBackend } from "./index.js";
import {
  MutablePackageResolver,
  createPackageAwareBackend,
  scanCompileInputImports,
} from "./package-compile.js";

const spec = (name: string, version = "1.0.0"): PackageSpec => ({ namespace: "preview", name, version });

describe("scanCompileInputImports", () => {
  it("finds a @preview import in a single-file source", () => {
    expect(scanCompileInputImports(`#import "@preview/cetz:0.2.0": canvas\n`)).toEqual([
      { namespace: "preview", name: "cetz", version: "0.2.0" },
    ]);
  });

  it("merges + dedupes across project files", () => {
    const project: ProjectInput = {
      kind: "project",
      main: "/main.typ",
      files: [
        { path: "/main.typ", text: `#import "@preview/a:1.0.0": x\n#import "@preview/b:2.0.0"\n` },
        { path: "/other.typ", text: `#import "@preview/a:1.0.0": y\n` }, // dup of a
      ],
    };
    expect(scanCompileInputImports(project)).toEqual([spec("a"), { namespace: "preview", name: "b", version: "2.0.0" }]);
  });

  it("returns [] when there are no package imports", () => {
    expect(scanCompileInputImports("= Just a heading\n")).toEqual([]);
  });
});

describe("createPackageAwareBackend", () => {
  const okCheck: CheckResult = { ok: true, diagnostics: [], pageCount: 1, durationMs: 0 };
  const okRender: RenderResult = { ok: true, diagnostics: [], pages: [], durationMs: 0 };
  const okExport: ExportResult = { ok: true, diagnostics: [], pdf: null };

  function setup() {
    const holder = new MutablePackageResolver();
    const sentinel: PackageResolver = { resolve: () => null };
    let seenDuring: PackageResolver | null | "unset" = "unset";
    const engine: CompileBackend = {
      check: async () => {
        seenDuring = holder.current;
        return okCheck;
      },
      render: async () => okRender,
      export: async () => okExport,
    };
    const prewarm = vi.fn(async () => sentinel);
    const backend = createPackageAwareBackend({ engine, holder, prewarm });
    return { holder, sentinel, engine, prewarm, backend, getSeen: () => seenDuring };
  }

  it("prewarms imported packages and points the holder at the resolver during compile", async () => {
    const { backend, prewarm, sentinel, holder, getSeen } = setup();
    await backend.check(`#import "@preview/foo:1.0.0": bar\n#bar()\n`);
    expect(prewarm).toHaveBeenCalledWith([spec("foo")]);
    expect(getSeen()).toBe(sentinel); // resolver was live during the engine call
    expect(holder.current).toBeNull(); // cleared afterwards
  });

  it("does not prewarm when there are no imports (holder stays null)", async () => {
    const { backend, prewarm, holder, getSeen } = setup();
    await backend.check("= Heading\n");
    expect(prewarm).not.toHaveBeenCalled();
    expect(getSeen()).toBeNull();
    expect(holder.current).toBeNull();
  });

  it("clears the holder even when the compile throws", async () => {
    const holder = new MutablePackageResolver();
    const prewarm = vi.fn(async () => ({ resolve: () => null }) as PackageResolver);
    const engine: CompileBackend = {
      check: async () => {
        throw new Error("boom");
      },
      render: async () => okRender,
      export: async () => okExport,
    };
    const backend = createPackageAwareBackend({ engine, holder, prewarm });
    await expect(backend.check(`#import "@preview/foo:1.0.0"\n`)).rejects.toThrow("boom");
    expect(holder.current).toBeNull();
  });

  it("wraps render and export too", async () => {
    const { backend, prewarm } = setup();
    await backend.render(`#import "@preview/foo:1.0.0"\n`);
    await backend.export(`#import "@preview/foo:1.0.0"\n`);
    expect(prewarm).toHaveBeenCalledTimes(2);
  });
});
