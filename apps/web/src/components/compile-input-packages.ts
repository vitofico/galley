/**
 * PURE detection of Typst Universe (`@preview/…`) package imports in a compile
 * input (Wave-2 Lane A, roadmap #2/E2).
 *
 * WHY THIS EXISTS: the in-browser worker compiler is FAIL-CLOSED for Universe
 * packages — its package-registry callback is deliberately unwired (ADR-0014),
 * so a `#import "@preview/foo:1.0.0"` cannot resolve client-side (no network).
 * The server-side compile service (apps/compile) CAN resolve them. This module
 * answers the single routing question — "does this document import Universe
 * packages?" — so the compile-mode policy can decide whether the document needs
 * the server path. It makes NO routing/egress decision itself; that lives in
 * `compiler-mode.ts`, and egress only ever happens under explicit trusted config.
 *
 * BROWSER-SAFE BY CONSTRUCTION: this file imports only the `CompileInput` *type*
 * from `@galley/shared` (erased at build) and re-implements the tiny import-scan
 * regex locally. It deliberately does NOT import `@galley/compiler`'s runtime
 * `parsePackageImports`, to avoid pulling the compiler barrel (and any heavier
 * transitive code) into the web bundle. The regex below mirrors the spirit of
 * `packages/compiler/src/package-resolver.ts`'s scan — same ReDoS-safe, linear,
 * bounded approach — but is narrowed to the `preview` namespace (the only one
 * that maps to network-resolved Universe packages) and is INTENTIONALLY STRICTER:
 * it adds a trailing version boundary so a valid prefix inside an invalid spec
 * (`1.0.0+build`, `1.0.0alpha`) does NOT count. We deliberately do NOT claim
 * byte-for-byte parity with the upstream regex, and never edit it from here.
 *
 * PURE: no React, no DOM, no storage, no network. Importing it has ZERO side
 * effects. Fully offline-unit-testable.
 */

import type { CompileInput } from "@galley/shared";

/**
 * Cap on how much of each source we scan. Mirrors the compiler's `MAX_SCAN_BYTES`
 * so detection here can never be more permissive (or more expensive) than the
 * real resolver. A document larger than this is scanned only up to the cap — a
 * package import past 1MB of leading text is vanishingly unlikely and not worth
 * an unbounded scan.
 */
const MAX_SCAN_CHARS = 1_000_000;

/**
 * Cap on the number of distinct specifiers {@link listPackageImports} returns, so
 * a hostile document full of fake imports cannot make the list unbounded. Mirrors
 * the compiler's `MAX_SPECS`.
 */
const MAX_SPECS = 256;

/**
 * Linear, ReDoS-safe scan for a `@preview/<name>:<version>` coordinate. No nested
 * quantifiers. `name` is lowercase-alnum+hyphen (≤63); `version` is strict 3-part
 * SemVer with an optional prerelease (no build metadata).
 *
 * The trailing `(?![0-9A-Za-z.+-])` boundary is LOAD-BEARING: without it the
 * grammar matches a valid *prefix* inside an INVALID spec — e.g. `1.0.0` inside
 * `1.0.0+build`, `1.0.0alpha`, or `1.0.0.1` — which would false-positively flag
 * the document as importing a Universe package and (in `auto` + trusted-server)
 * route it to the server for nothing (unnecessary egress). The boundary forces
 * the version to be terminated by a non-version char (the closing `"`, a space,
 * EOF, …), so only specs the resolver could actually accept count as imports.
 * The boundary is a zero-width lookahead → still linear, still ReDoS-safe.
 */
const PREVIEW_IMPORT_RE =
  /@preview\/([a-z0-9][a-z0-9-]{0,62}):((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?)(?![0-9A-Za-z.+-])/g;

/**
 * The same grammar (including the trailing-boundary lookahead) WITHOUT the `/g`
 * flag or capture groups, for a stateless boolean `.test`. Kept separate from
 * {@link PREVIEW_IMPORT_RE} because `.test` on a `/g` regex mutates its
 * `lastIndex`, which would make repeated detector calls non-deterministic.
 */
const PREVIEW_IMPORT_TEST_RE =
  /@preview\/[a-z0-9][a-z0-9-]{0,62}:(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?![0-9A-Za-z.+-])/;

/** Every string source in a compile input: the bare string, or each project file. */
function sourcesOf(input: CompileInput): string[] {
  if (typeof input === "string") return [input];
  // ProjectInput — scan every file's text (an `@preview` import anywhere in the
  // project needs the server, not just in `main`).
  return input.files.map((f) => f.text);
}

/**
 * The distinct `@preview/<name>:<version>` specifiers imported anywhere in the
 * input (deduplicated, order-preserving). PURE + offline. Capped at
 * {@link MAX_SPECS}. Useful for displaying which packages forced the server path;
 * the routing policy only needs {@link compileInputImportsPackages}.
 */
export function listPackageImports(input: CompileInput): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of sourcesOf(input)) {
    const text = raw.length > MAX_SCAN_CHARS ? raw.slice(0, MAX_SCAN_CHARS) : raw;
    // Fresh lastIndex per source: matchAll on a /g regex literal is self-contained.
    for (const m of text.matchAll(PREVIEW_IMPORT_RE)) {
      const spec = `@preview/${m[1]!}:${m[2]!}`;
      if (seen.has(spec)) continue;
      seen.add(spec);
      out.push(spec);
      if (out.length >= MAX_SPECS) return out;
    }
  }
  return out;
}

/**
 * True when the input imports at least one Typst Universe (`@preview/…`) package
 * — i.e. it CANNOT compile in the fail-closed browser worker and needs the
 * server compile path (when one is trusted-configured). PURE + offline.
 *
 * Short-circuits on the first match rather than collecting the full list, so the
 * common no-package case stays O(scan) and the hit case stops early.
 */
export function compileInputImportsPackages(input: CompileInput): boolean {
  for (const raw of sourcesOf(input)) {
    const text = raw.length > MAX_SCAN_CHARS ? raw.slice(0, MAX_SCAN_CHARS) : raw;
    // Non-global `.test` (PREVIEW_IMPORT_TEST_RE) → stateless, no `lastIndex` leak.
    if (PREVIEW_IMPORT_TEST_RE.test(text)) return true;
  }
  return false;
}
