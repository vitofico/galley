import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TypstEngine } from "@galley/compiler";
import { BUILT_IN_STYLES } from "./index.js";

// Real typst.ts compilation, in Node — the authoritative OFFLINE gate for the
// built-in styles (mirrors templates/templates.compile.test.ts). Each style is
// compiled as the `/style.typ` of a reference conforming doc that exercises the
// canonical ABI (`doc.with(...)`) and every palette token, through the SAME WASM
// the app ships. Every style MUST check() with zero error diagnostics — entirely
// offline, with the staged default font set (incl. NewCMMath) registered as raw
// bytes via `fontBlobs`.
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

function wasmFor(pkg: string, file: string): Uint8Array {
  return new Uint8Array(readFileSync(join(dirname(require.resolve(pkg)), file)));
}

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
        `(the Docker build does this before the suite).`,
    );
  }
  return files.map((f) => new Uint8Array(readFileSync(join(fontsDir, f))));
}

// A reference conforming doc: canonical ABI + every palette token.
const REF_MAIN = `#import "/style.typ": doc, accent, ink, ink-soft, rule
#show: doc.with(title: "Reference", author: "A. Author", date: "2026", abstract: [A short abstract paragraph.])
= Section
Body text with #text(fill: accent)[accent], #text(fill: ink-soft)[soft ink], and a hairline #box(width: 20%, height: 0.7pt, fill: rule).
`;

if (BUILT_IN_STYLES.length === 0) {
  throw new Error("BUILT_IN_STYLES is empty — the styles compile gate would be vacuous.");
}

let engine: TypstEngine;

beforeAll(async () => {
  engine = await TypstEngine.create({
    compilerModule: wasmFor("@myriaddreamin/typst-ts-web-compiler", "typst_ts_web_compiler_bg.wasm"),
    rendererModule: wasmFor("@myriaddreamin/typst-ts-renderer", "typst_ts_renderer_bg.wasm"),
    fontBlobs: loadFontBlobs(),
  });
}, 60_000);

describe("built-in styles compile gate", () => {
  it("covers academic, modern, minimal", () => {
    expect(BUILT_IN_STYLES.map((s) => s.manifest.id)).toEqual(
      expect.arrayContaining(["academic", "modern", "minimal"]),
    );
  });

  for (const style of BUILT_IN_STYLES) {
    it(`compiles ${style.manifest.id} against the reference doc with zero errors`, async () => {
      const styleText = style.files.find((f) => f.path === style.entryFile)!.text;
      const res = await engine.check({
        kind: "project",
        main: "/main.typ",
        files: [
          { path: "/main.typ", text: REF_MAIN },
          { path: "/style.typ", text: styleText },
        ],
      });
      const errors = res.diagnostics.filter((d) => d.severity === "error");
      expect(errors).toEqual([]);
    });
  }
});
