/**
 * Pure, framework-free document-stats helpers for the stats + outline panel
 * (roadmap #12.7). No React, no DOM, no @galley/* imports — this file is safe
 * to unit-test in isolation and is the single home for all counting/parsing
 * logic so that <DocStatusBar> and <DocOutline> can stay thin presentational
 * shells.
 *
 * Counting rules (chosen for predictability, documented so callers can rely on
 * them):
 *   - A "word" is one maximal run of non-whitespace characters. Punctuation is
 *     part of the adjacent word (so "It's" is one word). This matches the
 *     everyday "wc -w"-style expectation for prose.
 *   - "chars" counts Unicode code points (via the string iterator), so an
 *     astral character such as an emoji counts as one, not two. This is the
 *     human-facing notion of "characters".
 *
 * NOTE on offsets: heading offsets are absolute UTF-16 unit indices (the units
 * CodeMirror / String.prototype.slice use), so `onJump(offset)` can be handed
 * straight to an editor's selection/scroll API.
 */

/** Number of maximal non-whitespace runs. Empty/whitespace-only → 0. */
export function countWords(text: string): number {
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}

/** Number of Unicode code points. Empty → 0. */
export function countChars(text: string): number {
  // The string iterator yields code points, so astral chars count once.
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/**
 * Estimated reading time in whole minutes, rounded up. 0 words → 0 minutes;
 * any positive word count is at least 1 minute. Default 200 wpm.
 */
export function readingTimeMinutes(words: number, wpm = 200): number {
  if (words <= 0 || wpm <= 0) return 0;
  return Math.ceil(words / wpm);
}

/** A Typst heading discovered by {@link parseHeadings}. */
export interface Heading {
  /** Heading depth = number of leading '=' (1 = top level). */
  level: number;
  /** Title text after the '=' run, trimmed. */
  title: string;
  /** Absolute UTF-16 offset of the heading's first '=' in the source. */
  offset: number;
  /** 1-based line number of the heading. */
  line: number;
}

/**
 * Scan Typst source for headings. A Typst heading is a line that begins (at
 * column 0, no leading whitespace) with one or more '=' followed by at least
 * one whitespace character and a title, e.g. `== Aim`.
 *
 * This is a deliberately tiny, self-contained scan — it does NOT import the
 * frozen @galley/agent chunker (out of scope and a barrel-only export). A local
 * line walk is correct and fully disjoint.
 *
 * Handles LF and CRLF line endings. Offsets are UTF-16 units.
 */
export function parseHeadings(source: string): Heading[] {
  const headings: Heading[] = [];
  // Match a run of '=' (group 1) at line start, then required whitespace, then
  // the rest of the line as the title. `m` makes ^/$ line-anchored; we use the
  // match index for the absolute UTF-16 offset.
  const re = /^(=+)[ \t]+(.*?)[ \t]*\r?$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const offset = m.index;
    const level = (m[1] ?? "").length;
    const title = (m[2] ?? "").trim();
    // 1-based line = count of newlines before the offset, + 1.
    let line = 1;
    for (let i = 0; i < offset; i++) {
      if (source.charCodeAt(i) === 10 /* \n */) line++;
    }
    headings.push({ level, title, offset, line });
  }
  return headings;
}

/** Counts returned by {@link countFiguresAndTables}. */
export interface FigureTableCounts {
  /** Figures that are NOT tables — a `#figure(...)` wrapping an image/equation/etc. */
  figures: number;
  /** Tables — a `#figure(...)` wrapping a `table(...)`, or a standalone `table(...)`. */
  tables: number;
}

/**
 * Replace the interior of Typst comments and string literals with spaces while
 * preserving length and all other characters. This lets the figure/table scan
 * ignore a `table(` that lives in prose-comments, block comments, or a quoted
 * string, and keeps paren-matching from tripping over a `)` inside a string.
 *
 * `//` only starts a comment when it isn't part of `://` (so a bare `https://`
 * URL doesn't blank the rest of its line). String escapes (`\"`) are honored.
 */
function maskCommentsAndStrings(s: string): string {
  const out = s.split("");
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    const next = i + 1 < n ? s[i + 1] : "";
    // Line comment — but not the `//` inside a `://` (URLs).
    if (c === "/" && next === "/" && s[i - 1] !== ":") {
      while (i < n && s[i] !== "\n") out[i++] = " ";
      continue;
    }
    // Block comment.
    if (c === "/" && next === "*") {
      out[i++] = " ";
      out[i++] = " ";
      while (i < n && !(s[i] === "*" && s[i + 1] === "/")) {
        if (s[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < n) {
        out[i++] = " ";
        out[i++] = " ";
      }
      continue;
    }
    // String literal.
    if (c === '"') {
      out[i++] = " ";
      while (i < n && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < n) {
          out[i++] = " ";
          out[i++] = " ";
          continue;
        }
        if (s[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < n) out[i++] = " "; // closing quote
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Index of the `)` that matches the `(` at `open`, or `s.length` if unbalanced. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return s.length;
}

/** Index of each `(` that opens a `name(` call, using a hyphen/underscore-aware
 *  left boundary so `subfigure(`, `mytable(`, and `table.header(` don't match. */
function callParenIndices(masked: string, name: string): number[] {
  const re = new RegExp(`(?<![A-Za-z0-9_-])${name}\\s*\\(`, "g");
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) out.push(m.index + m[0].length - 1);
  return out;
}

/**
 * Count the document's figures and tables the way Typst NUMBERS them, from a
 * pure lexical scan of the source (no compiler):
 *
 *   - A `#figure(...)` whose body contains a `table(...)` is numbered "Table N"
 *     by Typst's auto kind-detection, so it counts as ONE table — the inner
 *     table is absorbed, never double-counted.
 *   - A `#figure(...)` with no table inside (an image, equation, …) counts as
 *     one figure.
 *   - A `table(...)` not inside any figure counts as one table.
 *
 * Comments and string literals are masked first (see {@link maskCommentsAndStrings})
 * so a `figure(`/`table(` in prose, a comment, or a string is never counted.
 */
export function countFiguresAndTables(source: string): FigureTableCounts {
  const masked = maskCommentsAndStrings(source);
  const figureParens = callParenIndices(masked, "figure");
  const tableParens = callParenIndices(masked, "table");

  // Balanced [open, close] span for each figure call (strings/comments already
  // masked, so a quoted paren can't skew the depth count).
  const figureSpans = figureParens.map((open) => ({ open, close: matchParen(masked, open) }));
  const inSomeFigure = (idx: number) =>
    figureSpans.some((sp) => idx > sp.open && idx < sp.close);

  let figures = 0;
  let tables = 0;
  for (const sp of figureSpans) {
    const wrapsTable = tableParens.some((t) => t > sp.open && t < sp.close);
    if (wrapsTable) tables++;
    else figures++;
  }
  for (const t of tableParens) {
    if (!inSomeFigure(t)) tables++;
  }
  return { figures, tables };
}
