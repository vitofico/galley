/**
 * CLI for the Universe integrity-manifest builder (build/ops tool, NOT on the
 * request path). Snapshots a curated, version-pinned catalog of `@preview` packages
 * from the configured registry into the `{sha256,size}` manifest the compile service
 * loads via `REGISTRY_INTEGRITY_FILE`.
 *
 *   pnpm --filter @galley/compile build:manifest [catalog.json] [out.json]
 *
 * Config (flags override env override defaults):
 *   - catalog (argv[2] | UNIVERSE_CATALOG | ./universe-catalog.json): a JSON array of
 *     `"@preview/name:version"` strings, or `{ "packages": [...] }`.
 *   - out     (argv[3] | REGISTRY_INTEGRITY_FILE | ./universe-integrity.json).
 *   - base    (REGISTRY_BASE_URL | https://packages.typst.org): the real Universe by
 *     default; https-only (loopback http allowed for the test fixture).
 *
 * Exits non-zero if the catalog is unreadable/empty or if ZERO packages snapshot
 * successfully, so an operator/CI never ships an empty (silently fail-closed)
 * manifest by accident. Per-package failures are printed but don't fail the run as
 * long as at least one package succeeded.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildIntegrityManifest } from "./build-manifest.js";

const DEFAULT_BASE = "https://packages.typst.org";

/** A base URL safe to print: strips any userinfo so a mistyped credential URL isn't logged. */
function safeDisplayUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return "<invalid base URL>";
  }
}

function readCatalog(path: string): string[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { packages?: unknown }).packages)
      ? (parsed as { packages: unknown[] }).packages
      : null;
  if (!list) throw new Error("catalog must be a JSON array of specs or { packages: [...] }");
  return list.map((x) => String(x));
}

async function main(): Promise<number> {
  const catalogPath = process.argv[2] ?? process.env.UNIVERSE_CATALOG ?? "./universe-catalog.json";
  const outPath = process.argv[3] ?? process.env.REGISTRY_INTEGRITY_FILE ?? "./universe-integrity.json";
  const baseUrl = process.env.REGISTRY_BASE_URL?.trim() || DEFAULT_BASE;

  let specs: string[];
  try {
    specs = readCatalog(catalogPath);
  } catch (err) {
    console.error(`[build-manifest] cannot read catalog ${catalogPath}:`, (err as Error).message);
    return 1;
  }
  if (specs.length === 0) {
    console.error(`[build-manifest] catalog ${catalogPath} is empty`);
    return 1;
  }

  console.error(`[build-manifest] snapshotting ${specs.length} pinned package(s) from ${safeDisplayUrl(baseUrl)} …`);
  const { manifest, ok, failed } = await buildIntegrityManifest(specs, { baseUrl });

  for (const f of failed) console.error(`[build-manifest]   SKIP ${f.spec} — ${f.reason}`);
  if (ok.length === 0) {
    console.error("[build-manifest] no packages snapshotted; not writing an empty manifest");
    return 1;
  }

  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");
  console.error(
    `[build-manifest] wrote ${ok.length} package(s) → ${outPath}` +
      (failed.length ? ` (${failed.length} skipped)` : ""),
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error("[build-manifest] failed:", err);
    process.exit(1);
  });
