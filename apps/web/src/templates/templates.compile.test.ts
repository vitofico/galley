import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TypstEngine } from "@galley/compiler";
import { DEMO_FILES, DEMO_MAIN } from "../demo/einstein-1905.js";
import { PROJECT_TEMPLATES, findTemplate } from "./index.js";

// Real typst.ts compilation, in Node — the authoritative OFFLINE gate for the
// bundled project templates (#2). Each template is compiled as a multi-file
// `ProjectInput` ({ kind, main, files }) through the SAME WASM the app ships, so
// virtual cross-file `#import`s must resolve and every template MUST check() with
// zero error diagnostics AND render to a non-blank SVG — entirely offline, with
// no `@preview` package resolver. This is the proof the templates compile in the
// fail-closed worker.
//
// Fonts: the gate registers the staged default font set (incl. the NewCMMath
// *math* font) as raw bytes via `fontBlobs`, so real math mode ($...$) resolves
// instead of erroring with "no font could be found". The files are staged into
// apps/web/public/fonts by `scripts/copy-wasm.mjs` (run in the Docker build).
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

function wasmFor(pkg: string, file: string): Uint8Array {
  const entry = require.resolve(pkg);
  return new Uint8Array(readFileSync(join(dirname(entry), file)));
}

/** The staged typst font set (the same files the app serves from /fonts/). */
function loadFontBlobs(): Uint8Array[] {
  const fontsDir = join(__dirname, "..", "..", "public", "fonts");
  let files: string[] = [];
  try {
    files = readdirSync(fontsDir).filter((f) => f.endsWith(".otf") || f.endsWith(".ttf"));
  } catch {
    files = [];
  }
  if (files.length === 0) {
    throw new Error(
      `No fonts in ${fontsDir}. Run \`pnpm --filter @galley/web copy-wasm\` to stage them ` +
        `(the Docker build does this before the suite). Math mode cannot compile without the math font.`,
    );
  }
  return files.map((f) => new Uint8Array(readFileSync(join(fontsDir, f))));
}

// Fail loud if the catalog is empty — a vacuous (zero-`it`) suite would pass as
// a false green.
if (PROJECT_TEMPLATES.length === 0) {
  throw new Error("PROJECT_TEMPLATES is empty — the templates compile gate would be vacuous.");
}

let engine: TypstEngine;

beforeAll(async () => {
  const compilerModule = wasmFor(
    "@myriaddreamin/typst-ts-web-compiler",
    "typst_ts_web_compiler_bg.wasm",
  );
  const rendererModule = wasmFor("@myriaddreamin/typst-ts-renderer", "typst_ts_renderer_bg.wasm");
  engine = await TypstEngine.create({ compilerModule, rendererModule, fontBlobs: loadFontBlobs() });
}, 60_000);

describe("project templates compile gate (#2)", () => {
  // Guard the breadth: the loop below is data-driven, so a dropped template would
  // silently shrink the gate. Pin the full set so the suite fails loud instead.
  it("covers every bundled template id", () => {
    expect(PROJECT_TEMPLATES.map((t) => t.id)).toEqual(
      expect.arrayContaining([
        "einstein-1905",
        "article",
        "letter",
        "report",
        "cv",
        "problem-set",
        "meeting-notes",
      ]),
    );
  });

  // The Einstein encore (#20.3) is NOT re-compiled here: its files/main ARE the
  // demo module's live tree by identity, and einstein-1905.compile.test.ts is
  // the authoritative compile+render gate for exactly that tree. This identity
  // pin is what makes the skip sound — if the template ever stops referencing
  // the demo tree verbatim, this fails loud and the template must rejoin the
  // compile loop below.
  it("einstein-1905 is the demo module's live tree (compiled by the demo gate)", () => {
    const flagship = findTemplate("einstein-1905");
    expect(flagship).toBeDefined();
    expect(flagship!.files).toBe(DEMO_FILES);
    expect(flagship!.main).toBe(DEMO_MAIN);
  });

  // Skip einstein (compiled by its own gate) AND the blank "start from scratch"
  // entry (B8): it intentionally ships zero files, so there is nothing to typeset
  // — its `main` is a placeholder with no backing file. At runtime an empty
  // project compiles to no input (ProjectApp returns null and the preview idles),
  // so feeding the engine a file-less { main, files: [] } here would only assert
  // an irrelevant "access denied". Coherence of the blank entry (last, no files,
  // labelled "Empty project") is pinned in TemplatePicker.test.ts instead.
  for (const template of PROJECT_TEMPLATES.filter(
    (t) => t.id !== "einstein-1905" && t.files.length > 0,
  )) {
    const input = { kind: "project" as const, main: template.main, files: template.files };

    it(`${template.id} compiles offline with zero error diagnostics`, async () => {
      const res = await engine.check(input);
      const errors = res.diagnostics.filter((d) => d.severity === "error");
      // Surface diagnostics in the failure message for the fix agent.
      expect(
        errors,
        errors.map((e) => `L${e.span?.start.line ?? "?"}: ${e.message}`).join("\n"),
      ).toHaveLength(0);
      expect(res.ok).toBe(true);
    });

    it(`${template.id} renders a non-blank SVG with real glyphs`, async () => {
      const res = await engine.render(input);
      expect(res.ok).toBe(true);
      const svg = res.pages[0]?.svg ?? "";
      // A real render draws many glyph/vector paths; a blank or font-less render
      // would not — this asserts actual typesetting, not just a clean check.
      expect(svg).toContain("<path");
      expect(svg.length).toBeGreaterThan(2000);
    });
  }
});
