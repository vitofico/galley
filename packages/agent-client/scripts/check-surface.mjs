#!/usr/bin/env node
/**
 * Exhaustive public-surface parity check.
 *
 * The shipped `surface/agent-client.d.ts` is hand-maintained; this guards it
 * against `src/index.ts` drifting out from under it. `src/surface-contract.ts`
 * already checks every export's SHAPE at `tsc` time, but a type-level check
 * cannot enumerate a module's type-only exports — so it can't notice a NEWLY
 * ADDED type export. This does, via the TypeScript compiler API: it compares the
 * exact SET of export names and their KIND (value / type) between the two
 * modules and fails loudly on any difference.
 *
 * Run standalone (`node scripts/check-surface.mjs`) or imported by bundle.mjs.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
/** @type {typeof import("typescript")} */
const ts = require("typescript");

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(PKG_DIR, "src", "index.ts");
const SURFACE = path.join(PKG_DIR, "surface", "agent-client.d.ts");

/** Load the package's own compiler options (resolves `extends`). */
function loadCompilerOptions() {
  const configPath = path.join(PKG_DIR, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, PKG_DIR);
  return parsed.options;
}

/**
 * The exported names of `moduleFile`, each tagged with whether it is exported in
 * value space, type space, or both. Aliased re-exports (`export { x } from …`)
 * are resolved to their target so a re-export is classified by what it actually is.
 * @returns {Map<string, { value: boolean, type: boolean }>}
 */
function exportsOf(program, checker, moduleFile) {
  const source = program.getSourceFile(moduleFile);
  if (!source) throw new Error(`could not load ${moduleFile}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`no module symbol for ${moduleFile}`);
  const out = new Map();
  for (const exp of checker.getExportsOfModule(moduleSymbol)) {
    const target =
      exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
    out.set(exp.getName(), {
      value: (target.flags & ts.SymbolFlags.Value) !== 0,
      type: (target.flags & ts.SymbolFlags.Type) !== 0,
    });
  }
  return out;
}

/** @returns {string[]} human-readable differences (empty when the surfaces match). */
export function surfaceDiff() {
  const program = ts.createProgram([ENTRY, SURFACE], loadCompilerOptions());
  const checker = program.getTypeChecker();
  const real = exportsOf(program, checker, ENTRY);
  const pinned = exportsOf(program, checker, SURFACE);

  const kind = (k) =>
    k.value && k.type ? "value+type" : k.value ? "value" : "type";
  const diffs = [];
  for (const [name, k] of real) {
    if (!pinned.has(name)) {
      diffs.push(`missing from surface: ${name} (${kind(k)})`);
    } else {
      const pk = pinned.get(name);
      if (pk.value !== k.value || pk.type !== k.type) {
        diffs.push(
          `kind mismatch for ${name}: index=${kind(k)} surface=${kind(pk)}`,
        );
      }
    }
  }
  for (const name of pinned.keys()) {
    if (!real.has(name)) diffs.push(`extra in surface: ${name}`);
  }
  return diffs.sort();
}

/** Throw with a loud, actionable message if the surface drifts. */
export function assertSurfaceInSync() {
  const diffs = surfaceDiff();
  if (diffs.length > 0) {
    throw new Error(
      "agent-client public surface drift — surface/agent-client.d.ts is out of " +
        "sync with src/index.ts:\n  - " +
        diffs.join("\n  - ") +
        "\nUpdate surface/agent-client.d.ts to match (and src/surface-contract.ts " +
        "if you added/removed an export).",
    );
  }
}

// Run directly: `node scripts/check-surface.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    assertSurfaceInSync();
    process.stdout.write("agent-client surface: in sync with src/index.ts\n");
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
