/**
 * Selection-scoped revise payload builders (roadmap 11.8b) — the PURE CORE.
 *
 * The user selects a region of text in the editor and asks the agent to revise
 * THAT region ("make this shorter", etc.). Like the #11.4b quick-fix, this
 * module never invokes the agent, applies an edit, or auto-applies anything: it
 * only constructs the natural-language `request` the coordinator hands to the
 * EXISTING agent run, which already produces a reviewable diff the human must
 * Accept. The Accept gate stays mandatory.
 *
 * Two PURE pieces (no DOM, no React, no deps):
 *   - `composeReviseRequest` — build the scoped request from a selected region,
 *     its 1-based line range, and the user's instruction. The region is quoted
 *     inside a code fence sized to be longer than any backtick run it contains,
 *     so Typst syntax (incl. ``` fences) in the selection cannot be confused
 *     with the instruction text.
 *   - `selectionFromEditor` — derive `{ from, to, text, startLine, endLine }`
 *     from a CodeMirror-like `{ doc, selection }` snapshot, keeping ProjectApp
 *     thin and the line math unit-testable without a live `EditorView`.
 */

/** The inputs for a selection-scoped revise request. */
export interface ReviseRequestInput {
  /** The exact selected source text (verbatim). */
  selectedText: string;
  /** 1-based line of the selection's first character. */
  startLine: number;
  /** 1-based line of the selection's last character. */
  endLine: number;
  /** The user's natural-language instruction (e.g. "make this shorter"). */
  instruction: string;
}

/**
 * Build a scoped agent request that revises ONLY the selected region.
 *
 * The returned string carries the user's instruction, names the affected 1-based
 * line range (singular vs plural wording), and quotes the region inside a fence
 * sized longer than any backtick run inside it. It instructs the agent to revise
 * only that region and leave the rest of the document unchanged; the agent still
 * edits via full-file search/replace and the result still flows through the
 * normal diff/Accept gate.
 *
 * Total: an empty instruction (the caller guards, but be defensive) still yields
 * a usable, region-scoped request rather than throwing.
 */
export function composeReviseRequest(input: ReviseRequestInput): string {
  const instruction = input.instruction.trim();
  const range =
    input.startLine === input.endLine
      ? `line ${input.startLine}`
      : `lines ${input.startLine}-${input.endLine}`;

  const fenced = fenceRegion(input.selectedText);

  const parts: string[] = [];
  parts.push(
    instruction
      ? `Revise the selected region (${range}) of the document: ${instruction}.`
      : `Revise the selected region (${range}) of the document.`,
  );
  parts.push(`The selected region is exactly:\n${fenced}`);
  parts.push(
    "Revise ONLY that region. Keep the rest of the document byte-for-byte unchanged, " +
      "and do not alter anything outside the selected lines.",
  );

  return parts.join("\n\n");
}

/**
 * Wrap `region` in a code fence whose backtick run is strictly longer than the
 * longest backtick run inside the region, so an inner ``` (e.g. a Typst raw
 * block) cannot terminate the fence early. Minimum fence length is 3.
 */
function fenceRegion(region: string): string {
  let longest = 0;
  for (const run of region.match(/`+/g) ?? []) {
    if (run.length > longest) longest = run.length;
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${region}\n${fence}`;
}

/** A resolved, non-empty selection ready to scope a revise request. */
export interface ResolvedSelection {
  /** UTF-16 start offset (inclusive), normalized so `from <= to`. */
  from: number;
  /** UTF-16 end offset (exclusive), normalized so `from <= to`. */
  to: number;
  /** The selected text (`doc.sliceString(from, to)`). */
  text: string;
  /** 1-based line of `from`. */
  startLine: number;
  /** 1-based line of the selection's last character. */
  endLine: number;
}

/** The minimal CodeMirror `EditorState`-like shape this helper reads. */
export interface EditorStateLike {
  doc: {
    sliceString: (from: number, to: number) => string;
    lineAt: (offset: number) => { number: number };
  };
  selection: { main: { from: number; to: number } };
}

/**
 * PURE: derive a {@link ResolvedSelection} from a CodeMirror-like state snapshot,
 * or `null` when the selection is empty (collapsed). A reversed selection
 * (anchor after head) is normalized so `from <= to`. The end line is computed
 * from the last selected character (`to - 1`) so a selection ending exactly at a
 * line boundary doesn't claim the following line.
 */
export function selectionFromEditor(state: EditorStateLike): ResolvedSelection | null {
  const main = state.selection.main;
  const from = Math.min(main.from, main.to);
  const to = Math.max(main.from, main.to);
  if (to <= from) return null;

  const text = state.doc.sliceString(from, to);
  const startLine = state.doc.lineAt(from).number;
  const endLine = state.doc.lineAt(to - 1).number;
  return { from, to, text, startLine, endLine };
}
