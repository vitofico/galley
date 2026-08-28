import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TypstEngine } from "@galley/compiler";
import { LOWRY_FILES, LOWRY_MAIN } from "./lowry-1951.js";

// Real typst.ts compilation, in Node — the authoritative OFFLINE gate for the
// Lowry 1951 journal-style demo, mirroring the Einstein demo gate. The seed tree
// is compiled as a multi-file `ProjectInput` through the SAME WASM the app
// ships: the virtual `#include`s, the bespoke two-column `/style.typ`, and the
// `#bibliography("refs.bib")` citations must all resolve, with zero error
// diagnostics AND a non-blank SVG render — entirely offline, no `@preview`
// resolver. Math mode ($A = epsilon b c$, the µg/m µ units) needs the bundled
// NewCMMath font registered via `fontBlobs`; the journal masthead/headings need
// the bundled Inter sans.
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
        `(the Docker build does this before the suite). Math mode + Inter cannot compile without them.`,
    );
  }
  return files.map((f) => new Uint8Array(readFileSync(join(fontsDir, f))));
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

describe("Lowry 1951 demo workspace compile gate", () => {
  const input = { kind: "project" as const, main: LOWRY_MAIN, files: LOWRY_FILES };

  it("compiles offline with zero error diagnostics", async () => {
    const res = await engine.check(input);
    const errors = res.diagnostics.filter((d) => d.severity === "error");
    expect(
      errors,
      errors.map((e) => `L${e.span?.start.line ?? "?"}: ${e.message}`).join("\n"),
    ).toHaveLength(0);
    expect(res.ok).toBe(true);
  }, 30_000);

  it("renders a non-blank SVG with real glyphs", async () => {
    const res = await engine.render(input);
    expect(res.ok).toBe(true);
    const svg = res.pages[0]?.svg ?? "";
    expect(svg).toContain("<path");
    expect(svg.length).toBeGreaterThan(2000);
  }, 30_000);
});

describe("Lowry 1951 demo workspace shape", () => {
  it("seeds the styleable article — main first, then the swappable style", () => {
    expect(LOWRY_FILES.map((f) => f.path)).toEqual([
      "/main.typ",
      "/style.typ",
      "/introduction.typ",
      "/reagents.typ",
      "/procedure.typ",
      "/results.typ",
      "/refs.bib",
    ]);
    expect(LOWRY_FILES.some((f) => f.path === LOWRY_MAIN)).toBe(true);
    // Ships a conforming `/style.typ` so the Style Library can swap it in place
    // (see lowry-styleability.test.ts).
    expect(LOWRY_FILES.some((f) => f.path === "/style.typ")).toBe(true);
  });

  it("stays inside the fail-closed worker: no @preview imports anywhere", () => {
    for (const f of LOWRY_FILES) {
      expect(f.text, `${f.path} must not import @preview packages`).not.toMatch(
        /import\s+"@preview/,
      );
    }
  });

  it("cites only keys that exist in /refs.bib, and every entry is cited", () => {
    const bib = LOWRY_FILES.find((f) => f.path === "/refs.bib")!.text;
    const bibKeys = new Set([...bib.matchAll(/@\w+\{(\w+),/g)].map((m) => m[1]));
    const cited = new Set(
      LOWRY_FILES.filter((f) => f.path.endsWith(".typ")).flatMap((f) =>
        [...f.text.matchAll(/@([a-z]+\d{4})\b/g)].map((m) => m[1]),
      ),
    );
    expect(cited.size).toBeGreaterThan(0);
    for (const key of cited) {
      expect(bibKeys.has(key), `@${key} cited but not in refs.bib`).toBe(true);
    }
    for (const key of bibKeys) {
      expect(cited.has(key), `${key} in refs.bib but never cited`).toBe(true);
    }
  });
});
