import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TypstEngine } from "./typst-engine.js";

// Real typst.ts compilation, in Node — no browser. WASM is read from the
// installed packages. No fonts are registered here: typst.ts 0.7 bundles none
// in the WASM, so text lays out with empty glyphs (a warning, not an error) and
// these diagnostics-only cases stay font-free. Math mode would need a math font
// (see examples.compile.test.ts, which loads the real set via `fontBlobs`).
const require = createRequire(import.meta.url);

function wasmFor(pkg: string, file: string): Uint8Array {
  const entry = require.resolve(pkg);
  return new Uint8Array(readFileSync(join(dirname(entry), file)));
}

let engine: TypstEngine;

/**
 * The staged typst font set (the same files the app serves from /fonts/, downloaded
 * by `pnpm --filter @galley/web copy-wasm`; the Docker gate stages them before the
 * suite). Returns `[]` when absent so font-free cases still run without a hard fail.
 */
function loadStagedFonts(): Uint8Array[] {
  const fontsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "apps",
    "web",
    "public",
    "fonts",
  );
  if (!existsSync(fontsDir)) return [];
  return readdirSync(fontsDir)
    .filter((f) => f.endsWith(".otf") || f.endsWith(".ttf"))
    .map((f) => new Uint8Array(readFileSync(join(fontsDir, f))));
}

const stagedFonts = loadStagedFonts();

beforeAll(async () => {
  const compilerModule = wasmFor(
    "@myriaddreamin/typst-ts-web-compiler",
    "typst_ts_web_compiler_bg.wasm",
  );
  const rendererModule = wasmFor(
    "@myriaddreamin/typst-ts-renderer",
    "typst_ts_renderer_bg.wasm",
  );
  engine = await TypstEngine.create({ compilerModule, rendererModule });
}, 60_000);

// Offline-first guard (server-compile crash, 2026-06-17). typst.ts's
// `TypstCompilerDriver.init` injects a DEFAULT `['text']` font loader that fetches
// the typst-assets set from a jsdelivr CDN unless a `beforeBuild` loader opts out.
// A bare `loadFonts(blobs)` did NOT opt out, so init queued a CDN fetch — silent
// where egress works (this green-gate), but a hard ETIMEDOUT crash on the
// air-gapped server-compile pod. The fix passes `{ assets: false }`. This test
// pins it: creating an engine with bundled fonts must touch the network ZERO times.
describe("TypstEngine.create offline-first (no CDN font fetch)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.runIf(stagedFonts.length > 0)(
    "registers bundled fontBlobs without any network fetch",
    async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("network fetch is forbidden during init"));
      const compilerModule = wasmFor(
        "@myriaddreamin/typst-ts-web-compiler",
        "typst_ts_web_compiler_bg.wasm",
      );
      const rendererModule = wasmFor(
        "@myriaddreamin/typst-ts-renderer",
        "typst_ts_renderer_bg.wasm",
      );
      const offlineEngine = await TypstEngine.create({
        compilerModule,
        rendererModule,
        fontBlobs: stagedFonts,
      });
      // The engine must be usable (real glyphs from the bundled fonts)…
      const res = await offlineEngine.render("= Heading\nBody text.");
      expect(res.ok).toBe(true);
      // …and init must NOT have reached for the network at all.
      expect(fetchSpy).not.toHaveBeenCalled();
    },
    60_000,
  );
});

describe("TypstEngine.check", () => {
  it("compiles a good document cleanly with a page count", async () => {
    const res = await engine.check(
      "#set page(width: 8cm, height: 4cm)\n= Hello\nBody text.",
    );
    expect(res.ok).toBe(true);
    expect(res.diagnostics.filter((d) => d.severity === "error")).toHaveLength(
      0,
    );
    expect(res.pageCount).toBeGreaterThanOrEqual(1);
  });

  it("counts multiple pages", async () => {
    const res = await engine.check("First\n#pagebreak()\nSecond");
    expect(res.ok).toBe(true);
    expect(res.pageCount).toBe(2);
  });

  it("reports a located error for a broken document", async () => {
    // `#let x =` with no expression: a syntax error on the second line.
    const res = await engine.check("= Title\n#let x =\nbody");
    expect(res.ok).toBe(false);
    const error = res.diagnostics.find((d) => d.severity === "error");
    expect(error).toBeDefined();
    expect(error!.message.length).toBeGreaterThan(0);
    // The error is on line 2 (1-based), where the broken `#let` is.
    expect(error!.span?.start.line).toBe(2);
  });

  it("maps a diagnostic span to the correct UTF-16 offsets/positions", async () => {
    const src = "#let a = 1\n#let b = (\n";
    const res = await engine.check(src);
    const error = res.diagnostics.find((d) => d.severity === "error");
    expect(error?.span).toBeDefined();
    // The span's derived position must round-trip against the source.
    const { offset, start } = error!.span!;
    expect(start.line).toBe(2);
    // offset points into line 2 (after the first newline at index 10).
    expect(offset).toBeGreaterThanOrEqual(11);
  });
});

describe("TypstEngine.render", () => {
  it("renders an SVG for the live preview", async () => {
    const res = await engine.render("= Heading\nSome text.");
    expect(res.ok).toBe(true);
    expect(res.pages).toHaveLength(1);
    expect(res.pages[0]!.svg).toContain("<svg");
  });

  it("returns no pages and the diagnostics for a broken document", async () => {
    const res = await engine.render("#let x =");
    expect(res.ok).toBe(false);
    expect(res.pages).toHaveLength(0);
    expect(res.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  // First-boot chip fix (#20.2): the MVP render path returns ONE combined <svg>
  // entry for the whole document, so `pages.length` is NOT the page count. The
  // result must carry the document's REAL page count separately.
  it("reports the real page count for a multi-page document", async () => {
    const res = await engine.render("First\n#pagebreak()\nSecond\n#pagebreak()\nThird");
    expect(res.ok).toBe(true);
    expect(res.pages).toHaveLength(1); // MVP: one combined <svg> entry
    expect(res.pageCount).toBe(3); // …but the count is the document's, not the array's
  });

  it("reports page count 1 for a single-page document", async () => {
    const res = await engine.render("Just one page.");
    expect(res.ok).toBe(true);
    expect(res.pageCount).toBe(1);
  });
});

// Forward source→preview index (#11.3, opt-in). The `sourceMap` field is ONLY
// present when render() is asked for it; the default render shape is unchanged.
//
// Building a real index needs fonts: without them typst.ts 0.7 emits no static
// glyph/`tsel` text layer in the one-shot SVG (the text layer is synthesized at
// runtime by an inline script), so there are no rendered runs to map. We
// therefore use a font-loaded engine here, mirroring examples.compile.test.ts.
// When fonts aren't staged (a bare checkout), the positive case self-skips; the
// default-off and fail-soft cases never need fonts and always run.
describe("TypstEngine.render source map (opt-in, #11.3)", () => {
  let fontEngine: TypstEngine;

  beforeAll(async () => {
    const compilerModule = wasmFor(
      "@myriaddreamin/typst-ts-web-compiler",
      "typst_ts_web_compiler_bg.wasm",
    );
    const rendererModule = wasmFor(
      "@myriaddreamin/typst-ts-renderer",
      "typst_ts_renderer_bg.wasm",
    );
    fontEngine = await TypstEngine.create(
      stagedFonts.length > 0
        ? { compilerModule, rendererModule, fontBlobs: stagedFonts }
        : { compilerModule, rendererModule },
    );
  }, 60_000);

  it("omits sourceMap by default (byte-for-byte unchanged result shape)", async () => {
    const res = await engine.render("= Heading\nSome body text here.");
    expect(res.ok).toBe(true);
    expect("sourceMap" in res ? res.sourceMap : undefined).toBeUndefined();
  });

  it.runIf(stagedFonts.length > 0)(
    "attaches a forward index when opted in, mapping a heading to a page region",
    async () => {
      const res = await fontEngine.render(
        "= Title\nHello world and some more body text.",
        {
          sourceMap: true,
        },
      );
      expect(res.ok).toBe(true);
      const map = res.sourceMap;
      expect(map).toBeDefined();
      expect(map!.entries.length).toBeGreaterThan(0);
      // Every entry points at a real page with a finite, non-negative bbox.
      for (const e of map!.entries) {
        expect(e.page).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(e.rect.x)).toBe(true);
        expect(Number.isFinite(e.rect.y)).toBe(true);
        expect(e.rect.width).toBeGreaterThanOrEqual(0);
        expect(e.rect.height).toBeGreaterThanOrEqual(0);
      }
      // The first source range starts on line 1 (the heading), at/after the marker.
      const first = map!.entries[0]!;
      expect(first.start.line).toBe(1);
    },
  );

  it("opting in on a broken document still fails soft (no map, no throw)", async () => {
    const res = await fontEngine.render("#let x =", { sourceMap: true });
    expect(res.ok).toBe(false);
    expect(res.sourceMap).toBeUndefined();
  });
});

describe("TypstEngine.export", () => {
  it("exports real PDF bytes for a good document", async () => {
    const res = await engine.export("= Title\nExported.");
    expect(res.ok).toBe(true);
    expect(res.pdf).toBeInstanceOf(Uint8Array);
    // PDF files start with the "%PDF-" magic.
    const header = new TextDecoder().decode(res.pdf!.slice(0, 5));
    expect(header).toBe("%PDF-");
  });
});

// Multi-file project compile (roadmap #2, ADR-0013). The same engine API accepts
// a ProjectInput; typst.ts resolves virtual `#import`s between the loaded files.
describe("TypstEngine project compile", () => {
  it("resolves a virtual #import between files and compiles clean", async () => {
    const res = await engine.check({
      kind: "project",
      main: "/main.typ",
      files: [
        { path: "/main.typ", text: '#import "/lib.typ": greeting\n#greeting' },
        { path: "/lib.typ", text: '#let greeting = "Hello from the library"' },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.diagnostics.filter((d) => d.severity === "error")).toHaveLength(
      0,
    );
    expect(res.pageCount).toBeGreaterThanOrEqual(1);
  });

  it("#7: resolves image() from a binary file mapped into the VFS, and fails without it", async () => {
    // A real 1×1 PNG — typst's image() decodes it (a stub wouldn't resolve).
    const png = new Uint8Array(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const main = '#set page(width: 3cm, height: 3cm)\n#image("/logo.png")';

    const ok = await engine.check({
      kind: "project",
      main: "/main.typ",
      files: [{ path: "/main.typ", text: main }],
      binaryFiles: [{ path: "/logo.png", bytes: png }],
    });
    expect(ok.ok).toBe(true);
    expect(ok.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(ok.pageCount).toBeGreaterThanOrEqual(1);

    // Without the binary channel the same source can't find the image → error.
    const missing = await engine.check({
      kind: "project",
      main: "/main.typ",
      files: [{ path: "/main.typ", text: main }],
    });
    expect(missing.ok).toBe(false);
    expect(missing.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("routes a diagnostic to the imported file that caused it (carries path)", async () => {
    const res = await engine.check({
      kind: "project",
      main: "/main.typ",
      files: [
        { path: "/main.typ", text: '#import "/lib.typ": x\n#x' },
        { path: "/lib.typ", text: "= ok\n#let x = (" }, // unclosed paren on line 2
      ],
    });
    expect(res.ok).toBe(false);
    const err = res.diagnostics.find((d) => d.severity === "error");
    expect(err).toBeDefined();
    expect(err!.path).toBe("/lib.typ");
    expect(err!.span?.start.line).toBe(2);
  });

  it("renders a multi-file project to SVG", async () => {
    const res = await engine.render({
      kind: "project",
      main: "/main.typ",
      files: [
        {
          path: "/main.typ",
          text: '#import "/content.typ": body\n= Title\n#body',
        },
        { path: "/content.typ", text: "#let body = [Some body text.]" },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.pages[0]!.svg).toContain("<svg");
  });

  it("exports a multi-file project to PDF", async () => {
    const res = await engine.export({
      kind: "project",
      main: "/main.typ",
      files: [
        { path: "/main.typ", text: '#import "/c.typ": b\n#b' },
        { path: "/c.typ", text: "#let b = [PDF body from a second file]" },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.pdf).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(res.pdf!.slice(0, 5))).toBe("%PDF-");
  });

  it("resetShadow() keeps each project compile stale-free", async () => {
    const ok = await engine.check({
      kind: "project",
      main: "/main.typ",
      files: [
        { path: "/main.typ", text: '#import "/lib.typ": x\n#x' },
        { path: "/lib.typ", text: "#let x = [v]" },
      ],
    });
    expect(ok.ok).toBe(true);
    // Recompile WITHOUT /lib.typ — the import must now fail (no stale shadow file).
    const stale = await engine.check({
      kind: "project",
      main: "/main.typ",
      files: [{ path: "/main.typ", text: '#import "/lib.typ": x\n#x' }],
    });
    expect(stale.ok).toBe(false);
  });

  it("normalizes a main path that lacks a leading slash", async () => {
    const res = await engine.check({
      kind: "project",
      main: "main.typ",
      files: [{ path: "main.typ", text: "= Title\nBody." }],
    });
    expect(res.ok).toBe(true);
  });

  it("a broken imported file is reported against that file (per-file routing)", async () => {
    // A syntax error in an imported file surfaces a diagnostic tagged with the
    // imported file's own path (and the import site in main also errors) — so the
    // UI can route the error to the file being edited.
    const res = await engine.check({
      kind: "project",
      main: "/main.typ",
      files: [
        {
          path: "/main.typ",
          text: '#import "/intro.typ": intro\n= Doc\n#intro\n',
        },
        { path: "/intro.typ", text: "#let intro = (" }, // unclosed paren
      ],
    });
    expect(res.ok).toBe(false);
    const errorPaths = res.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => d.path);
    expect(errorPaths).toContain("/intro.typ");
  });

  it("a @preview package import fails CLOSED in the browser compile (no network; ADR-0014)", async () => {
    // The package registry callback is deliberately NOT wired in-browser, so a
    // Universe import cannot reach the network — it fails with a registry error.
    // Real, sandboxed fetching is deferred to server-side compile (roadmap #3).
    const res = await engine.check({
      kind: "project",
      main: "/main.typ",
      files: [
        { path: "/main.typ", text: '#import "@preview/probe:0.1.0": hi\n#hi' },
      ],
    });
    expect(res.ok).toBe(false);
    expect(
      res.diagnostics.some((d) => /package|registry/i.test(d.message)),
    ).toBe(true);
  });

  it("a single-file compile still works after a project compile (no regression)", async () => {
    await engine.check({
      kind: "project",
      main: "/main.typ",
      files: [{ path: "/main.typ", text: "= Project" }],
    });
    const res = await engine.check("= Hello\nplain single-file body");
    expect(res.ok).toBe(true);
    expect(res.diagnostics.filter((d) => d.severity === "error")).toHaveLength(
      0,
    );
  });

  it("a project compile's VFS files do NOT leak into a later single-file compile (ADR-0013)", async () => {
    // First compile a project that defines /lib.typ in the VFS…
    await engine.check({
      kind: "project",
      main: "/main.typ",
      files: [
        { path: "/main.typ", text: '#import "/lib.typ": x\n#x' },
        { path: "/lib.typ", text: "#let x = 1" },
      ],
    });
    // …then a single-file compile importing /lib.typ must FAIL: resetShadow()
    // clears the stale shadow so the file is gone.
    const res = await engine.check('#import "/lib.typ": x\n#x');
    expect(res.ok).toBe(false);
  });
});
