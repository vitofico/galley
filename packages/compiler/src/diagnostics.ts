/**
 * Normalize typst.ts diagnostics into the shared `Diagnostic` shape
 * (docs/compiler.md "Diagnostics normalization"). The agent never sees typst.ts
 * internals — only this canonical form.
 *
 * typst.ts (0.7) emits, per diagnostic, `{ severity, message, range, hints? }`
 * where `range` is a 0-based `"line:col-line:col"` string. We turn that into a
 * `SourceSpan` (UTF-16 offsets canonical; 1-based line/col derived) via
 * `SourceMapper`.
 */

import type { Diagnostic, DiagnosticSeverity, SourceSpan } from "@galley/shared";
import { SourceMapper } from "./offset-map.js";

/** The subset of a typst.ts diagnostic we read (shape is a typst.ts detail). */
interface RawTypstDiagnostic {
  severity?: string;
  message?: string;
  range?: string;
  hints?: string[];
  /** The file the diagnostic occurred in (multi-file compiles). */
  path?: string;
  /** Non-empty when the diagnostic comes from a resolved package, not a project file. */
  package?: string;
}

const RANGE_RE = /^(\d+):(\d+)-(\d+):(\d+)$/;

/**
 * typst's image() decodes a fixed set of formats; when handed something else
 * (a PDF, EPS, …) it fails with a terse decode error that never names the
 * accepted formats. These are the well-known typst.ts phrasings for that
 * failure — kept conservative so a benign message is never matched.
 */
const UNSUPPORTED_IMAGE_RE =
  /failed to (parse|decode|read) image|unknown image format|unsupported image|invalid image|failed to load image/i;
const UNSUPPORTED_IMAGE_HINT =
  "Typst's image() supports PNG, JPEG, GIF, and SVG only. PDF, EPS, TIFF, WebP, AVIF and similar are not decodable — convert the asset to PNG or SVG first.";

/**
 * Append a clarifying hint to any diagnostic that looks like a typst image
 * decode failure (e.g. a `.pdf` passed to `image()`), because typst's raw
 * message doesn't say WHICH formats are accepted. Purely additive: the original
 * message is preserved and a non-matching diagnostic is returned unchanged.
 * Pure — returns a NEW object and never mutates its input.
 */
export function enrichImageHint(diag: Diagnostic): Diagnostic {
  if (!UNSUPPORTED_IMAGE_RE.test(diag.message)) return diag;
  if (diag.hints?.includes(UNSUPPORTED_IMAGE_HINT)) return diag;
  return { ...diag, hints: [...(diag.hints ?? []), UNSUPPORTED_IMAGE_HINT] };
}

function toSeverity(s: string | undefined): DiagnosticSeverity {
  return s === "warning" ? "warning" : "error";
}

function spanFromRange(range: string, mapper: SourceMapper): SourceSpan | undefined {
  const m = RANGE_RE.exec(range);
  if (!m) return undefined;
  const startOffset = mapper.offsetAt(Number(m[1]), Number(m[2]));
  const endOffset = mapper.offsetAt(Number(m[3]), Number(m[4]));
  return {
    offset: startOffset,
    endOffset,
    start: mapper.positionAt(startOffset),
    end: mapper.positionAt(endOffset),
  };
}

/** Normalize a raw typst.ts diagnostics array against the source it came from. */
export function normalizeDiagnostics(raw: unknown, source: string): Diagnostic[] {
  if (!Array.isArray(raw)) return [];
  const mapper = new SourceMapper(source);
  const out: Diagnostic[] = [];
  for (const item of raw as RawTypstDiagnostic[]) {
    if (!item || typeof item.message !== "string") continue;
    const span = typeof item.range === "string" ? spanFromRange(item.range, mapper) : undefined;
    const diag: Diagnostic = { severity: toSeverity(item.severity), message: item.message };
    if (span) diag.span = span;
    if (Array.isArray(item.hints) && item.hints.length > 0) diag.hints = item.hints;
    out.push(enrichImageHint(diag));
  }
  return out;
}

/** Project paths are absolute (leading `/`); typst may report them either way. */
function canonicalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * Multi-file sibling of {@link normalizeDiagnostics}. typst.ts tags each
 * diagnostic with the `path` of the file it occurred in, so a single shared
 * `SourceMapper` is wrong — each file's offsets differ. We map every
 * diagnostic's `range` against ITS OWN file's source and tag the result with the
 * (canonical, project-key) `path` so the UI can route it to the right editor.
 *
 * `filesByPath` maps each project file path → its source. A diagnostic whose
 * `path` doesn't resolve to a project file (a missing file, or a diagnostic from
 * a resolved `package`) keeps its message but gets no span — we have no local
 * source to map it against.
 *
 * SourceMappers are built lazily and memoized per file: a clean compile maps
 * nothing, and a file with N diagnostics is scanned once.
 */
export function normalizeProjectDiagnostics(
  raw: unknown,
  filesByPath: Map<string, string>,
): Diagnostic[] {
  if (!Array.isArray(raw)) return [];

  // Index project sources by canonical path so lookup tolerates a missing
  // leading slash, while remembering the caller's original key to echo back.
  const byCanonical = new Map<string, { key: string; source: string }>();
  for (const [key, source] of filesByPath) {
    byCanonical.set(canonicalizePath(key), { key, source });
  }

  const mappers = new Map<string, SourceMapper>();
  const out: Diagnostic[] = [];
  for (const item of raw as RawTypstDiagnostic[]) {
    if (!item || typeof item.message !== "string") continue;

    const reportedPath = typeof item.path === "string" ? item.path : undefined;
    const fromPackage = typeof item.package === "string" && item.package.length > 0;
    // Only resolve a local source for project files (not package files).
    const entry =
      reportedPath && !fromPackage ? byCanonical.get(canonicalizePath(reportedPath)) : undefined;

    let span: SourceSpan | undefined;
    if (entry && typeof item.range === "string") {
      let mapper = mappers.get(entry.key);
      if (!mapper) {
        mapper = new SourceMapper(entry.source);
        mappers.set(entry.key, mapper);
      }
      span = spanFromRange(item.range, mapper);
    }

    const diag: Diagnostic = { severity: toSeverity(item.severity), message: item.message };
    if (span) diag.span = span;
    if (Array.isArray(item.hints) && item.hints.length > 0) diag.hints = item.hints;
    // Echo the project-key path when matched; otherwise surface the canonical
    // reported path so unresolved/package diagnostics still name their origin.
    if (entry) diag.path = entry.key;
    else if (reportedPath) diag.path = canonicalizePath(reportedPath);
    out.push(enrichImageHint(diag));
  }
  return out;
}
