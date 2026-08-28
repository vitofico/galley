import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TypstEngine } from "@galley/compiler";
import { makeStyleable } from "./make-styleable.js";
import { detectStyleability } from "./style-manifest.js";

// Real typst.ts compilation, in Node — the authoritative OFFLINE gate that the
// make-styleable transform produces a TWO-FILE project that actually COMPILES
// (the manifest DoD bar, which the pure detectStyleability self-check can't see:
// it's a static import/show check, not a compile). Mirrors styles.compile.test.ts
// / font-bundling.compile.test.ts: load the two WASM modules + the staged
// fontBlobs, build a TypstEngine, and engine.check() the transformed
// /main.typ + /style.typ. Critically these fixtures have BODIES that reference
// the lifted palette tokens (and a non-canonical helper color), so a transform
// that dropped those bindings would surface as an error diagnostic here.
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

function wasmFor(pkg: string, file: string): Uint8Array {
  return new Uint8Array(readFileSync(join(dirname(require.resolve(pkg)), file)));
}

function loadFontBlobs(): Uint8Array[] {
  const fontsDir = join(__dirname, "..", "public", "fonts");
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

// (A) A doc whose BODY references a LIFTED canonical token (`accent`): a cover
// line `#text(fill: accent)…` before the heading. The transform lifts the
// `#let accent` into /style.typ's palette, so the rewritten main MUST re-import
// `accent` for this body to stay bound. Fully self-contained (no #include).
const BODY_USES_LIFTED_TOKEN = `#set page(margin: 2cm)
#set text(size: 11pt)
#let accent = rgb("#f0510e")

#align(center)[#text(fill: accent, size: 20pt, weight: 700)[Annus Mirabilis]]

= Section One

Body prose, with an #text(fill: accent)[accent] inline span.
`;

// (B) A doc with a NON-canonical helper `#let secondary = …` the body uses. It
// must NOT be lifted into /style.typ (it would be unbound in main); the
// transform keeps it in main ahead of the body so the reference resolves.
const BODY_USES_NONCANONICAL_HELPER = `#set page(margin: 2cm)
#let accent = rgb("#f0510e")
#let secondary = rgb("#123456")

= Heading

A line in #text(fill: secondary)[secondary] and one in #text(fill: accent)[accent].
`;

let engine: TypstEngine;

beforeAll(async () => {
  engine = await TypstEngine.create({
    compilerModule: wasmFor("@myriaddreamin/typst-ts-web-compiler", "typst_ts_web_compiler_bg.wasm"),
    rendererModule: wasmFor("@myriaddreamin/typst-ts-renderer", "typst_ts_renderer_bg.wasm"),
    fontBlobs: loadFontBlobs(),
  });
}, 60_000);

async function checkErrors(mainText: string, styleText: string) {
  const res = await engine.check({
    kind: "project",
    main: "/main.typ",
    files: [
      { path: "/main.typ", text: mainText },
      { path: "/style.typ", text: styleText },
    ],
  });
  return res.diagnostics.filter((d) => d.severity === "error");
}

describe("make-styleable: transformed project trial-compiles offline", () => {
  it("a body that references a LIFTED token compiles with zero errors (token re-imported into main)", async () => {
    const r = makeStyleable({ mainText: BODY_USES_LIFTED_TOKEN });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(["clean", "shimmed"]).toContain(detectStyleability(r.mainText).state);
    // The rewritten main re-imports the palette so `accent` stays bound.
    expect(r.mainText).toContain('#import "/style.typ": doc, accent, ink, ink-soft, rule');
    expect(await checkErrors(r.mainText, r.styleText)).toEqual([]);
  }, 30_000);

  it("a body that references a NON-canonical helper compiles (helper kept in main, not lifted)", async () => {
    const r = makeStyleable({ mainText: BODY_USES_NONCANONICAL_HELPER });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(["clean", "shimmed"]).toContain(detectStyleability(r.mainText).state);
    // The non-canonical #let stayed in main; the canonical one was lifted out.
    expect(r.mainText).toContain('#let secondary = rgb("#123456")');
    expect(r.mainText).not.toContain('#let accent =');
    expect(r.styleText).toContain('#let accent = rgb("#f0510e")');
    expect(await checkErrors(r.mainText, r.styleText)).toEqual([]);
  }, 30_000);
});
