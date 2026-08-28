/**
 * Pure helpers for the authoring tools (#8 figure, #15 import): turn a generated
 * Typst snippet into an insertion onto the live document, surfaced as a reviewable
 * diff through the EXISTING conflict-aware Accept flow (resolveAccept). No DOM,
 * no React — unit-tested directly (Node-env gate).
 */

/** A whole-source edit block matching the onAccept contract used by the shells. */
export interface SourceBlock {
  search: string;
  replace: string;
}

/**
 * Append a generated snippet to the document with a blank-line separator,
 * trimming the snippet's trailing whitespace and normalizing the join so the
 * result has exactly one blank line between the old body and the new block. An
 * empty snippet leaves the source unchanged; an empty/blank source yields just
 * the snippet (with a trailing newline). Pure.
 */
export function appendSnippet(source: string, snippet: string): string {
  const body = snippet.replace(/\s+$/g, "");
  if (body.length === 0) return source;
  if (source.trim().length === 0) return body + "\n";
  return source.replace(/\s*$/g, "") + "\n\n" + body + "\n";
}

/**
 * A single whole-source edit block (search the ENTIRE base, replace with next).
 * Fed to the shell's conflict-aware `onAccept`: when the live doc still equals
 * `base` it applies directly (resolveAccept fast path); if the user edited during
 * the panel, `base` no longer matches the current source and Accept reports a
 * conflict rather than clobbering. Never an empty search (resolveAccept's fast
 * path handles the empty-base case before this is consulted). Pure.
 */
export function wholeSourceBlock(base: string, next: string): SourceBlock[] {
  return [{ search: base, replace: next }];
}
