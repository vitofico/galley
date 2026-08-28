import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TypstEngine } from "@galley/compiler";
import { DEMO_FILES, DEMO_MAIN, DEMO_HISTORY } from "./einstein-1905.js";

// Real typst.ts compilation, in Node — the authoritative OFFLINE gate for the
// "Annus Mirabilis" demo workspace (#20.1), mirroring the examples/templates
// compile gates. The LIVE tree and EVERY pre-seeded 1905 history draft are
// compiled as multi-file `ProjectInput`s through the SAME WASM the app ships:
// virtual `#include`s, the cross-file @lightcone figure reference, and the
// `#bibliography("refs.bib")` citations must all resolve, with zero error
// diagnostics AND a non-blank SVG render — entirely offline, no `@preview`
// resolver. A broken demo (live or any draft) is unshippable (spec §8).
//
// Fonts: the gate registers the staged default font set (incl. the NewCMMath
// *math* font) as raw bytes via `fontBlobs`, so real math mode ($...$) —
// E = mc², E = hν, ⟨x²⟩ = 2Dt, the Lorentz factor — resolves instead of
// erroring with "no font could be found". The files are staged into
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

// Fail loud if the history is empty — a vacuous (zero-`it`) loop would pass as
// a false green.
if (DEMO_HISTORY.length === 0) {
  throw new Error("DEMO_HISTORY is empty — the demo compile gate would be vacuous.");
}

/** Compile inputs: the live tree plus each named 1905 draft tree. */
const TREES: { label: string; files: { path: string; text: string }[]; main: string }[] = [
  { label: "live workspace", files: DEMO_FILES, main: DEMO_MAIN },
  ...DEMO_HISTORY.map((v) => ({ label: `draft "${v.name}"`, files: v.tree, main: DEMO_MAIN })),
];

let engine: TypstEngine;

beforeAll(async () => {
  const compilerModule = wasmFor(
    "@myriaddreamin/typst-ts-web-compiler",
    "typst_ts_web_compiler_bg.wasm",
  );
  const rendererModule = wasmFor("@myriaddreamin/typst-ts-renderer", "typst_ts_renderer_bg.wasm");
  engine = await TypstEngine.create({ compilerModule, rendererModule, fontBlobs: loadFontBlobs() });
}, 60_000);

describe("Einstein demo workspace compile gate (#20.1)", () => {
  for (const { label, files, main } of TREES) {
    const input = { kind: "project" as const, main, files };

    it(`${label} compiles offline with zero error diagnostics`, async () => {
      const res = await engine.check(input);
      const errors = res.diagnostics.filter((d) => d.severity === "error");
      // Surface diagnostics in the failure message for the fix agent.
      expect(
        errors,
        errors.map((e) => `L${e.span?.start.line ?? "?"}: ${e.message}`).join("\n"),
      ).toHaveLength(0);
      expect(res.ok).toBe(true);
    }, 30_000);

    it(`${label} renders a non-blank SVG with real glyphs`, async () => {
      const res = await engine.render(input);
      expect(res.ok).toBe(true);
      const svg = res.pages[0]?.svg ?? "";
      // A real render draws many glyph/vector paths; a blank or font-less
      // render would not — this asserts actual typesetting, not just a clean
      // check.
      expect(svg).toContain("<path");
      expect(svg.length).toBeGreaterThan(2000);
    }, 30_000);
  }
});

describe("Einstein demo workspace shape (#20.1)", () => {
  it("seeds the styleable desk of spec §3, main first then the swappable style", () => {
    expect(DEMO_FILES.map((f) => f.path)).toEqual([
      "/main.typ",
      "/style.typ",
      "/photoelectric.typ",
      "/brownian.typ",
      "/relativity.typ",
      "/spacetime.typ",
      "/marginalia.typ",
      "/refs.bib",
    ]);
    expect(DEMO_FILES.some((f) => f.path === DEMO_MAIN)).toBe(true);
    // The live demo ships a conforming `/style.typ` so the Style Library can
    // swap it in place (see einstein-styleability.test.ts).
    expect(DEMO_FILES.some((f) => f.path === "/style.typ")).toBe(true);
  });

  it("tells the year in four named versions, oldest first (spec §4)", () => {
    expect(DEMO_HISTORY.map((v) => v.name)).toEqual([
      "17 March 1905 — On a heuristic viewpoint: light quanta",
      "11 May 1905 — Brownian motion submitted",
      "30 June 1905 — On the electrodynamics of moving bodies",
      "27 September 1905 — Does the inertia of a body depend upon its energy-content?",
    ]);
    // Every draft is a coherent full tree rooted at the same main, with the
    // bibliography along for the cited @keys.
    for (const v of DEMO_HISTORY) {
      const paths = v.tree.map((f) => f.path);
      expect(paths).toContain(DEMO_MAIN);
      expect(paths).toContain("/refs.bib");
    }
  });

  it("compare June ↔ September shows exactly E = mc² appearing", () => {
    const june = DEMO_HISTORY[2]!;
    const september = DEMO_HISTORY[3]!;
    const juneRel = june.tree.find((f) => f.path === "/relativity.typ")!.text;
    const septRel = september.tree.find((f) => f.path === "/relativity.typ")!.text;

    // The June draft leaves the question open; September answers it, first in
    // Einstein's original notation, then restated.
    expect(juneRel).not.toContain("E = m c^2");
    expect(septRel).toContain("m = L / V^2");
    expect(septRel).toContain("E = m c^2");
    // The addendum is appended verbatim — the June text survives unchanged.
    expect(septRel.startsWith(juneRel)).toBe(true);

    // /relativity.typ is the ONLY file that changes between the two versions,
    // so the Version Compare diff is exactly the new section.
    const juneByPath = new Map(june.tree.map((f) => [f.path, f.text]));
    expect(september.tree.map((f) => f.path)).toEqual(june.tree.map((f) => f.path));
    for (const f of september.tree) {
      if (f.path === "/relativity.typ") continue;
      expect(f.text).toBe(juneByPath.get(f.path));
    }
  });

  it("stays inside the fail-closed worker: no @preview imports anywhere", () => {
    for (const f of [...DEMO_FILES, ...DEMO_HISTORY.flatMap((v) => v.tree)]) {
      // Match real package imports (`#import "@preview/..."`), not prose — the
      // header comments legitimately *mention* the constraint.
      expect(f.text, `${f.path} must not import @preview packages`).not.toMatch(
        /import\s+"@preview/,
      );
    }
  });

  it("cites only keys that exist in /refs.bib (live tree)", () => {
    const bib = DEMO_FILES.find((f) => f.path === "/refs.bib")!.text;
    const bibKeys = new Set([...bib.matchAll(/@\w+\{(\w+),/g)].map((m) => m[1]));
    const cited = new Set(
      DEMO_FILES.filter((f) => f.path.endsWith(".typ")).flatMap((f) =>
        [...f.text.matchAll(/@([a-z]+\d{4})\b/g)].map((m) => m[1]),
      ),
    );
    expect(cited.size).toBeGreaterThan(0);
    for (const key of cited) {
      expect(bibKeys.has(key), `@${key} cited but not in refs.bib`).toBe(true);
    }
    // ...and every bibliography entry earns its place by being cited.
    for (const key of bibKeys) {
      expect(cited.has(key), `${key} in refs.bib but never cited`).toBe(true);
    }
  });

  it("the marginalia invite every workbench capability (spec §3)", () => {
    const marginalia = DEMO_FILES.find((f) => f.path === "/marginalia.typ")!.text;
    for (const invitation of [
      "Share",
      "assistant",
      "source",
      "History",
      "Export",
      "Sync",
      "Templates",
    ]) {
      expect(marginalia).toContain(invitation);
    }
  });
});
