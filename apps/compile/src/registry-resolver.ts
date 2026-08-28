/**
 * Registry fetch + prewarm (roadmap #3 slice 5b, ADR-0016) — the network edge that
 * obtains a Typst Universe package and feeds the slice-5a security core. Because
 * typst.ts's package callback is SYNCHRONOUS, the flow is: scan a project's imports
 * → ASYNC `prewarmRegistry` (fetch + verify + extract each needed package into an
 * in-memory, ADR-0014-validated `FakeRegistry`) → compile with that synchronous
 * resolver.
 *
 * Security posture (Security-Analyst review, ADR-0016): the URL is built ONLY from
 * a validated `PackageSpec` + a fixed configured host (https, or http loopback for
 * the offline test fixture; no userinfo); redirects are rejected; the compressed
 * body is capped; an expected `{sha256,size}` is REQUIRED (fail closed when
 * absent); decompression is capped; the archive is parsed strictly; per-package
 * failures are omitted (the package simply won't resolve → compile fails closed);
 * errors are generic. Real fetching is opt-in (off until an operator configures a
 * base URL + integrity manifest).
 */
import {
  FakeRegistry,
  packageSpecString,
  parsePackageSpec,
  resolvePackagePaths,
  type PackageResolver,
  type PackageSpec,
} from "@galley/compiler";
import {
  DEFAULT_ARCHIVE_LIMITS,
  gunzipWithCap,
  untarStrict,
  verifyIntegrity,
  type ArchiveLimits,
} from "./package-archive.js";
import { isBlockedRegistryHost } from "./registry-host-guard.js";

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

/** Expected artifact integrity for one package (operator-supplied manifest). */
export interface IntegrityEntry {
  sha256: string;
  size: number;
}
/** `@ns/name:version` → expected integrity. A spec absent here cannot be fetched. */
export type IntegrityManifest = Record<string, IntegrityEntry>;

export interface RegistryFetchOptions {
  /** Fixed registry base URL (operator config); never derived from user input. */
  baseUrl: string;
  /** Required integrity manifest — a missing entry fails the fetch closed. */
  integrity: IntegrityManifest;
  /** Injected fetch (tests pass a fake / local fixture); defaults to global. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxCompressedBytes?: number;
  maxDecompressedBytes?: number;
  archiveLimits?: ArchiveLimits;
}

const DEFAULTS = {
  timeoutMs: 15_000,
  maxCompressedBytes: 4 * 1024 * 1024,
  maxDecompressedBytes: 8 * 1024 * 1024,
};

/** Validate the operator's base URL: https, or http loopback (test fixture). No userinfo. */
function assertSafeBase(baseUrl: string): void {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new RegistryError("invalid registry base URL");
  }
  if (u.username || u.password) throw new RegistryError("registry base URL must not contain credentials");
  // SSRF defense-in-depth (#22.2): a link-local / cloud-metadata destination is
  // NEVER a legitimate registry — refuse it regardless of scheme (a metadata IP
  // over https is still a metadata IP). Applied before the scheme split so it also
  // covers an https metadata base. Loopback / RFC1918 are intentionally NOT blocked
  // here (see registry-host-guard.ts); the DNS-rebind residual is an infra concern.
  if (isBlockedRegistryHost(u.hostname)) {
    throw new RegistryError("registry base URL host is not allowed");
  }
  if (u.protocol === "https:") return;
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  if (u.protocol === "http:" && loopback) return;
  throw new RegistryError("registry base URL must be https (http allowed only for loopback)");
}

/** Network-edge options shared by the runtime fetch and the manifest builder. */
export interface ArtifactFetchOptions {
  /** Fixed registry base URL (operator config); never derived from user input. */
  baseUrl: string;
  /** Injected fetch (tests pass a fake / local fixture); defaults to global. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxCompressedBytes?: number;
}

/**
 * The audited network edge: fetch ONE package's RAW `.tar.gz` bytes and nothing
 * more (no hashing, no decompress). The URL is built ONLY from the validated spec
 * (`@preview/<name>-<version>.tar.gz`) + the fixed configured base; redirects are
 * rejected (`redirect:"manual"` → only an exact 200 passes), the compressed body
 * is size-capped, and the request is abort-timed. Shared so the runtime resolver
 * (which verifies a KNOWN hash) and the manifest builder (which COMPUTES the hash)
 * traverse one identical, security-reviewed path. Throws `RegistryError` on any
 * network/transport failure — every caller fails closed.
 */
export async function fetchRegistryArtifact(
  spec: PackageSpec,
  options: ArtifactFetchOptions,
): Promise<Uint8Array> {
  if (spec.namespace !== "preview") throw new RegistryError("only the @preview namespace is supported");
  // Defense in depth at the URL-construction site: the spec must round-trip through
  // the strict parser, so `name`/`version` can carry no path/scheme/traversal even
  // if a caller hands this exported function an unvalidated PackageSpec.
  if (!parsePackageSpec(packageSpecString(spec))) throw new RegistryError("invalid package spec");
  assertSafeBase(options.baseUrl);

  const maxCompressed = options.maxCompressedBytes ?? DEFAULTS.maxCompressedBytes;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/preview/${spec.name}-${spec.version}.tar.gz`;
  const doFetch = options.fetch ?? fetch;
  const controller = new AbortController();
  // ONE deadline covers both the response headers AND the body read, so a
  // slow-drip body can't outlast the timeout (clearing it before arrayBuffer()
  // would leave the body read unbounded).
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULTS.timeoutMs);
  try {
    const res = await doFetch(url, { redirect: "manual", signal: controller.signal });
    // redirect:"manual" surfaces a 3xx as the response; only an exact 200 is allowed.
    if (res.status !== 200) throw new RegistryError("package fetch failed");
    // Reject an over-cap body up front when the server declares its length…
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxCompressed) {
      throw new RegistryError("compressed package too large");
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    // …and again after reading, in case Content-Length was absent or lied.
    if (bytes.length > maxCompressed) throw new RegistryError("compressed package too large");
    return bytes;
  } catch (err) {
    if (err instanceof RegistryError) throw err; // preserve specific reasons (e.g. "too large")
    throw new RegistryError("package fetch failed"); // network/abort/transport → generic
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch, integrity-verify, decompress, and strictly extract ONE package's files.
 * Returns raw `{path,text}` (still re-validated by `resolvePackagePaths` later).
 * Throws `RegistryError`/`ArchiveError` on any failure — the caller fails closed.
 */
export async function fetchPackageFiles(
  spec: PackageSpec,
  options: RegistryFetchOptions,
): Promise<Array<{ path: string; text: string }>> {
  // Namespace BEFORE the integrity lookup so a non-preview spec reports as such
  // (it would ALSO miss the manifest, but the namespace reason is the precise one).
  if (spec.namespace !== "preview") throw new RegistryError("only the @preview namespace is supported");
  const expected = options.integrity[packageSpecString(spec)];
  if (!expected) throw new RegistryError("no integrity entry for package"); // fail closed

  const bytes = await fetchRegistryArtifact(spec, options);
  verifyIntegrity(bytes, expected); // throws on size/hash mismatch
  const tar = await gunzipWithCap(bytes, options.maxDecompressedBytes ?? DEFAULTS.maxDecompressedBytes);
  return untarStrict(tar, options.archiveLimits ?? DEFAULT_ARCHIVE_LIMITS);
}

export interface PrewarmOptions extends RegistryFetchOptions {
  /** Max distinct packages fetched per request (DoS guard). */
  maxPackages?: number;
}

const DEFAULT_MAX_PACKAGES = 64;

/**
 * Fetch every requested spec and build a SYNCHRONOUS `PackageResolver` (a
 * `FakeRegistry`, which re-validates each package through `resolvePackagePaths`).
 * A package that fails to fetch/verify/validate is **omitted** — it simply won't
 * resolve, so the compile fails closed for imports of it (never a partial/poisoned
 * cache). Order-stable, deduplicated, count-capped.
 */
export async function prewarmRegistry(
  specs: PackageSpec[],
  options: PrewarmOptions,
): Promise<PackageResolver> {
  const seen = new Set<string>();
  const unique: PackageSpec[] = [];
  for (const spec of specs) {
    const key = packageSpecString(spec);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(spec);
    if (unique.length >= (options.maxPackages ?? DEFAULT_MAX_PACKAGES)) break;
  }

  const entries: Record<string, Array<{ path: string; text: string }>> = {};
  for (const spec of unique) {
    try {
      const files = await fetchPackageFiles(spec, options);
      resolvePackagePaths(spec, files); // validate (extension/traversal/caps) — throws → omit
      entries[packageSpecString(spec)] = files;
    } catch {
      // Fail closed for this package: leave it out of the resolver.
    }
  }
  return new FakeRegistry(entries);
}
