import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TypstEngine } from "@galley/compiler";
import { LOWRY_FILES, LOWRY_MAIN } from "./lowry-1951.js";
import { BUILT_IN_STYLES } from "../styles-library/index.js";

// Real typst.ts compilation, in Node — proves the Lowry body survives a REAL
// restyle. The demo ships a bespoke journal `/style.typ`; this gate takes the
// seed tree, REPLACES `/style.typ` with EACH bundled style (academic / modern /
// minimal), and asserts every restyled tree still compiles offline with zero
// error diagnostics. The journal-specific cover args (`journal`/`articletype`/
// `affiliation`/`received`) drop into each generic style's `..extra` sink and
// are ignored; the included body is what must keep compiling.
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

function wasmFor(pkg: string, file: string): Uint8Array {
  const entry = require.resolve(pkg);
  return new Uint8Array(readFileSync(join(dirname(entry), file)));
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

if (BUILT_IN_STYLES.length === 0) {
  throw new Error("BUILT_IN_STYLES is empty — the restyle gate would be vacuous.");
}

function treeWithStyle(styleText: string): { path: string; text: string }[] {
  return LOWRY_FILES.map((f) => (f.path === "/style.typ" ? { ...f, text: styleText } : f));
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

describe("Lowry demo survives a real restyle (journal → built-in styles)", () => {
  for (const style of BUILT_IN_STYLES) {
    const styleText = style.files.find((f) => f.path === style.entryFile)!.text;
    const files = treeWithStyle(styleText);

    it(`restyled with "${style.manifest.id}" compiles offline with zero errors`, async () => {
      const res = await engine.check({ kind: "project", main: LOWRY_MAIN, files });
      const errors = res.diagnostics.filter((d) => d.severity === "error");
      expect(
        errors,
        errors.map((e) => `L${e.span?.start.line ?? "?"}: ${e.message}`).join("\n"),
      ).toHaveLength(0);
      expect(res.ok).toBe(true);
    }, 30_000);
  }
});
