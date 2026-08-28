import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TypstEngine } from "@galley/compiler";

// Font bundling (Phase 2, Item 4). A real open-licensed sans (Inter, OFL-1.1) is
// staged into /fonts/ by copy-wasm alongside the typst defaults, so a style can
// differ by TYPEFACE — not just layout + color — and still compile fully OFFLINE
// (built-in/bundled fonts only, no network). This gate proves the bundled sans is
// actually registered: a document that selects it renders with NO unknown-font
// diagnostic. Without the staged font, typst falls back silently — so the
// absence of that warning is the real proof the face is present.
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

function wasmFor(pkg: string, file: string): Uint8Array {
  return new Uint8Array(readFileSync(join(dirname(require.resolve(pkg)), file)));
}

const fontsDir = join(__dirname, "..", "..", "public", "fonts");
function loadFontBlobs(): Uint8Array[] {
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

/** The bundled sans family name (the registered `name` table family). */
const SANS_FAMILY = "Inter";

/**
 * Read the `name`-table family (nameID 1) of an OTF/TTF. typst resolves
 * `#set text(font: …)` by this family string, so proving the staged file
 * registers `Inter` is the real guarantee the face is the one a style selects
 * (typst falls back SILENTLY on a missing family — no diagnostic — so a render
 * alone can't distinguish the bundled face from a fallback).
 */
function familyName(buf: Buffer): string | null {
  const numTables = buf.readUInt16BE(4);
  let off = -1;
  for (let i = 0; i < numTables; i++) {
    const r = 12 + i * 16;
    if (buf.readUInt32BE(r) === 0x6e616d65) {
      off = buf.readUInt32BE(r + 8);
      break;
    }
  }
  if (off < 0) return null;
  const count = buf.readUInt16BE(off + 2);
  const storage = off + buf.readUInt16BE(off + 4);
  for (let i = 0; i < count; i++) {
    const r = off + 6 + i * 12;
    if (buf.readUInt16BE(r + 6) !== 1) continue; // nameID 1 = family
    const platformId = buf.readUInt16BE(r);
    const len = buf.readUInt16BE(r + 8);
    const o = storage + buf.readUInt16BE(r + 10);
    if (platformId === 1) return buf.toString("latin1", o, o + len);
    let s = "";
    for (let j = 0; j + 1 < len; j += 2) s += String.fromCharCode(buf.readUInt16BE(o + j));
    return s;
  }
  return null;
}

let engine: TypstEngine;
beforeAll(async () => {
  engine = await TypstEngine.create({
    compilerModule: wasmFor("@myriaddreamin/typst-ts-web-compiler", "typst_ts_web_compiler_bg.wasm"),
    rendererModule: wasmFor("@myriaddreamin/typst-ts-renderer", "typst_ts_renderer_bg.wasm"),
    fontBlobs: loadFontBlobs(),
  });
}, 60_000);

describe("bundled sans font (Phase 2 / Item 4)", () => {
  it("stages the Inter Regular + Bold faces into public/fonts", () => {
    expect(existsSync(join(fontsDir, "Inter_400Regular.ttf"))).toBe(true);
    expect(existsSync(join(fontsDir, "Inter_700Bold.ttf"))).toBe(true);
  });

  it("the staged faces register the `Inter` family typst resolves to", () => {
    // Family-name match is how typst binds `#set text(font: "Inter")`; if these
    // ever drift, a style would silently render in a fallback face.
    expect(familyName(readFileSync(join(fontsDir, "Inter_400Regular.ttf")))).toBe(SANS_FAMILY);
    expect(familyName(readFileSync(join(fontsDir, "Inter_700Bold.ttf")))).toBe(SANS_FAMILY);
  });

  it("renders a document set in the bundled sans offline", async () => {
    const main = `#set text(font: "${SANS_FAMILY}")\n= Heading\nThe quick brown fox. *Bold.*`;
    const res = await engine.render(main);
    expect(res.ok).toBe(true);
    expect(res.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(res.pages[0]?.svg.length ?? 0).toBeGreaterThan(0);
  }, 30_000);
});
