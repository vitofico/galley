#!/usr/bin/env node
/**
 * Release/bundle script for @galley/agent-client.
 *
 * galley packages are source-exported TypeScript with `workspace:*` deps, so a
 * private consumer (galley-cloud) can't just `npm pack` this — it would drag in
 * unpublished `@galley/*` sources. This produces ONE reviewed, self-contained
 * artifact set the consumer can vendor:
 *
 *   agent-client.mjs   — esbuild bundle of src/index.ts. `@galley/collab` and
 *                        `@galley/shared` are INLINED; the public npm deps
 *                        (yjs, y-protocols, lib0, ws — and their subpaths) stay
 *                        EXTERNAL so the consumer installs them itself.
 *   agent-client.d.ts  — the hand-maintained, self-contained public surface
 *                        (surface/agent-client.d.ts), copied verbatim. Two loud
 *                        gates run FIRST so it can never ship out of sync with
 *                        src/index.ts: the `tsc` shape contract
 *                        (src/surface-contract.ts) and the exhaustive name+kind
 *                        parity check (scripts/check-surface.mjs).
 *   manifest.json      — provenance: galley commit, sha256 of the bundle, the
 *                        exact external versions from the lockfile, and the
 *                        esbuild command/version used.
 *
 * After emitting, a smoke test imports the real .mjs (externals resolved from the
 * workspace) and asserts the public value exports exist. That runs HERE, at
 * bundle time — the artifact is gitignored, so it never enters the repo suite.
 *
 * Usage: node scripts/bundle.mjs [--outdir <dir>]   (default: ./bundle-dist)
 */
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";
import { assertSurfaceInSync } from "./check-surface.mjs";

const require = createRequire(import.meta.url);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(SCRIPT_DIR, "..");
const WORKSPACE_DIR = path.resolve(PKG_DIR, "..", "..");
const ENTRY = path.join(PKG_DIR, "src", "index.ts");
const SURFACE_DTS = path.join(PKG_DIR, "surface", "agent-client.d.ts");
const DEFAULT_OUTDIR = path.join(PKG_DIR, "bundle-dist");

/** Public npm deps left external — inlining CRDT libraries would bloat + fork them. */
const EXTERNAL_BASE = ["yjs", "y-protocols", "lib0", "ws"];
/** Cover both the package root and every subpath import (e.g. `lib0/encoding`). */
const EXTERNAL = EXTERNAL_BASE.flatMap((p) => [p, `${p}/*`]);

const BUNDLE_NAME = "agent-client.mjs";
const TYPES_NAME = "agent-client.d.ts";

function log(msg) {
  process.stdout.write(`bundle: ${msg}\n`);
}

function parseOutdir(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--outdir") {
      const v = argv[i + 1];
      if (!v) throw new Error("--outdir requires a path argument");
      return path.resolve(process.cwd(), v);
    }
    if (a.startsWith("--outdir=")) {
      return path.resolve(process.cwd(), a.slice("--outdir=".length));
    }
  }
  return DEFAULT_OUTDIR;
}

function git(args) {
  return execFileSync("git", args, { cwd: PKG_DIR, encoding: "utf8" }).trim();
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * The specifier (from package.json) and the exact RESOLVED version (from the
 * agent-client importer block of pnpm-lock.yaml) for each external. Fails loudly
 * if the lockfile lacks a required external — a stale lockfile must not silently
 * produce a manifest that lies about what the bundle links against.
 */
function externalVersions() {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf8"),
  );
  const lines = fs
    .readFileSync(path.join(WORKSPACE_DIR, "pnpm-lock.yaml"), "utf8")
    .split("\n");
  const start = lines.indexOf("  packages/agent-client:");
  if (start < 0) {
    throw new Error("pnpm-lock.yaml: 'packages/agent-client' importer not found");
  }
  // The importer block runs until the next top-level (2-space-indented) key.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const block = lines.slice(start, end);

  const out = {};
  for (const name of EXTERNAL_BASE) {
    const keyIdx = block.indexOf(`      ${name}:`);
    if (keyIdx < 0) {
      throw new Error(
        `pnpm-lock.yaml: external '${name}' missing from agent-client dependencies`,
      );
    }
    const versionLine = block
      .slice(keyIdx + 1, keyIdx + 4)
      .find((l) => /^ {8}version:/.test(l));
    if (!versionLine) {
      throw new Error(`pnpm-lock.yaml: no resolved version for '${name}'`);
    }
    // Strip any `(peer@x)` suffix pnpm appends to a peer-resolved version.
    const version = versionLine
      .replace(/^ {8}version:\s*/, "")
      .replace(/\(.*\)\s*$/, "")
      .trim();
    out[name] = {
      specifier: pkg.dependencies?.[name] ?? "(unspecified)",
      version,
    };
  }
  return out;
}

/**
 * Both drift gates. The surface .d.ts is hand-maintained, so it MUST be proven
 * in lockstep with src/index.ts before it can ship.
 */
function runDriftGates() {
  log("gate 1/2 — tsc shape contract (src/surface-contract.ts)…");
  try {
    execFileSync(
      process.execPath,
      [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.json", "--noEmit"],
      { cwd: PKG_DIR, encoding: "utf8", stdio: "pipe" },
    );
  } catch (err) {
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    throw new Error(
      `surface shape contract failed (src/index.ts drifted from the shipped ` +
        `surface, or the package does not type-check):\n${out}`,
    );
  }
  log("gate 2/2 — exhaustive export name+kind parity (check-surface)…");
  assertSurfaceInSync();
  log("surface is in lockstep with src/index.ts");
}

async function buildBundle(outfile) {
  const result = await esbuild.build({
    entryPoints: [ENTRY],
    outfile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    external: EXTERNAL,
    sourcemap: false,
    legalComments: "none",
    metafile: true,
    logLevel: "warning",
    // Pin the base for the per-module `// path` comments esbuild embeds so the
    // bundle is byte-identical (stable sha256) no matter which directory the
    // script is invoked from — the manifest's hash must be reproducible.
    absWorkingDir: WORKSPACE_DIR,
  });

  // Guard: the only bare (non-relative) imports left in the bundle must be the
  // declared externals. Anything else means a dep silently leaked out of the
  // inline set (or a new external appeared) — fail rather than ship a bundle the
  // manifest doesn't describe.
  const code = fs.readFileSync(outfile, "utf8");
  const bareSpecifiers = [
    ...code.matchAll(/(?:^|[\s{,])from\s*"([^".][^"]*)"/g),
  ]
    .map((m) => m[1])
    .filter((s) => !s.startsWith("."));
  const stray = bareSpecifiers.filter((s) => {
    const base = s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0];
    return !EXTERNAL_BASE.includes(base);
  });
  if (stray.length > 0) {
    throw new Error(
      `bundle contains unexpected external imports (not inlined, not declared ` +
        `external): ${[...new Set(stray)].join(", ")}`,
    );
  }
  if (code.includes("@galley/")) {
    throw new Error("bundle still references '@galley/*' — inlining incomplete");
  }
  return result;
}

/** Import the emitted .mjs and assert the public value exports are intact. */
async function smokeTest(outfile) {
  // Import a COPY placed inside the package's node_modules so the bundle's
  // external `import "yjs"` / `import "ws"` etc. resolve against the workspace.
  const smokeDir = path.join(
    PKG_DIR,
    "node_modules",
    ".agent-client-bundle-smoke",
  );
  fs.rmSync(smokeDir, { recursive: true, force: true });
  fs.mkdirSync(smokeDir, { recursive: true });
  const copy = path.join(smokeDir, BUNDLE_NAME);
  fs.copyFileSync(outfile, copy);
  try {
    const mod = await import(pathToFileURL(copy).href);

    const check = (cond, what) => {
      if (!cond) throw new Error(`smoke test: ${what}`);
    };
    check(
      typeof mod.connectDraftPublisher === "function",
      "connectDraftPublisher is not a function",
    );
    check(
      mod.DRAFT_PUBLISHER_RUN_ID === "draft-publisher",
      "DRAFT_PUBLISHER_RUN_ID is wrong",
    );
    check(
      typeof mod.PROPOSAL_LIMITS?.maxRequestChars === "number",
      "PROPOSAL_LIMITS missing",
    );
    check(
      typeof mod.FILE_PROPOSAL_LIMITS?.maxOps === "number",
      "FILE_PROPOSAL_LIMITS missing",
    );
    check(mod.RUN_ID_MAX_LEN === 128, "RUN_ID_MAX_LEN is wrong");

    // The runtime (value) exports must be EXACTLY the package's value surface —
    // no more (a leaked internal), no less (a missing export).
    const actual = Object.keys(mod).sort();
    const expected = [
      "DRAFT_PUBLISHER_RUN_ID",
      "FILE_PROPOSAL_LIMITS",
      "PROPOSAL_LIMITS",
      "RUN_ID_MAX_LEN",
      "connectDraftPublisher",
    ].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `smoke test: value exports differ.\n  expected: ${expected.join(", ")}` +
          `\n  actual:   ${actual.join(", ")}`,
      );
    }
  } finally {
    fs.rmSync(smokeDir, { recursive: true, force: true });
  }
}

async function main() {
  const outdir = parseOutdir(process.argv.slice(2));
  const outfile = path.join(outdir, BUNDLE_NAME);

  runDriftGates();

  fs.mkdirSync(outdir, { recursive: true });
  log(`bundling ${path.relative(WORKSPACE_DIR, ENTRY)} → ${outfile}`);
  await buildBundle(outfile);

  log(`writing types ${TYPES_NAME}`);
  fs.copyFileSync(SURFACE_DTS, path.join(outdir, TYPES_NAME));

  const bundleBytes = fs.readFileSync(outfile);
  const typesBytes = fs.readFileSync(path.join(outdir, TYPES_NAME));
  const relativeOutdir = path.relative(PKG_DIR, outdir) || ".";
  const manifest = {
    package: "@galley/agent-client",
    packagePath: path.relative(WORKSPACE_DIR, PKG_DIR),
    galleyCommit: git(["rev-parse", "HEAD"]),
    entry: path.relative(WORKSPACE_DIR, ENTRY),
    surface: path.relative(WORKSPACE_DIR, SURFACE_DTS),
    artifacts: {
      bundle: BUNDLE_NAME,
      types: TYPES_NAME,
    },
    bundleSha256: sha256(bundleBytes),
    typesSha256: sha256(typesBytes),
    externals: externalVersions(),
    build: {
      bundler: "esbuild",
      esbuildVersion: esbuild.version,
      command: `node scripts/bundle.mjs --outdir ${relativeOutdir}`,
      esbuild: {
        platform: "node",
        target: "node20",
        format: "esm",
        bundle: true,
        external: EXTERNAL,
      },
    },
  };
  fs.writeFileSync(
    path.join(outdir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  log("smoke-testing the emitted bundle…");
  await smokeTest(outfile);

  log(
    `done — ${BUNDLE_NAME} (${bundleBytes.length} bytes, sha256 ` +
      `${manifest.bundleSha256.slice(0, 12)}…), ${TYPES_NAME}, manifest.json`,
  );
  log(`output: ${outdir}`);
}

main().catch((err) => {
  process.stderr.write(
    `bundle FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
