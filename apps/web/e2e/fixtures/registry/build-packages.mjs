/**
 * Hermetic @preview-registry fixture BUILDER (test-only).
 *
 * Builds the tiny, hand-crafted Typst packages this e2e suite needs into
 * deterministic `.tar.gz` artifacts and emits the `{sha256,size}` integrity
 * manifest the compile service requires (ADR-0016: no hash, no fetch). The
 * archives are a STRICT ustar (regular files only, header checksums, fixed
 * mtime/uid/gid) so they parse through `apps/compile/src/package-archive.ts`'s
 * deliberately intolerant reader, and gunzip/decompress within its caps.
 *
 * Two packages, both CRAFTED (never vendored real Universe code):
 *
 *   - `@preview/cetz:0.2.2` — a *stub* exposing JUST the CeTZ surface the
 *     `cetzScaffold` (packages/agent) snippet touches: `cetz.canvas(body)`,
 *     `cetz.draw.{rect,content}`. It is NOT real CeTZ; it draws nothing, it only
 *     lets the generated figure snippet TYPE-CHECK clean so the FigurePanel
 *     server "Verify compile" returns ok=true. This is the package the browser
 *     fails CLOSED on offline.
 *   - `@preview/galleytest:0.1.0` — a one-symbol package an editor snippet can
 *     import + render, to prove the positive package-routing path.
 *
 * SECURITY: this builder + the artifacts + the registry server are TEST-ONLY
 * (under apps/web/e2e/). Nothing here is bundled into the shipped app; the app's
 * package fetch stays OFF unless an operator configures REGISTRY_BASE_URL +
 * REGISTRY_INTEGRITY_FILE, which only the test harness does, pointed at loopback.
 */
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "preview");

const BLOCK = 512;
const enc = new TextEncoder();

/** Write one STRICT-ustar regular-file header + data block(s) into `chunks`. */
function tarFile(chunks, name, text) {
  const data = enc.encode(text);
  const header = new Uint8Array(BLOCK);
  const put = (offset, str, len) => {
    const bytes = enc.encode(str);
    if (bytes.length > len) throw new Error(`field too long: ${str}`);
    header.set(bytes, offset);
  };
  // name[100] — fixture paths are short, so the prefix field stays empty.
  if (enc.encode(name).length > 100) throw new Error(`name too long: ${name}`);
  put(0, name, 100);
  put(100, "0000644", 8); // mode (octal, NUL-terminated by the zero-fill)
  put(108, "0000000", 8); // uid
  put(116, "0000000", 8); // gid
  put(124, data.length.toString(8).padStart(11, "0"), 12); // size (octal)
  put(136, "00000000000", 12); // mtime = 0 (deterministic)
  // checksum field [148,156): spaces during computation, filled in after.
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  header[156] = 0x30; // typeflag '0' = regular file
  put(257, "ustar", 6); // magic "ustar\0"
  put(263, "00", 2); // version "00"
  // Compute + store the checksum: 6 octal digits, NUL, space.
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i];
  const cs = sum.toString(8).padStart(6, "0");
  put(148, cs, 6);
  header[154] = 0; // NUL
  header[155] = 0x20; // space

  chunks.push(header);
  // Data, zero-padded to a 512 boundary.
  const padded = Math.ceil(data.length / BLOCK) * BLOCK;
  const block = new Uint8Array(padded);
  block.set(data, 0);
  chunks.push(block);
}

/** Build a gzipped strict-ustar tarball from `[ {path,text} ]`. */
function buildTarGz(files) {
  const chunks = [];
  for (const f of files) tarFile(chunks, f.path, f.text);
  // Two zero blocks terminate the archive.
  chunks.push(new Uint8Array(BLOCK), new Uint8Array(BLOCK));
  const tarLen = chunks.reduce((n, c) => n + c.length, 0);
  const tar = new Uint8Array(tarLen);
  let off = 0;
  for (const c of chunks) {
    tar.set(c, off);
    off += c.length;
  }
  // Deterministic gzip: fixed level, header mtime defaults to 0 in Node.
  const gz = gzipSync(Buffer.from(tar.buffer, tar.byteOffset, tar.byteLength), { level: 9 });
  return new Uint8Array(gz.buffer, gz.byteOffset, gz.byteLength);
}

// A minimal CeTZ-compatible STUB. Provides only what cetzScaffold imports:
//   #cetz.canvas({ import cetz.draw: *; rect(...); content(...) })
// `canvas` accepts a body (closure) and returns nothing visible; `rect` and
// `content` are no-op draw functions. Enough for the snippet to compile clean.
// The draw submodule: no-op primitives. `import cetz.draw: *` pulls these in.
const CETZ_DRAW = [
  "// CeTZ draw submodule stub (TEST FIXTURE ONLY — not real CeTZ).",
  "#let rect(..args) = none",
  "#let content(..args) = none",
].join("\n") + "\n";

// The entrypoint: re-import `draw.typ` so `cetz.draw` is a module member (that is
// how `import cetz.draw: *` inside the canvas body resolves), and expose `canvas`,
// which simply evaluates its body. Enough surface for cetzScaffold to type-check.
const CETZ_LIB = [
  "// Minimal CeTZ stub (TEST FIXTURE ONLY — not real CeTZ).",
  "// Exposes just the surface cetzScaffold touches so the snippet type-checks.",
  '#import "draw.typ"',
  "#let canvas(body) = { let _ = body; [] }",
].join("\n") + "\n";

// A trivial importable package for the positive package-routing render test.
const GALLEYTEST_LIB = [
  "// galleytest fixture package (TEST ONLY).",
  "#let greet(name) = [Hello, #name — from galleytest!]",
  "#let answer = 42",
].join("\n") + "\n";

const PACKAGES = [
  {
    spec: "@preview/cetz:0.2.2",
    file: "cetz-0.2.2.tar.gz",
    files: [
      {
        path: "typst.toml",
        text: '[package]\nname = "cetz"\nversion = "0.2.2"\nentrypoint = "lib.typ"\n',
      },
      { path: "lib.typ", text: CETZ_LIB },
      { path: "draw.typ", text: CETZ_DRAW },
    ],
  },
  {
    spec: "@preview/galleytest:0.1.0",
    file: "galleytest-0.1.0.tar.gz",
    files: [
      {
        path: "typst.toml",
        text: '[package]\nname = "galleytest"\nversion = "0.1.0"\nentrypoint = "lib.typ"\n',
      },
      { path: "lib.typ", text: GALLEYTEST_LIB },
    ],
  },
];

export function buildAll() {
  const integrity = {};
  const artifacts = {};
  for (const pkg of PACKAGES) {
    const bytes = buildTarGz(pkg.files);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    integrity[pkg.spec] = { sha256, size: bytes.length };
    artifacts[pkg.file] = bytes;
  }
  return { integrity, artifacts };
}

// When invoked directly, (re)materialize the artifacts + manifest on disk.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { integrity, artifacts } = buildAll();
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [file, bytes] of Object.entries(artifacts)) {
    writeFileSync(join(OUT_DIR, file), bytes);
  }
  writeFileSync(join(HERE, "integrity.json"), JSON.stringify(integrity, null, 2) + "\n");
  // eslint-disable-next-line no-console
  console.log("[registry-fixture] wrote", Object.keys(artifacts).join(", "), "+ integrity.json");
}
