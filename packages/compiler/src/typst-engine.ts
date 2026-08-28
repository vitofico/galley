/**
 * `TypstEngine` — the framework-agnostic typst.ts binding behind
 * `@galley/compiler` (docs/compiler.md, ADR-0001).
 *
 * It turns a Typst source string into `check` (diagnostics + page count),
 * `render` (SVG for the live preview), or `export` (PDF). It imports typst.ts
 * but NOT the WASM/font bytes — those are injected, so the same engine runs in a
 * browser Web Worker (assets fetched as bundled URLs) and in Node tests (assets
 * read from disk). No React, no DOM ownership.
 *
 * `check` only needs the compiler WASM (diagnostics are font-free); `render` /
 * `export` / page-count use the renderer WASM, and `render` needs fonts to draw
 * real glyphs.
 */

import {
  CompileFormatEnum,
  createTypstCompiler,
} from "@myriaddreamin/typst.ts/compiler";
import { createTypstRenderer } from "@myriaddreamin/typst.ts/renderer";
import { initOptions } from "@myriaddreamin/typst.ts";
import type { BeforeBuildFn } from "@myriaddreamin/typst.ts";
import type {
  CheckResult,
  CompileInput,
  Diagnostic,
  ExportResult,
  PreviewSourceMap,
  ProjectInput,
  RenderResult,
  RenderedPage,
} from "@galley/shared";
import { isProjectInput, computeCompileArtifact, TYPST_VECTOR_MIME } from "@galley/shared";
import {
  normalizeDiagnostics,
  normalizeProjectDiagnostics,
} from "./diagnostics.js";
import { packageRegistryBeforeBuild } from "./package-registry-bridge.js";
import type { PackageResolver } from "./package-resolver.js";
import {
  buildPreviewSourceMap,
  buildProjectPreviewSourceMap,
  orderFilesByDocumentOrder,
} from "./preview-source-map.js";

const MAIN_PATH = "/main.typ";

/** Project file paths are absolute; typst.ts wants a consistent leading slash. */
function canonicalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/** A WASM module as bytes, or a (possibly async) provider of them. */
export type ModuleSource =
  | Uint8Array
  | ArrayBuffer
  | (() => Uint8Array | ArrayBuffer | Promise<Uint8Array | ArrayBuffer>);

export interface TypstEngineOptions {
  /** typst compiler WASM (required) — `check` needs only this. */
  compilerModule: ModuleSource;
  /** typst renderer WASM — required for `render`, `export`, and page counts. */
  rendererModule?: ModuleSource;
  /**
   * URL prefix where the default typst **text** fonts are served (e.g. `/fonts/`),
   * trailing slash optional. typst.ts 0.7 bundles NO fonts in the WASM — without
   * this the compiler lays text out with empty glyphs and the preview renders
   * blank. When set, the default text-font set (Libertinus/NewCM/DejaVuMono) is
   * fetched from `<fontAssetPrefix><file>` at init (offline-first: the app serves
   * these locally, never a CDN). Omitted in Node tests/diagnostics-only paths,
   * where glyph rendering isn't exercised.
   */
  fontAssetPrefix?: string;
  /**
   * Raw font files (bytes) to register at init — the Node counterpart to
   * `fontAssetPrefix` (which fetches over HTTP and so can't run in a server-less
   * Node test). Used by the examples compile gate to load the SAME font set the
   * browser serves from `/fonts/` (incl. the NewCMMath math font), so math-mode
   * documents compile and render with real glyphs instead of erroring with
   * "no font could be found". Mutually exclusive with `fontAssetPrefix` in
   * practice; if both are given, both sets are registered.
   */
  fontBlobs?: Uint8Array[];
  /**
   * Optional ADR-0014 package resolver. When supplied, `@preview/…` imports
   * resolve through it (roadmap #3, server-side compile). When omitted, package
   * imports stay **fail-closed** — typst.ts is left with no registry, so the
   * single-file/browser path is byte-for-byte unchanged.
   */
  packageResolver?: PackageResolver;
}

function asProvider(
  src: ModuleSource,
): () => Uint8Array | ArrayBuffer | Promise<Uint8Array | ArrayBuffer> {
  return typeof src === "function" ? src : () => src;
}

// typst.ts's renderer types are loose around sessions; isolate the casts here.
interface RendererLike {
  init(opts: { getModule: () => unknown }): Promise<void>;
  runWithSession<T>(fn: (session: unknown) => Promise<T>): Promise<T>;
  manipulateData(opts: {
    renderSession: unknown;
    action: string;
    data: Uint8Array;
  }): void;
  retrievePagesInfoFromSession(
    session: unknown,
  ): Array<{ width?: number; height?: number }>;
  renderSvg(opts: { renderSession: unknown }): Promise<string>;
}

export class TypstEngine {
  private renderer: RendererLike | null = null;

  private constructor(
    private readonly compiler: ReturnType<typeof createTypstCompiler>,
    private readonly rendererModule: ModuleSource | undefined,
  ) {}

  static async create(options: TypstEngineOptions): Promise<TypstEngine> {
    const compiler = createTypstCompiler();
    // typst.ts 0.7 bundles NO fonts in the WASM — fonts must be registered at init
    // via a `beforeBuild` callback, or text renders with empty glyphs. We load the
    // default text-font set from `fontAssetPrefix` (the app serves it locally; the
    // default would otherwise be a CDN, which offline-first forbids). A package
    // resolver, when supplied, contributes its own `beforeBuild` callbacks. With
    // neither, `beforeBuild` is omitted entirely so init is byte-for-byte as before.
    const beforeBuild: BeforeBuildFn[] = [
      ...(options.fontAssetPrefix
        ? [
            initOptions.preloadFontAssets({
              assets: ["text"],
              assetUrlPrefix: options.fontAssetPrefix,
            }),
          ]
        : []),
      ...(options.fontBlobs && options.fontBlobs.length > 0
        ? // `{ assets: false }` is load-bearing, not cosmetic: typst.ts's
          // `TypstCompilerDriver.init` injects a DEFAULT `['text']` font loader
          // that fetches the typst-assets set from a jsdelivr CDN unless a
          // `beforeBuild` loader explicitly opts out (its internal flags are
          // `hasSpecifiedAssets` / `hasDisableAssets`). A bare `loadFonts(blobs)`
          // carries no such flag, so the default CDN fetch is still queued —
          // invisible where egress works (the network-enabled green-gate), but a
          // hard ETIMEDOUT crash on the air-gapped server-compile pod. `assets:
          // false` registers ONLY our bundled blobs and disables the CDN default,
          // keeping the Node path truly offline-first.
          [initOptions.loadFonts(options.fontBlobs, { assets: false })]
        : []),
      ...(options.packageResolver
        ? packageRegistryBeforeBuild(options.packageResolver)
        : []),
    ];
    if (beforeBuild.length > 0) {
      await compiler.init({
        getModule: asProvider(options.compilerModule),
        beforeBuild,
      });
    } else {
      await compiler.init({ getModule: asProvider(options.compilerModule) });
    }
    return new TypstEngine(compiler, options.rendererModule);
  }

  private async ensureRenderer(): Promise<RendererLike> {
    if (this.renderer) return this.renderer;
    if (!this.rendererModule) {
      throw new Error("TypstEngine: renderer module was not provided");
    }
    const renderer = createTypstRenderer() as unknown as RendererLike;
    await renderer.init({ getModule: asProvider(this.rendererModule) });
    this.renderer = renderer;
    return renderer;
  }

  /**
   * Load a project's files into typst.ts's virtual filesystem and return its
   * main path. `resetShadow()` first so each project compile is **stale-free** —
   * files from a previous compile can't leak in (ADR-0013). `inputs:{}` at
   * compile time likewise clears any prior `sys.inputs`.
   */
  private loadProject(input: ProjectInput): string {
    this.compiler.resetShadow();
    for (const file of input.files) {
      this.compiler.addSource(canonicalizePath(file.path), file.text);
    }
    // #7: map binary files (image bytes) into the VFS so `image("/path")` resolves.
    // `mapShadow` takes raw bytes (vs `addSource` for text). Cleared by resetShadow
    // each compile, like text — absent/empty leaves the text-only path unchanged.
    for (const bin of input.binaryFiles ?? []) {
      this.compiler.mapShadow(canonicalizePath(bin.path), bin.bytes);
    }
    return canonicalizePath(input.main);
  }

  private async compileVector(
    input: CompileInput,
  ): Promise<{ result?: Uint8Array; diagnostics?: unknown }> {
    if (isProjectInput(input)) {
      const mainFilePath = this.loadProject(input);
      return this.compiler.compile({
        mainFilePath,
        format: CompileFormatEnum.vector,
        diagnostics: "full",
        inputs: {},
      });
    }
    // Single-file path. `resetShadow()` first so a prior project compile's VFS
    // files (e.g. /lib.typ) can't leak into this single-file compile (ADR-0013).
    this.compiler.resetShadow();
    this.compiler.addSource(MAIN_PATH, input);
    return this.compiler.compile({
      mainFilePath: MAIN_PATH,
      format: CompileFormatEnum.vector,
      diagnostics: "full",
    });
  }

  /** Normalize raw diagnostics against the right source(s) for this input. */
  private normalize(input: CompileInput, raw: unknown): Diagnostic[] {
    if (isProjectInput(input)) {
      const filesByPath = new Map(
        input.files.map((f) => [canonicalizePath(f.path), f.text]),
      );
      return normalizeProjectDiagnostics(raw, filesByPath);
    }
    return normalizeDiagnostics(raw, input);
  }

  /** Diagnostics + page count. Cheap; the agent loop's per-iteration call. */
  async check(input: CompileInput): Promise<CheckResult> {
    const start = performance.now();
    const res = await this.compileVector(input);
    const diagnostics = this.normalize(input, res.diagnostics);
    const compiled = res.result instanceof Uint8Array;
    const ok = compiled && !diagnostics.some((d) => d.severity === "error");
    let pageCount: number | null = null;
    if (ok && this.rendererModule && res.result) {
      try {
        pageCount = await this.countPages(res.result);
      } catch {
        pageCount = null; // page count is best-effort; never fail a clean check
      }
    }
    // Describe the compiled artifact (the Typst vector IR `check` emits) when a
    // build genuinely produced bytes — size + sha256, never the bytes. Omitted
    // on a failed/empty compile (no bytes to describe). Best-effort: a hashing
    // failure must never turn a clean check into a failed one.
    let artifact: CheckResult["artifact"];
    if (ok && res.result instanceof Uint8Array) {
      try {
        artifact = await computeCompileArtifact(res.result, TYPST_VECTOR_MIME);
      } catch {
        artifact = undefined;
      }
    }
    return {
      ok,
      diagnostics,
      pageCount,
      durationMs: performance.now() - start,
      ...(artifact !== undefined ? { artifact } : {}),
    };
  }

  private async countPages(vector: Uint8Array): Promise<number> {
    const renderer = await this.ensureRenderer();
    return renderer.runWithSession(async (session) => {
      renderer.manipulateData({
        renderSession: session,
        action: "reset",
        data: vector,
      });
      const pages = renderer.retrievePagesInfoFromSession(session);
      return Array.isArray(pages) ? pages.length : 0;
    });
  }

  /**
   * SVG pages for the live preview.
   *
   * `opts.sourceMap` (default off) opts into the forward source→preview index
   * (#11.3): when set, the engine ALSO derives a best-effort `sourceMap` from the
   * AST source ranges + the rendered SVG and attaches it to the result. It is
   * purely additive — when the flag is absent the result shape and all
   * rendering are byte-for-byte unchanged, and even when set the
   * index build is fail-soft (a throw/empty index never affects the SVG output).
   */
  async render(
    input: CompileInput,
    opts?: { sourceMap?: boolean },
  ): Promise<RenderResult> {
    const start = performance.now();
    const res = await this.compileVector(input);
    const diagnostics = this.normalize(input, res.diagnostics);
    if (!(res.result instanceof Uint8Array)) {
      return {
        ok: false,
        diagnostics,
        pages: [],
        durationMs: performance.now() - start,
      };
    }
    const vector = res.result;
    const renderer = await this.ensureRenderer();
    const { svg, info } = await renderer.runWithSession(async (session) => {
      renderer.manipulateData({
        renderSession: session,
        action: "reset",
        data: vector,
      });
      const svg = await renderer.renderSvg({ renderSession: session });
      const info = renderer.retrievePagesInfoFromSession(session);
      return { svg, info };
    });
    // MVP: typst renders all pages into one <svg>; surface it as a single page
    // with the first page's geometry. Per-page splitting can come later.
    const first = Array.isArray(info) ? info[0] : undefined;
    const pages: RenderedPage[] = [
      {
        index: 0,
        widthPt: first?.width ?? 0,
        heightPt: first?.height ?? 0,
        svg,
      },
    ];
    // The REAL page count comes from the renderer's per-page info (one entry
    // per document page) — `pages.length` is always 1 here (the combined-SVG
    // MVP entry above), which is a lie for a multi-page document (#20.2).
    const pageCount =
      Array.isArray(info) && info.length > 0 ? info.length : pages.length;
    const sourceMap = opts?.sourceMap
      ? await this.tryBuildSourceMap(input, svg, info)
      : undefined;
    return {
      ok: true,
      diagnostics,
      pages,
      pageCount,
      durationMs: performance.now() - start,
      // exactOptionalPropertyTypes: only attach the key when we actually built one.
      ...(sourceMap ? { sourceMap } : {}),
    };
  }

  /**
   * Best-effort forward index build (#11.3, B14). Asks the compiler for the AST
   * of the just-compiled source(s) and aligns it with the rendered SVG. Fully
   * fail-soft: any error (or an empty index) yields `undefined`, so the preview
   * degrades to exactly its default behavior. Never throws.
   *
   * For a single-file input, only the main AST is parsed (byte-for-byte the prior
   * behavior — no `filePath` on entries). For a multi-file project (B14 reverse
   * navigation), the AST of EVERY file is parsed and each entry is stamped with
   * its originating file path, so a click on rendered content from an imported
   * file resolves to that file. The main file is parsed first so its leaves lead
   * the positional zip (matching document reading order for the common case).
   */
  private async tryBuildSourceMap(
    input: CompileInput,
    svg: string,
    info: Array<{ width?: number; height?: number }>,
  ): Promise<PreviewSourceMap | undefined> {
    try {
      const pages = (Array.isArray(info) ? info : []).map((p) => ({
        widthPt: p.width ?? 0,
        heightPt: p.height ?? 0,
      }));
      let map: PreviewSourceMap;
      if (isProjectInput(input)) {
        const mainPath = canonicalizePath(input.main);
        // DOCUMENT reading order (fix/preview-backref): the anchored aligner zips
        // the concatenated leaf stream against the document-ordered SVG runs, so
        // the files must be concatenated in the order their content renders —
        // following the `#include` chain from main, NOT the project's arbitrary
        // file-list order (which scrambles the cross-file backbone). Each AST is
        // fetched from the VFS `compileVector` already populated; a per-file getAst
        // failure is tolerated (that file simply contributes no leaves).
        const ordered = orderFilesByDocumentOrder(mainPath, input.files);
        // SEQUENTIAL, not Promise.all: the typst.ts compiler is a single WASM
        // instance, so concurrent `getAst` calls into it could interleave unsafely.
        const sources: {
          astText: string | null;
          filePath: string;
          sourceText: string;
        }[] = [];
        for (const f of ordered) {
          const filePath = canonicalizePath(f.path);
          let astText: string | null = null;
          try {
            astText = await this.compiler.getAst(filePath);
          } catch {
            astText = null; // skip this file's leaves, keep the rest
          }
          // Thread the file's source text so the aligner can match each leaf's
          // substring against the rendered run and skip generated content
          // (fix/preview-backlink); fail-soft to "" if somehow absent.
          sources.push({ astText, filePath, sourceText: f.text ?? "" });
        }
        map = buildProjectPreviewSourceMap(sources, svg, pages);
      } else {
        const ast = await this.compiler.getAst(MAIN_PATH);
        // Single-file input IS the source string; pass it for text-anchored
        // alignment (fix/preview-backlink).
        const sourceText = typeof input === "string" ? input : "";
        map = buildPreviewSourceMap(ast, svg, pages, sourceText);
      }
      return map.entries.length > 0 ? map : undefined;
    } catch {
      return undefined; // index is an enhancement; never fail a clean render
    }
  }

  /** PDF bytes for download. */
  async export(input: CompileInput): Promise<ExportResult> {
    let mainFilePath: string;
    let compileOpts: {
      mainFilePath: string;
      format: CompileFormatEnum.pdf;
      diagnostics: "full";
      inputs?: Record<string, string>;
    };
    if (isProjectInput(input)) {
      mainFilePath = this.loadProject(input);
      compileOpts = {
        mainFilePath,
        format: CompileFormatEnum.pdf,
        diagnostics: "full",
        inputs: {},
      };
    } else {
      // Single-file path. `resetShadow()` first so a prior project compile's VFS
      // files (e.g. /lib.typ) can't leak into this single-file compile (ADR-0013).
      this.compiler.resetShadow();
      this.compiler.addSource(MAIN_PATH, input);
      compileOpts = {
        mainFilePath: MAIN_PATH,
        format: CompileFormatEnum.pdf,
        diagnostics: "full",
      };
    }
    const res = await this.compiler.compile(compileOpts);
    const diagnostics = this.normalize(input, res.diagnostics);
    const pdf = res.result instanceof Uint8Array ? res.result : null;
    return { ok: pdf !== null, diagnostics, pdf };
  }
}
