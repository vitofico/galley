/**
 * Compilation contracts.
 *
 * The compiler package distinguishes two operations (see docs/compiler.md):
 *   - check():  compile for diagnostics + page count only. Cheap. Used by the
 *               agent loop on every iteration.
 *   - render(): produce visual output (SVG/canvas) for the live preview.
 *   - export(): produce a PDF for download.
 *
 * Keeping `check` separate from `render` means an agent iteration does not pay
 * for preview rendering it never looks at.
 */

import type { Diagnostic } from "./diagnostics.js";

/**
 * A single file in a multi-file project (roadmap #2). `path` is the in-project
 * virtual path (always absolute, leading `/`, e.g. `/main.typ`,
 * `/chapters/intro.typ`); `text` is its Typst source. Binary assets (images,
 * fonts) are a later extension — the first cut is `.typ`-only.
 */
export interface ProjectFile {
  path: string;
  text: string;
}

/**
 * A binary file in a compile input (#7): raw bytes mapped into typst.ts's virtual
 * filesystem so `image("/path")` resolves. Bytes are resolved from the BlobStore
 * in the app layer before compiling (the CRDT holds only a content-addressed
 * pointer). Text `files` stay the only `#import` targets.
 */
export interface ProjectBinaryFile {
  path: string;
  bytes: Uint8Array;
}

/**
 * A multi-file compile input. The compiler loads every file into typst.ts's
 * virtual filesystem and compiles `main`, so `#import`s between files resolve.
 * `main` must be the `path` of one of `files`.
 *
 * The single-file compile path takes a bare `string`; this is the additive
 * project shape behind the `?project=1` flag. `kind` discriminates the two.
 */
export interface ProjectInput {
  kind: "project";
  files: ProjectFile[];
  main: string;
  /** Binary files (images, …) mapped into the VFS for `image()`. Optional;
   *  absent/empty ⇒ a text-only project, byte-for-byte unchanged. */
  binaryFiles?: ProjectBinaryFile[];
}

/** What the compiler accepts: a bare source string, or a multi-file project. */
export type CompileInput = string | ProjectInput;

/** Type guard: is this compile input a multi-file project? */
export function isProjectInput(input: CompileInput): input is ProjectInput {
  return typeof input !== "string" && input.kind === "project";
}

/**
 * A descriptor of the compiled artifact a successful `check` produced — enough
 * for a tool client to know a build genuinely succeeded and how big its output
 * is, WITHOUT shipping the bytes themselves (those need a transport this seam
 * does not have). `bytes` is the byte length of the compiled output and `hash`
 * its lowercase-hex sha256 (the same content-address scheme as binary assets),
 * so two identical builds report the same hash. `mime` names the artifact form
 * when known (the `check` op emits Typst's vector IR).
 *
 * Optional + additive everywhere: a check that produced no bytes (a failed or
 * empty compile) simply omits it, and every pre-existing CheckResult consumer
 * is byte-for-byte unchanged.
 */
export interface CompileArtifact {
  /** Byte length of the compiled output. */
  bytes: number;
  /** Lowercase-hex sha256 of the compiled output bytes. */
  hash: string;
  /** Media type of the artifact, when known (e.g. the Typst vector IR). */
  mime?: string;
}

/** Result of a diagnostics-only compile (the agent's feedback signal). */
export interface CheckResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  /** Number of pages the document compiled to, when compilation succeeded. */
  pageCount: number | null;
  /** Wall-clock compile time in milliseconds, for telemetry/UX. */
  durationMs: number;
  /**
   * OPTIONAL descriptor of the compiled output (size + sha256), present only
   * when `check` actually produced artifact bytes. Absent on a failed/empty
   * compile and on any result from a service that predates this field — so the
   * shape is backward-compatible (additive).
   */
  artifact?: CompileArtifact;
}

/** The media type the `check` op's compiled artifact takes (Typst vector IR). */
export const TYPST_VECTOR_MIME = "application/x-typst-vector";

/**
 * Build a {@link CompileArtifact} for `bytes`: its byte length + lowercase-hex
 * sha256 (Web Crypto SubtleCrypto, available in the browser and Node 20+) and an
 * optional `mime`. Pure (no I/O beyond hashing); the same bytes always hash to
 * the same descriptor. Used by the compile engine to describe a successful
 * `check`'s output without shipping the bytes.
 */
export async function computeCompileArtifact(
  bytes: Uint8Array,
  mime?: string,
): Promise<CompileArtifact> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto SubtleCrypto is unavailable");
  // Hash a fresh slice so a view into a larger buffer hashes only its own bytes.
  const digest = await subtle.digest("SHA-256", bytes.slice().buffer);
  const view = new Uint8Array(digest);
  let hash = "";
  for (const b of view) hash += b.toString(16).padStart(2, "0");
  return mime === undefined
    ? { bytes: bytes.byteLength, hash }
    : { bytes: bytes.byteLength, hash, mime };
}

/** A rendered preview page as an SVG string. */
export interface RenderedPage {
  index: number;
  /** Page dimensions in points (1/72 inch), as Typst reports them. */
  widthPt: number;
  heightPt: number;
  svg: string;
}

/**
 * A 1-based line / 0-based column source position, as Typst's `getAst` reports
 * range endpoints (`<line:col~line:col>`). This is deliberately a distinct,
 * minimal shape from the diagnostics' `SourcePosition` (1-based column): the
 * preview source map is built directly from AST ranges and consumed by the
 * editor, which speaks CodeMirror's 1-based-line / 0-based-column coordinates.
 */
export interface SourceLineCol {
  /** 1-based line. */
  line: number;
  /** 0-based column (UTF-16 code units, matching CodeMirror). */
  column: number;
}

/** A bounding box in document (page-stack) space, in Typst points (1/72in). */
export interface PreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One entry of the forward source→preview index (#11.3): a source range that
 * maps to a rendered region. `page` is the 0-based page index the region lives
 * on; `rect` is its bounding box in document space (the same coordinate space as
 * the rendered `<svg>` viewBox), so a consumer can scroll/outline it.
 */
export interface PreviewSourceEntry {
  /** Inclusive start of the source range (1-based line, 0-based column). */
  start: SourceLineCol;
  /** Exclusive end of the source range. */
  end: SourceLineCol;
  /** 0-based page index the region renders onto. */
  page: number;
  /** Region bounding box in document space (Typst points). */
  rect: PreviewRect;
  /**
   * OPTIONAL in-project virtual path of the file this source range belongs to
   * (always absolute, leading `/`, matching {@link ProjectFile.path}), enabling
   * reverse navigation across files (B14): a click on rendered content from an
   * `#import`ed file resolves to a position in THAT file, not just the active one.
   *
   * Present only when the source map was built from a multi-file project (the
   * engine stamps each entry with the file its AST leaf came from). ABSENT for
   * single-file source maps and any pre-existing map — consumers MUST treat an
   * absent `filePath` as "the currently active file" so the prior behavior is
   * preserved byte-for-byte (additive, fully backward-compatible).
   */
  filePath?: string;
}

/**
 * Forward source→preview index (#11.3). Built best-effort at render time from
 * the AST source ranges + the rendered SVG transform tree (E4 spike,
 * docs/research/span-svg-mapping.md). Entries are ordered by source position so
 * a cursor lookup is a simple containment/nearest search. Always best-effort:
 * when the index can't be built it is simply absent from the render result and
 * the preview behaves exactly as before.
 */
export interface PreviewSourceMap {
  entries: PreviewSourceEntry[];
  /** Document-space size of each page, parallel to the rendered pages. */
  pages: { widthPt: number; heightPt: number }[];
}

export interface RenderResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  pages: RenderedPage[];
  /**
   * The document's REAL page count. The current render path returns ONE
   * combined `<svg>` entry in `pages` (typst renders all pages into a single
   * SVG), so `pages.length` is NOT the page count of a multi-page document.
   * Consumers surfacing "N page(s)" must read this field and only fall back to
   * `pages.length` when it is absent (results from a compile service that
   * predates the field). Set on every successful local render.
   */
  pageCount?: number;
  durationMs: number;
  /**
   * OPTIONAL forward source→preview index (#11.3, opt-in). Present only when the
   * engine was asked to build it AND it could be derived cheaply; absent on every
   * default render so the result shape is byte-for-byte unchanged otherwise.
   */
  sourceMap?: PreviewSourceMap;
}

/** Result of a PDF export. */
export interface ExportResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  /** The PDF bytes, when successful. */
  pdf: Uint8Array | null;
}

/**
 * Server-side compile wire contract (roadmap #3, ADR-0015). The browser can run
 * the compiler either in its Web Worker (default) or against an optional
 * `apps/compile` HTTP service; both satisfy the same `Compiler` interface. These
 * types are the JSON request/response that cross that HTTP seam.
 */
export type CompileOp = "check" | "render" | "export";

/** POST body for the compile service: one operation over one `CompileInput`. */
export interface CompileServiceRequest {
  op: CompileOp;
  input: CompileInput;
}

/**
 * Wire form of `ExportResult`: PDF bytes are base64-encoded so the response is
 * plain JSON. `check`/`render` results are already JSON-safe and travel as-is.
 */
export interface ExportResultWire {
  ok: boolean;
  diagnostics: Diagnostic[];
  pdfBase64: string | null;
}
