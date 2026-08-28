/**
 * Compiler diagnostics — the structured errors/warnings Typst emits.
 *
 * These are the agent's primary feedback signal. The `compiler` package is
 * responsible for normalizing whatever `typst.ts` returns into this shape so
 * that the `agent` package never has to know about typst.ts internals.
 *
 * See docs/compiler.md ("Diagnostics normalization") and docs/agent-loop.md.
 */

export type DiagnosticSeverity = "error" | "warning";

/**
 * A 1-based line/column position in the Typst source.
 * Column is in UTF-16 code units to match the editor (CodeMirror) and JS strings.
 */
export interface SourcePosition {
  line: number;
  column: number;
}

/**
 * A contiguous range in the source. `end` is exclusive.
 * `offset`/`endOffset` are absolute UTF-16 indices into the source string and
 * are the canonical representation; line/column are derived for display.
 */
export interface SourceSpan {
  offset: number;
  endOffset: number;
  start: SourcePosition;
  end: SourcePosition;
}

export interface Diagnostic {
  severity: DiagnosticSeverity;
  /** Human-readable message from the Typst compiler. */
  message: string;
  /**
   * Location of the diagnostic, when the compiler reports one. Some
   * diagnostics (e.g. a missing main file) have no span.
   */
  span?: SourceSpan;
  /** Compiler-provided hints, if any. */
  hints?: string[];
  /**
   * The in-project file path this diagnostic belongs to, for multi-file
   * projects (roadmap #2). Absent for single-file compiles, where every
   * diagnostic is implicitly against the one source. When set, `span`'s offsets
   * are into THAT file's source, not the main file's.
   */
  path?: string;
}
