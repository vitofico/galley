/**
 * Universe integrity-manifest BUILDER (roadmap #2/#3 — closes the "real Universe
 * catalog/integrity" deferral). The compile service resolves `@preview/…` packages
 * ONLY against an operator-supplied `{sha256,size}` manifest (ADR-0016: no hash, no
 * fetch) — but the real Typst Universe index (https://packages.typst.org) ships
 * neither a hash nor a size. This module bridges that gap WITHOUT weakening the
 * fail-closed posture: given a curated, version-PINNED list of specs, it fetches
 * each real artifact through the SAME audited network edge + hardened archive
 * reader the runtime uses, then records the hash it observed.
 *
 * A built entry is therefore a *verified snapshot*: its `{sha256,size}` is the hash
 * of bytes that actually fetched, decompressed within caps, parsed as a strict
 * ustar, AND passed ADR-0014 `resolvePackagePaths` — i.e. a package the runtime
 * will be able to resolve. Anything that fails any of those steps is OMITTED from
 * the manifest (recorded in `failed`), never silently hashed-as-garbage. The
 * operator pins what they trust; nothing here trusts the whole index.
 *
 * This is a build/ops tool (not on the request path). It is the ONLY place that
 * computes a package hash from the network; the runtime only ever VERIFIES one.
 */
import {
  packageSpecString,
  parsePackageSpec,
  resolvePackagePaths,
  type PackageSpec,
} from "@galley/compiler";
import {
  DEFAULT_ARCHIVE_LIMITS,
  gunzipWithCap,
  sha256Hex,
  untarStrict,
  type ArchiveLimits,
} from "./package-archive.js";
import {
  fetchRegistryArtifact,
  type ArtifactFetchOptions,
  type IntegrityEntry,
  type IntegrityManifest,
} from "./registry-resolver.js";

export interface BuildManifestOptions extends ArtifactFetchOptions {
  maxDecompressedBytes?: number;
  archiveLimits?: ArchiveLimits;
  /** Max distinct packages built per run (DoS / accidental whole-index guard). */
  maxPackages?: number;
}

/** One package that could not be snapshotted, with a generic, non-leaky reason. */
export interface FailedSpec {
  spec: string;
  reason: string;
}

export interface BuildManifestResult {
  /** The `{ "@ns/name:version": {sha256,size} }` manifest of verified packages. */
  manifest: IntegrityManifest;
  /** Specs that were snapshotted, in first-seen order. */
  ok: string[];
  /** Specs that were skipped/failed (invalid, fetch/verify/extract error). */
  failed: FailedSpec[];
}

const DEFAULT_MAX_DECOMPRESSED = 8 * 1024 * 1024;
const DEFAULT_MAX_PACKAGES = 256;

/**
 * Fetch + verify ONE pinned spec and return its integrity entry. Mirrors the
 * runtime resolution path (fetch → cap → gunzip → strict untar → resolvePackagePaths)
 * but COMPUTES the hash instead of checking it. Throws on any failure; the caller
 * turns that into an omission.
 */
async function snapshotOne(spec: PackageSpec, options: BuildManifestOptions): Promise<IntegrityEntry> {
  const bytes = await fetchRegistryArtifact(spec, options);
  // Prove the artifact is actually usable BEFORE we bless its hash: it must
  // decompress within the cap, parse as a strict ustar, and pass ADR-0014's
  // re-root/traversal/extension/size validation — exactly what the runtime does.
  const tar = await gunzipWithCap(bytes, options.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED);
  const files = untarStrict(tar, options.archiveLimits ?? DEFAULT_ARCHIVE_LIMITS);
  resolvePackagePaths(spec, files); // throws → omit
  return { sha256: sha256Hex(bytes), size: bytes.length };
}

/**
 * Build an integrity manifest for a curated list of `@preview/name:version` specs
 * by snapshotting each from the (real) configured registry. Invalid specs and any
 * that fail to fetch/verify/extract are omitted from `manifest` and reported in
 * `failed`. Deduplicated, first-seen order, count-capped. Never throws for a single
 * bad package — only the whole run can fail (e.g. an unsafe base URL surfaces per
 * package as a failed entry).
 */
export async function buildIntegrityManifest(
  specStrings: readonly string[],
  options: BuildManifestOptions,
): Promise<BuildManifestResult> {
  const manifest: IntegrityManifest = {};
  const ok: string[] = [];
  const failed: FailedSpec[] = [];
  const seen = new Set<string>();
  const cap = options.maxPackages ?? DEFAULT_MAX_PACKAGES;

  for (const raw of specStrings) {
    if (ok.length + failed.length >= cap) {
      failed.push({ spec: String(raw), reason: `skipped: exceeds maxPackages (${cap})` });
      continue;
    }
    const spec = parsePackageSpec(typeof raw === "string" ? raw.trim() : "");
    if (!spec) {
      failed.push({ spec: String(raw), reason: "invalid or unpinned spec" });
      continue;
    }
    const key = packageSpecString(spec);
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      manifest[key] = await snapshotOne(spec, options);
      ok.push(key);
    } catch (err) {
      failed.push({ spec: key, reason: err instanceof Error ? err.message : "fetch/verify failed" });
    }
  }

  return { manifest, ok, failed };
}
