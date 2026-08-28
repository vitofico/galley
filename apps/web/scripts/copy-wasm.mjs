// Stage the typst runtime assets into public/ so they are served + bundled
// locally (never fetched from a CDN at runtime). Runs before dev/build.
//
//   - the two WASM modules are COPIED from node_modules (offline, always).
//   - the default text fonts are DOWNLOADED once into public/fonts/. typst.ts
//     0.7 bundles NO fonts in the WASM; without them the compiler lays text out
//     with empty glyphs and the preview renders blank. typst.ts's own default is
//     a CDN fetch, which offline-first forbids — so we stage them at build time
//     (network is available at build, like `pnpm install`) and serve them from
//     /fonts/. Pinned to the typst-assets version matching typst.ts 0.7 (Typst
//     0.13). Both public/*.wasm and public/fonts/ are gitignored + regenerated.
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
mkdirSync(publicDir, { recursive: true });

function copy(pkg, file) {
  const dir = dirname(require.resolve(pkg));
  copyFileSync(join(dir, file), join(publicDir, file));
}

copy("@myriaddreamin/typst-ts-web-compiler", "typst_ts_web_compiler_bg.wasm");
copy("@myriaddreamin/typst-ts-renderer", "typst_ts_renderer_bg.wasm");
console.log("copied typst WASM assets to apps/web/public/");

// The default "text" font set typst.ts loads via `preloadFontAssets({assets:['text']})`.
// Keep this list in sync with typst.ts's internal `_textFonts` for the pinned version.
const FONT_BASE = "https://cdn.jsdelivr.net/gh/typst/typst-assets@v0.13.1/files/fonts/";
const TEXT_FONTS = [
  "DejaVuSansMono-Bold.ttf",
  "DejaVuSansMono-BoldOblique.ttf",
  "DejaVuSansMono-Oblique.ttf",
  "DejaVuSansMono.ttf",
  "LibertinusSerif-Bold.otf",
  "LibertinusSerif-BoldItalic.otf",
  "LibertinusSerif-Italic.otf",
  "LibertinusSerif-Regular.otf",
  "LibertinusSerif-Semibold.otf",
  "LibertinusSerif-SemiboldItalic.otf",
  "NewCM10-Bold.otf",
  "NewCM10-BoldItalic.otf",
  "NewCM10-Italic.otf",
  "NewCM10-Regular.otf",
  "NewCMMath-Bold.otf",
  "NewCMMath-Book.otf",
  "NewCMMath-Regular.otf",
];

// A real open-licensed SANS, so Galley styles can differ by TYPEFACE — not just
// layout + color (Phase 2, Item 4). typst-assets ships NO proportional sans
// (only DejaVu Sans *Mono*), so we stage Inter (SIL OFL 1.1) from a pinned npm
// mirror. Same offline-first contract as the text fonts: fetched once at BUILD
// time (network available, like `pnpm install`), then served locally from
// /fonts/ — never fetched at runtime. The `name`-table family is "Inter", so
// `#set text(font: "Inter")` just works on both compile paths (no aliasing).
const INTER_BASE = "https://cdn.jsdelivr.net/npm/@expo-google-fonts/inter@0.2.3/";
const SANS_FONTS = ["Inter_400Regular.ttf", "Inter_700Bold.ttf"];

const ALL_FONTS = [
  ...TEXT_FONTS.map((file) => ({ file, base: FONT_BASE })),
  ...SANS_FONTS.map((file) => ({ file, base: INTER_BASE })),
];

const fontsDir = join(publicDir, "fonts");
mkdirSync(fontsDir, { recursive: true });

const missing = ALL_FONTS.filter(({ file }) => !existsSync(join(fontsDir, file)));
if (missing.length === 0) {
  console.log(`fonts already present in apps/web/public/fonts/ (${ALL_FONTS.length} files)`);
} else {
  console.log(`downloading ${missing.length} font(s) to apps/web/public/fonts/ …`);
  await Promise.all(
    missing.map(async ({ file, base }) => {
      const res = await fetch(base + file);
      if (!res.ok) throw new Error(`failed to fetch font ${file}: HTTP ${res.status}`);
      writeFileSync(join(fontsDir, file), new Uint8Array(await res.arrayBuffer()));
    }),
  );
  console.log(`downloaded ${missing.length} font(s)`);
}

// --- Font family aliasing -------------------------------------------------
// The typst-assets New Computer Modern faces register their family (name ID 1)
// as the spaceless "NewComputerModern10". Every Typst author — and all of
// Galley's bundled templates/demos — write `#set text(font: "New Computer
// Modern")`, the canonical name. Unaliased, that string resolves to nothing:
// the browser worker silently falls back to another face (wrong typography +
// an "unknown font family" warning) and the font-less server-compile path
// fails outright. Rename the family in-place so the canonical name just works
// on BOTH compile paths, with zero per-document churn.
//
// The rewrite swaps only `name` table records whose nameID === 1 and whose
// value is the source family, with a target of the SAME byte length — so every
// record/string offset is untouched (no table relocation, no directory
// rebuild). Table checksums are not recomputed: ttf-parser (what Typst uses)
// ignores them. Idempotent: already-aliased files have no matching record.
const NAME_TABLE_ID = 0x6e616d65; // 'name'
const FAMILY_NAME_ID = 1;

// Decode/encode a `name` record string. Mac (platform 1) strings are 1-byte
// Mac-Roman; everything else (Windows 3 / Unicode 0) is 2-byte UTF-16BE. We read
// big-endian explicitly (no `subarray().swap16()`, which would mutate the source
// buffer in place) and encode the same way, so the two are exact inverses.
function decodeName(buf, off, length, platformId) {
  if (platformId === 1) return buf.toString("latin1", off, off + length);
  let s = "";
  for (let i = 0; i + 1 < length; i += 2) s += String.fromCharCode(buf.readUInt16BE(off + i));
  return s;
}
function encodeName(str, platformId) {
  if (platformId === 1) return Buffer.from(str, "latin1");
  const b = Buffer.alloc(str.length * 2);
  for (let i = 0; i < str.length; i++) b.writeUInt16BE(str.charCodeAt(i), i * 2);
  return b;
}

/**
 * Rewrite every `name`-table family record equal to `from` into `to`, in place.
 * `from`/`to` MUST be equal-length ASCII (they encode to equal byte counts in
 * both the Mac-Roman 1-byte and the Windows/Unicode UTF-16BE 2-byte schemes), so
 * record/string offsets never move. Returns the number of records rewritten.
 */
function aliasFamilyInPlace(buf, from, to) {
  if (from.length !== to.length) throw new Error(`alias must preserve length: "${from}" → "${to}"`);
  const numTables = buf.readUInt16BE(4);
  let nameOff = -1;
  let nameLen = 0;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (buf.readUInt32BE(rec) === NAME_TABLE_ID) {
      nameOff = buf.readUInt32BE(rec + 8);
      nameLen = buf.readUInt32BE(rec + 12);
      break;
    }
  }
  if (nameOff < 0) return 0;
  const count = buf.readUInt16BE(nameOff + 2);
  const storageOff = nameOff + buf.readUInt16BE(nameOff + 4);
  let rewritten = 0;
  for (let i = 0; i < count; i++) {
    const r = nameOff + 6 + i * 12;
    if (buf.readUInt16BE(r + 6) !== FAMILY_NAME_ID) continue;
    const platformId = buf.readUInt16BE(r);
    const length = buf.readUInt16BE(r + 8);
    const off = storageOff + buf.readUInt16BE(r + 10);
    if (off + length > nameOff + nameLen) continue; // defensive: out-of-table record
    if (decodeName(buf, off, length, platformId) !== from) continue;
    const next = encodeName(to, platformId);
    if (next.length !== length) continue; // length guard (defensive)
    next.copy(buf, off);
    rewritten++;
  }
  return rewritten;
}

const FAMILY_ALIASES = [
  {
    files: ["NewCM10-Bold.otf", "NewCM10-BoldItalic.otf", "NewCM10-Italic.otf", "NewCM10-Regular.otf"],
    from: "NewComputerModern10",
    to: "New Computer Modern",
  },
];

let aliasedFiles = 0;
for (const { files, from, to } of FAMILY_ALIASES) {
  for (const file of files) {
    const path = join(fontsDir, file);
    if (!existsSync(path)) continue;
    const buf = readFileSync(path);
    if (aliasFamilyInPlace(buf, from, to) > 0) {
      writeFileSync(path, buf);
      aliasedFiles++;
    }
  }
}
if (aliasedFiles > 0) {
  console.log(`aliased ${aliasedFiles} font face(s) to "New Computer Modern"`);
}
