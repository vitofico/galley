/**
 * Ambient quick-fix payload builder (roadmap #11.4b) — the PURE CORE only.
 *
 * A diagnostic in the editor should offer a one-click "fix this" that runs the
 * agent SCOPED to that diagnostic's span, surfacing a normal reviewable diff.
 * This module is the pure heart of that feature: given a `Diagnostic` plus the
 * source it points into, it builds a concise, natural-language agent `request`
 * (wrapped in a `QuickFix`) that the coordinator hands to the EXISTING agent
 * run. That run already produces a reviewable diff and already self-corrects
 * against the compiler — so the request just has to be specific about WHICH
 * error to fix and WHERE.
 *
 * CRITICAL invariants (Architect ruling + human-in-the-loop):
 *   - This module NEVER invokes the agent, applies a fix, or auto-fixes.
 *     Accept stays mandatory; it only constructs the payload.
 *   - Pure: no DOM, no network, no React, no extra deps. It depends only on the
 *     `@galley/shared` `Diagnostic` type and plain string work.
 *
 * Offsets in `SourceSpan` are absolute UTF-16 indices (`end` exclusive); we use
 * them to derive the affected line range and slice the offending snippet.
 */

import type { Diagnostic } from "@galley/shared";

/**
 * A scoped, reviewable agent request derived from a single diagnostic.
 *
 *  - `request`         — the natural-language instruction for the agent run.
 *  - `diagnostic`      — the original diagnostic this fix targets (unchanged).
 *  - `contextSnippet`  — the source lines covered by the span, ± surrounding
 *                        context (see `contextLines`), as plain text.
 */
export interface QuickFix {
  request: string;
  diagnostic: Diagnostic;
  contextSnippet: string;
}

const DEFAULT_CONTEXT_LINES = 2;

/**
 * Whether a scoped quick-fix can be built for this diagnostic.
 *
 * PURE. True only when the diagnostic carries a usable `span`: without a span
 * there is no location to scope the agent to, so there is no quick-fix to offer.
 */
export function quickFixAvailable(diagnostic: Diagnostic): boolean {
  return diagnostic.span !== undefined;
}

/**
 * Build a scoped agent request for fixing exactly `diagnostic`.
 *
 * The returned `request` quotes the compiler message, the 1-based line/column of
 * the span's start, any compiler hints, and the offending snippet (the spanned
 * line(s) ± `contextLines` of surrounding context, default 2). It instructs the
 * agent to fix THIS error and keep everything else unchanged.
 *
 * The caller is responsible for only invoking this when `quickFixAvailable` is
 * true; if the diagnostic has no span we fall back to an empty snippet and a
 * location-free request rather than throwing, so the function stays total.
 */
export function quickFixForDiagnostic(
  diagnostic: Diagnostic,
  source: string,
  opts?: { contextLines?: number },
): QuickFix {
  const contextLines = Math.max(0, opts?.contextLines ?? DEFAULT_CONTEXT_LINES);
  const span = diagnostic.span;

  const contextSnippet = span
    ? extractSnippet(source, span.offset, span.endOffset, contextLines)
    : "";

  const location = span
    ? `line ${span.start.line}, column ${span.start.column}`
    : "the reported location";

  const hints =
    diagnostic.hints && diagnostic.hints.length > 0 ? diagnostic.hints : undefined;

  const parts: string[] = [];
  parts.push(
    `Fix the Typst ${diagnostic.severity} "${diagnostic.message}" at ${location}.`,
  );
  if (contextSnippet) {
    parts.push(`The offending code is:\n${contextSnippet}`);
  }
  if (hints) {
    const rendered = hints.map((h) => `- ${h}`).join("\n");
    parts.push(`Compiler hint(s):\n${rendered}`);
  }
  parts.push("Fix only this error. Keep all other content unchanged.");

  return {
    request: parts.join("\n\n"),
    diagnostic,
    contextSnippet,
  };
}

/**
 * Slice the lines of `source` covered by the UTF-16 offset range
 * `[offset, endOffset)`, padded by `contextLines` lines on each side, and
 * return them joined by "\n". `endOffset` is exclusive; if it falls exactly on a
 * line boundary the trailing empty line is not included.
 */
function extractSnippet(
  source: string,
  offset: number,
  endOffset: number,
  contextLines: number,
): string {
  const lines = source.split("\n");
  const startLine = lineIndexAt(source, offset);
  // For the end, step back one char when the range is non-empty so an exclusive
  // end sitting at a line boundary doesn't pull in the following line.
  const endProbe = endOffset > offset ? endOffset - 1 : endOffset;
  const endLine = lineIndexAt(source, endProbe);

  const from = Math.max(0, startLine - contextLines);
  const to = Math.min(lines.length - 1, endLine + contextLines);
  return lines.slice(from, to + 1).join("\n");
}

/**
 * Zero-based index of the line containing UTF-16 `offset` (clamped into range).
 */
function lineIndexAt(source: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 0;
  for (let i = 0; i < clamped; i++) {
    if (source.charCodeAt(i) === 10 /* "\n" */) line++;
  }
  return line;
}
