/**
 * Package-resolver SEAM (roadmap #2, ADR-0014) — the offline-first foundation for
 * Typst Universe (`@preview/…`) package resolution.
 *
 * The browser compile path is **fail-closed**: typst.ts's package registry
 * callback is deliberately NOT wired, so a `#import "@preview/foo:1.0.0"` fails
 * cleanly with no network access attempted (verified: typst.ts returns a "Dummy
 * Registry" error). REAL, sandboxed fetching of registry artifacts is gated on
 * server-side compile (roadmap #3) and gets its own ADR.
 *
 * What lives here now is the seam a future resolver plugs into, with the security
 * constraints (from a Security-Analyst review) baked in up front so the eventual
 * fetch path can't be coerced into SSRF, path traversal, spoofing, or DoS:
 *   - `PackageSpec` parsing with STRICT ASCII validation (no URLs, no confusables).
 *   - `parsePackageImports`: a ReDoS-safe, bounded scan for `@ns/name:version`.
 *   - `resolvePackagePaths`: normalizes a package's files under its own canonical
 *     VFS root, rejecting traversal/absolute/odd paths and enforcing size caps.
 *   - `PackageResolver` interface + an offline, in-memory `FakeRegistry`.
 */
import type { ProjectFile } from "@galley/shared";

/** A validated Typst package coordinate (`@namespace/name:version`). */
export interface PackageSpec {
  namespace: string;
  name: string;
  version: string;
}

// Strict ASCII grammars. Namespace/name: lowercase alnum + hyphen, ≤63 chars.
// Version: strict 3-part SemVer with an optional prerelease (no build metadata).
const COMPONENT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION_RE = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;

/** The canonical `@ns/name:version` string for a spec. */
export function packageSpecString(spec: PackageSpec): string {
  return `@${spec.namespace}/${spec.name}:${spec.version}`;
}

/**
 * Parse + STRICTLY validate a `@namespace/name:version` string. Returns null for
 * anything malformed — including URLs, uppercase, Unicode, build metadata, or
 * floating versions (`^1`, `latest`) — so a spec can never carry a fetch target
 * or spoof another package.
 */
export function parsePackageSpec(raw: string): PackageSpec | null {
  if (typeof raw !== "string" || raw.length > 256 || raw[0] !== "@") return null;
  const slash = raw.indexOf("/");
  const colon = raw.indexOf(":");
  if (slash < 2 || colon < slash + 2 || colon === raw.length - 1) return null;
  const namespace = raw.slice(1, slash);
  const name = raw.slice(slash + 1, colon);
  const version = raw.slice(colon + 1);
  if (!COMPONENT_RE.test(namespace) || !COMPONENT_RE.test(name) || !VERSION_RE.test(version)) {
    return null;
  }
  return { namespace, name, version };
}

// Bounded, linear scan (no nested quantifiers → ReDoS-safe). We also cap the
// scanned length and the number of returned specs.
const IMPORT_SCAN_RE =
  /@([a-z0-9][a-z0-9-]{0,62})\/([a-z0-9][a-z0-9-]{0,62}):((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?)/g;
const MAX_SCAN_BYTES = 1_000_000;
const MAX_SPECS = 256;

/**
 * Scan Typst source for distinct package coordinates (`@ns/name:version`). Used
 * to learn which packages a project needs (e.g. to display them, or to drive a
 * future resolver). Bounded + ReDoS-safe; deduplicated, order-preserving.
 */
export function parsePackageImports(source: string): PackageSpec[] {
  const text = source.length > MAX_SCAN_BYTES ? source.slice(0, MAX_SCAN_BYTES) : source;
  const out: PackageSpec[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(IMPORT_SCAN_RE)) {
    const spec: PackageSpec = { namespace: m[1]!, name: m[2]!, version: m[3]! };
    const key = packageSpecString(spec);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(spec);
    if (out.length >= MAX_SPECS) break;
  }
  return out;
}

/** Resource caps for a single resolved package (DoS guards). */
export interface PackageLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_PACKAGE_LIMITS: PackageLimits = {
  maxFiles: 64,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
};

export class PackageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageValidationError";
  }
}

// Only the Typst manifest + source/markup files are allowed into the VFS for the
// offline seam — never plugin/WASM binaries or arbitrary assets (a separate,
// explicitly-gated capability if ever needed).
const ALLOWED_EXT = /\.(typ|toml)$/;
const utf8 = new TextEncoder();

/**
 * Validate + normalize a package's files into VFS-absolute paths under the
 * package's OWN canonical root (`/packages/<ns>/<name>/<version>/…`). Rejects:
 * absolute paths, `..`/`.`/empty segments, backslashes, NUL/control chars, URL-
 * like paths, disallowed extensions, duplicates, and anything over the size caps.
 * This is the shared guard `FakeRegistry`, tests, and any future server resolver
 * use, so package files can never escape their namespace or exhaust memory.
 */
export function resolvePackagePaths(
  spec: PackageSpec,
  files: ReadonlyArray<{ path: string; text: string }>,
  limits: PackageLimits = DEFAULT_PACKAGE_LIMITS,
): ProjectFile[] {
  if (files.length > limits.maxFiles) {
    throw new PackageValidationError(
      `package ${packageSpecString(spec)} has ${files.length} files (max ${limits.maxFiles})`,
    );
  }
  const root = `/packages/${spec.namespace}/${spec.name}/${spec.version}`;
  const seen = new Set<string>();
  let total = 0;
  const out: ProjectFile[] = [];
  for (const f of files) {
    const rel = f.path;
    if (typeof rel !== "string" || rel.length === 0) {
      throw new PackageValidationError("package file path must be a non-empty string");
    }
    if (rel.startsWith("/") || rel.includes("\\") || /[\0-\x1f]/.test(rel) || rel.includes(":")) {
      throw new PackageValidationError(`illegal package file path: ${JSON.stringify(rel)}`);
    }
    const segments = rel.split("/");
    if (segments.some((s) => s === "" || s === "." || s === "..")) {
      throw new PackageValidationError(`path traversal/empty segment in: ${JSON.stringify(rel)}`);
    }
    if (!ALLOWED_EXT.test(rel)) {
      throw new PackageValidationError(`disallowed package file type: ${JSON.stringify(rel)}`);
    }
    const bytes = utf8.encode(f.text).length;
    if (bytes > limits.maxFileBytes) {
      throw new PackageValidationError(`package file ${rel} is ${bytes}B (max ${limits.maxFileBytes})`);
    }
    total += bytes;
    if (total > limits.maxTotalBytes) {
      throw new PackageValidationError(
        `package ${packageSpecString(spec)} exceeds ${limits.maxTotalBytes}B total`,
      );
    }
    const abs = `${root}/${rel}`;
    if (seen.has(abs)) {
      throw new PackageValidationError(`duplicate package file: ${abs}`);
    }
    seen.add(abs);
    out.push({ path: abs, text: f.text });
  }
  return out;
}

/**
 * The seam a package source plugs into. Synchronous + in-memory by contract: a
 * resolver returns a package's (already path-normalized) files, or null if it
 * doesn't have it. NO network, NO filesystem, NO URLs — those belong to the
 * deferred, sandboxed server-side fetch path, behind this same shape.
 */
export interface PackageResolver {
  resolve(spec: PackageSpec): ProjectFile[] | null;
}

/**
 * An offline, in-memory `PackageResolver` from a map of `@ns/name:version` →
 * package files. Every entry is validated through `resolvePackagePaths` at
 * construction (fail-fast), so a `FakeRegistry` can only ever hold safe, namespace-
 * scoped files. Used by tests + demos now, and the shape a server resolver reuses.
 */
export class FakeRegistry implements PackageResolver {
  private readonly packages = new Map<string, ProjectFile[]>();

  constructor(
    entries: Record<string, ReadonlyArray<{ path: string; text: string }>> = {},
    limits: PackageLimits = DEFAULT_PACKAGE_LIMITS,
  ) {
    for (const [key, files] of Object.entries(entries)) {
      const spec = parsePackageSpec(key);
      if (!spec) throw new PackageValidationError(`invalid package spec key: ${JSON.stringify(key)}`);
      this.packages.set(packageSpecString(spec), resolvePackagePaths(spec, files, limits));
    }
  }

  resolve(spec: PackageSpec): ProjectFile[] | null {
    return this.packages.get(packageSpecString(spec)) ?? null;
  }
}
