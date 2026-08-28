import type { Diagnostic } from "@galley/shared";

/**
 * Shell-side adapter for the cross-reference broken-ref lint (#13 follow-up).
 *
 * The agent-core label scanner (`buildLabelIndex`) is deliberately lexical: it
 * reads `@name` anywhere, stopping the name at the first non-name char. Typst
 * package specs are written `@preview/cetz:0.2.2` — but `/` is not a label-name
 * char, so the scanner sees the ref `@preview` and `crossFileRefDiagnostics`
 * then flags it as an "unknown reference". That is a FALSE POSITIVE: `@preview`
 * inside an `#import "@preview/…"` is a package path, never a cross-reference.
 *
 * The agent-core documents this as upstream-composition's job (it stays a pure
 * lexer and must not change here). So we filter at the shell wiring: drop any
 * broken-ref diagnostic whose ref token is immediately followed by `/` in the
 * source — i.e. the `@namespace/…` package form. A real cross-reference never
 * has a `/` directly after the name (the name already consumed every name char),
 * so this is precise and additive.
 *
 * PURE: a deterministic filter over `(source, diagnostics)`; no I/O, no DOM.
 */
export function dropPackagePathRefs(
  source: string,
  diagnostics: Diagnostic[],
): Diagnostic[] {
  return diagnostics.filter((d) => {
    // Only the broken cross-ref warnings carry an end-of-token offset to probe;
    // anything else (compiler diags, spanless) passes through untouched.
    const end = d.span?.endOffset;
    if (end === undefined) return true;
    return source[end] !== "/";
  });
}
