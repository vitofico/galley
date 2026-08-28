/**
 * Roadmap #15.1 — Markdown → Typst core (the import wedge). PURE, offline,
 * framework-free, deterministic.
 *
 * This is a hand-rolled line/inline scanner in the house style (see labels.ts /
 * citation.ts) — NOT a markdown library. It maps the common CommonMark-ish subset
 * to Typst source and, crucially, is HONEST about what it cannot map: any
 * construct we choose not to fully support is passed through best-effort AND
 * recorded as an `UnmappedConstruct` so the importer can surface the loss rather
 * than silently dropping content.
 *
 * Scope (deliberately small and deterministic):
 *   - ATX headings `#`..`######`         → `=`..`======`
 *   - `**bold**` / `__bold__`            → `*bold*`
 *   - `*em*` / `_em_`                    → `_em_`
 *   - inline `` `code` ``                → Typst raw `` `code` `` (verbatim)
 *   - fenced ```` ```lang … ``` ````     → Typst raw block (body verbatim)
 *   - unordered `-`/`*`/`+`              → `-`
 *   - ordered `1.`                       → `+`
 *   - `[text](url)`                      → `#link("url")[text]`
 *   - `> quote`                          → `#quote[…]`
 *   - `---` (horizontal rule)            → `#line(length: 100%)`
 *   - paragraphs preserved; hard breaks (two trailing spaces) → Typst `\`
 *   - literal text runs escaped so Typst specials round-trip
 *
 * UNMAPPED (recorded, best-effort passthrough): pipe tables, images
 * `![alt](url)` / `![alt][label]`, footnotes (`[^id]` refs + `[^id]: …`
 * definitions), reference-style links (`[text][label]` + `[label]: url`
 * definitions), and raw HTML blocks. These are intentionally lossy.
 *
 * No DOM, no network, no deps.
 */
import { escapeTypstMathBody } from "./latex-to-typst.js";

/** A construct the converter could not faithfully map — surfaced honestly. */
export interface UnmappedConstruct {
  /** Coarse classification: "table" | "image" | "html" | "footnote" | … */
  kind: string;
  /** 1-based source line where the construct begins. */
  line: number;
  /** A short literal excerpt of the offending source. */
  snippet: string;
}

export interface MdConvertResult {
  typst: string;
  unmapped: UnmappedConstruct[];
}

// ---------------------------------------------------------------------------
// Text-run escaping
// ---------------------------------------------------------------------------

/** Typst-special characters that must be backslash-escaped in literal text. */
const TYPST_SPECIALS = new Set(["#", "$", "*", "_", "@", "<", "\\", "`"]);

/**
 * Maximum inline recursion depth (#22.2 hardening). `convertInline` recurses for
 * each nested emphasis / strong / link, so a hostile `[[[…](u)](u)](u)` or
 * `_a_a…x…a_a_` nest scales recursion with nesting depth and would overflow the
 * call stack — an unhandled `RangeError` that crashes the otherwise-throwless
 * import. No real Markdown nests inline spans anywhere near this; at the cap we
 * stop interpreting nested spans and keep the inner run as escaped literal text
 * (content preserved). The bound is far above any legitimate nesting and far
 * below the stack limit.
 */
const MAX_INLINE_DEPTH = 200;

/**
 * Escape Typst-special chars in a literal text run so the text round-trips as
 * plain content. Applied ONLY to text outside inline code / links / emphasis
 * (those are emitted as already-valid Typst).
 */
export function escapeTypstText(text: string): string {
  let out = "";
  for (const ch of text) {
    if (TYPST_SPECIALS.has(ch)) out += "\\";
    out += ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inline scanner
// ---------------------------------------------------------------------------

/**
 * Convert a single line of inline Markdown to Typst, recording any inline-level
 * unmapped constructs (images) found on `lineNo`. Block constructs are handled
 * by the line scanner; this handles the run of inline tokens within one line.
 */
function convertInline(
  text: string,
  lineNo: number,
  unmapped: UnmappedConstruct[],
  depth = 0,
): string {
  let out = "";
  let literal = ""; // pending plain-text run awaiting escape
  const n = text.length;
  let i = 0;
  // Past the recursion cap, stop interpreting nested spans: the marker char falls
  // through to the literal run below, so content is preserved without recursing.
  // NOTE: this cap is belt-and-suspenders — the inline matcher uses `indexOf` to
  // find the NEAREST closing marker, so emphasis/strong/link spans match
  // innermost-first and DO NOT nest from the outside in (`_a…_…a_` recurses to
  // depth 1, not depth n). The cap exists so any future matcher change can't
  // reintroduce an unbounded-recursion DoS; in practice it is never reached, which
  // is why (unlike latexToTypst's genuine `\textbf{…}` nesting) no truncation item
  // is recorded here.
  const canRecurse = depth < MAX_INLINE_DEPTH;

  // #22.2 — precomputed ascending positions of `]` and `)`: every bracket-shaped
  // probe (links, images, footnotes, reference links) binary-searches this index
  // via `nextAt` instead of rescanning the suffix with `indexOf`. A hostile run
  // of unclosed openers ("[^[^[^…", "[a](" × n) previously made EACH `[` scan to
  // the end of the input — O(n²), a real browser hang at ~100k chars; the index
  // makes the whole scan O(n log n) worst case with byte-identical output. Built
  // once per call; a recursive call builds its own over the (strictly smaller,
  // depth-capped) inner text.
  const closeBrackets: number[] = [];
  const closeParens: number[] = [];
  for (let k = 0; k < n; k++) {
    const c = text[k];
    if (c === "]") closeBrackets.push(k);
    else if (c === ")") closeParens.push(k);
  }

  const flush = (): void => {
    if (literal) {
      out += escapeTypstText(literal);
      literal = "";
    }
  };

  while (i < n) {
    const ch = text[i]!;

    // Backslash-escaped char in source: take the next char literally.
    if (ch === "\\" && i + 1 < n) {
      literal += text[i + 1]!;
      i += 2;
      continue;
    }

    // Inline code span: `...` — emitted verbatim as Typst raw (no escaping).
    if (ch === "`") {
      const close = text.indexOf("`", i + 1);
      if (close !== -1) {
        flush();
        out += text.slice(i, close + 1); // includes both backticks
        i = close + 1;
        continue;
      }
    }

    // Inline math: `$...$` (and `$$...$$` display, mid-line). PASSED THROUGH as
    // Typst math (we never translate LaTeX math into Typst math — same policy as
    // latex-to-typst), with the body neutralized by `escapeTypstMathBody` so a
    // crafted `#`/`$` can't go active. A `$` that doesn't open well-formed math
    // (currency like `$5 and $10`, an unterminated `$`) falls through to the
    // literal run and is escaped to `\$`, preserving the existing behavior.
    if (ch === "$") {
      const m = matchInlineMath(text, i);
      if (m) {
        flush();
        out += m.display
          ? `$ ${escapeTypstMathBody(m.body)} $`
          : `$${escapeTypstMathBody(m.body)}$`;
        i = m.end;
        continue;
      }
    }

    // Image: ![alt](url) — UNMAPPED. Record and pass the raw token through as text.
    if (ch === "!" && text[i + 1] === "[") {
      const m = matchLink(text, i + 1, closeBrackets, closeParens);
      if (m) {
        flush();
        const raw = text.slice(i, m.end);
        unmapped.push({ kind: "image", line: lineNo, snippet: raw });
        out += escapeTypstText(raw);
        i = m.end;
        continue;
      }
      // Reference-style image: ![alt][label] — UNMAPPED, recorded under its OWN
      // kind so the loss report doesn't mislabel an image as a link.
      const closeAlt = nextAt(closeBrackets, i + 2);
      if (closeAlt !== -1 && text[closeAlt + 1] === "[") {
        const closeLabel = nextAt(closeBrackets, closeAlt + 2);
        if (closeLabel !== -1) {
          flush();
          const raw = text.slice(i, closeLabel + 1);
          unmapped.push({ kind: "reference-image", line: lineNo, snippet: raw });
          out += escapeTypstText(raw);
          i = closeLabel + 1;
          continue;
        }
      }
    }

    // Footnote reference: [^id] — UNMAPPED (the header always claimed footnotes
    // were recorded, but no detection existed before the real-corpus pass; this
    // closes that honesty gap). Recorded and passed through as escaped text.
    if (ch === "[" && text[i + 1] === "^") {
      const close = nextAt(closeBrackets, i + 2);
      if (close !== -1) {
        flush();
        const raw = text.slice(i, close + 1);
        unmapped.push({ kind: "footnote", line: lineNo, snippet: raw });
        out += escapeTypstText(raw);
        i = close + 1;
        continue;
      }
    }

    // Reference-style link: [text][label] — UNMAPPED (definitions are not
    // resolved). Recorded and passed through as escaped text so nothing is lost.
    if (ch === "[") {
      const closeBracket = nextAt(closeBrackets, i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === "[") {
        const closeLabel = nextAt(closeBrackets, closeBracket + 2);
        if (closeLabel !== -1) {
          flush();
          const raw = text.slice(i, closeLabel + 1);
          unmapped.push({ kind: "reference-link", line: lineNo, snippet: raw });
          out += escapeTypstText(raw);
          i = closeLabel + 1;
          continue;
        }
      }
    }

    // Link: [text](url) → #link("url")[text]
    if (ch === "[" && canRecurse) {
      const m = matchLink(text, i, closeBrackets, closeParens);
      if (m) {
        flush();
        const inner = convertInline(m.text, lineNo, unmapped, depth + 1);
        out += `#link(${typstString(m.url)})[${inner}]`;
        i = m.end;
        continue;
      }
    }

    // Strong: **...** or __...__
    if (canRecurse && (ch === "*" || ch === "_") && text[i + 1] === ch) {
      const marker = ch + ch;
      const close = text.indexOf(marker, i + 2);
      if (close !== -1) {
        flush();
        const inner = convertInline(text.slice(i + 2, close), lineNo, unmapped, depth + 1);
        out += `*${inner}*`;
        i = close + 2;
        continue;
      }
    }

    // Emphasis: *...* or _..._
    if (canRecurse && (ch === "*" || ch === "_")) {
      const close = text.indexOf(ch, i + 1);
      if (close !== -1 && close > i + 1) {
        flush();
        const inner = convertInline(text.slice(i + 1, close), lineNo, unmapped, depth + 1);
        out += `_${inner}_`;
        i = close + 1;
        continue;
      }
    }

    literal += ch;
    i++;
  }

  flush();
  return out;
}

interface MathMatch {
  body: string;
  /** Index just past the closing delimiter. */
  end: number;
  /** Display (`$$…$$`) vs inline (`$…$`). */
  display: boolean;
}

/**
 * Match markdown math starting at a `$` (`text[i] === "$"`). `$$…$$` is display
 * math; `$…$` is inline. The inline form uses the Pandoc-ish rule that the `$`
 * delimiters must NOT have whitespace just inside them — this keeps `$5 and $10`
 * (currency) and a stray unterminated `$` from being read as math (the caller
 * then escapes them). Returns null when no well-formed math opens here. Uses
 * `indexOf` only (no backtracking) so it stays linear on hostile input.
 */
function matchInlineMath(text: string, i: number): MathMatch | null {
  if (text[i + 1] === "$") {
    const close = text.indexOf("$$", i + 2);
    if (close === -1) return null;
    return { body: text.slice(i + 2, close), end: close + 2, display: true };
  }
  const next = text[i + 1];
  if (next === undefined || next === " " || next === "\t") return null;
  const close = text.indexOf("$", i + 1);
  if (close === -1) return null;
  const before = text[close - 1];
  if (before === " " || before === "\t") return null;
  const body = text.slice(i + 1, close);
  if (body === "") return null;
  return { body, end: close + 1, display: false };
}

interface LinkMatch {
  text: string;
  url: string;
  /** Index just past the closing `)`. */
  end: number;
}

/**
 * Match a `[text](url)` link starting at `start` (which must point at `[`).
 * Returns null if the shape is not a complete link. Close positions come from
 * the caller's precomputed `]`/`)` index (see convertInline) so a failing match
 * costs O(log n), never a suffix rescan.
 */
function matchLink(
  s: string,
  start: number,
  closeBrackets: number[],
  closeParens: number[],
): LinkMatch | null {
  if (s[start] !== "[") return null;
  const closeBracket = nextAt(closeBrackets, start + 1);
  if (closeBracket === -1 || s[closeBracket + 1] !== "(") return null;
  const closeParen = nextAt(closeParens, closeBracket + 2);
  if (closeParen === -1) return null;
  return {
    text: s.slice(start + 1, closeBracket),
    url: s.slice(closeBracket + 2, closeParen),
    end: closeParen + 1,
  };
}

/**
 * First value in ascending `positions` that is ≥ `from`, else -1 (binary
 * search). The shared probe primitive behind the #22.2 close-position index.
 */
function nextAt(positions: number[], from: number): number {
  let lo = 0;
  let hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (positions[mid]! < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < positions.length ? positions[lo]! : -1;
}

/** Render a JS string as a Typst double-quoted string literal. */
function typstString(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

// ---------------------------------------------------------------------------
// Block / line scanner
// ---------------------------------------------------------------------------

const ATX_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const UL_RE = /^[-*+]\s+(.*)$/;
const OL_RE = /^\d+\.\s+(.*)$/;
// Indent-aware list item: leading whitespace (G2 nesting), an unordered (-/*/+)
// or ordered (`1.`) marker, then the content. Used INSIDE a list block so an
// indented sub-item is preserved as a nested Typst list instead of degrading.
const LIST_ITEM_RE = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
// Cap nesting depth so a pathologically deep indent ladder can't emit unbounded
// indentation; far beyond any real document.
const MAX_LIST_DEPTH = 32;
// A line that opens a `$$ … $$` display-math block (G2).
const DISPLAY_MATH_RE = /^\$\$(.*)$/;
const BLOCKQUOTE_RE = /^>\s?(.*)$/;
const FENCE_RE = /^(`{3,}|~{3,})(.*)$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const HTML_BLOCK_RE = /^\s*<\/?[a-zA-Z][^>]*>/;
// A footnote (`[^id]: …`) or reference-link (`[label]: url`) DEFINITION line.
// Group 1 captures the `^` that distinguishes a footnote from a link label.
const DEF_LINE_RE = /^\[(\^?)[^\]]+\]:\s/;

/**
 * Emit a fenced code block as a Typst raw block WITHOUT letting the captured
 * body break out of the fence. Mirrors latex-to-typst.ts:renderRawBlock — the
 * backtick fence is chosen STRICTLY LONGER than the longest backtick run in the
 * body (so no interior line can match or exceed it), the SAME fence opens and
 * closes, and backticks are stripped from the lang tag so the opening line
 * can't carry a stray fence. Without this a crafted body (a `~~~`-fenced block
 * containing a ``` line, or a ` ```typst ` line) would terminate the raw block
 * early and land following `#set`/`#show` lines OUTSIDE it as active Typst —
 * defeating the converter's "everything inert" contract. (SEC: md-import
 * Typst breakout.) Normal bodies (no backtick run ≥ 3) are byte-for-byte
 * unchanged: the fence stays a plain 3-backtick pair.
 */
function renderRawFence(bodyLines: string[], lang: string): string {
  let longest = 0;
  for (const line of bodyLines) {
    let run = 0;
    for (const ch of line) {
      if (ch === "`") {
        run++;
        if (run > longest) longest = run;
      } else {
        run = 0;
      }
    }
    // A newline always breaks a backtick run, so runs never span lines.
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  const safeLang = lang.replace(/`/g, "");
  return [fence + safeLang, ...bodyLines, fence].join("\n");
}

/**
 * Convert CommonMark-ish Markdown to Typst. Deterministic; never throws.
 */
export function markdownToTypst(md: string): MdConvertResult {
  const unmapped: UnmappedConstruct[] = [];
  const lines = md.split("\n");
  const blocks: string[] = []; // emitted Typst blocks, joined by blank lines

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i]!;
    const lineNo = i + 1; // 1-based
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();

    // Blank line — block separator; collapse runs.
    if (trimmed === "") {
      i++;
      continue;
    }

    // Fenced code block: capture verbatim until the closing fence.
    const fence = trimmed.match(FENCE_RE);
    if (fence) {
      const marker = fence[1]!;
      const lang = fence[2]!.trim();
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        const inner = lines[j]!.replace(/\r$/, "");
        if (inner.trim() === marker || (inner.trim().startsWith(marker[0]!.repeat(3)) && inner.trim().replace(/[`~]/g, "") === "")) {
          closed = true;
          break;
        }
        body.push(inner);
        j++;
      }
      blocks.push(renderRawFence(body, lang));
      i = closed ? j + 1 : j; // skip closing fence if present
      continue;
    }

    // Display-math block: `$$ … $$` (G2). Passed through as Typst display math
    // (`$ … $`), body neutralized — same policy as inline `$…$`. Handles both the
    // single-line `$$x$$` form and a multi-line block closed by a later `$$`.
    const displayMath = trimmed.match(DISPLAY_MATH_RE);
    if (displayMath) {
      const first = displayMath[1]!;
      const firstTrimmed = first.trimEnd();
      if (firstTrimmed.endsWith("$$")) {
        // Single line: `$$ body $$`.
        const mathBody = firstTrimmed.slice(0, -2).trim();
        blocks.push(`$ ${escapeTypstMathBody(mathBody)} $`);
        i++;
        continue;
      }
      // Multi-line: collect until a line containing the closing `$$`.
      const bodyLines: string[] = first.trim() === "" ? [] : [first];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        const cur = lines[j]!.replace(/\r$/, "");
        const close = cur.indexOf("$$");
        if (close !== -1) {
          if (cur.slice(0, close).trim() !== "") bodyLines.push(cur.slice(0, close));
          closed = true;
          break;
        }
        bodyLines.push(cur);
        j++;
      }
      blocks.push(`$ ${escapeTypstMathBody(bodyLines.join("\n").trim())} $`);
      i = closed ? j + 1 : j;
      continue;
    }

    // Horizontal rule.
    if (HR_RE.test(trimmed)) {
      blocks.push("#line(length: 100%)");
      i++;
      continue;
    }

    // ATX heading.
    const atx = line.match(ATX_RE);
    if (atx) {
      const level = atx[1]!.length;
      const content = convertInline(atx[2]!.trim(), lineNo, unmapped);
      blocks.push("=".repeat(level) + " " + content);
      i++;
      continue;
    }

    // Pipe table — UNMAPPED. Record the first row, pass the block through as text.
    if (TABLE_ROW_RE.test(line)) {
      const tableLines: string[] = [];
      let j = i;
      while (j < lines.length && TABLE_ROW_RE.test(lines[j]!.replace(/\r$/, ""))) {
        tableLines.push(lines[j]!.replace(/\r$/, ""));
        j++;
      }
      unmapped.push({
        kind: "table",
        line: lineNo,
        snippet: tableLines[0]!,
      });
      // Best-effort passthrough as escaped literal text so nothing is lost.
      blocks.push(tableLines.map((t) => escapeTypstText(t)).join("\n"));
      i = j;
      continue;
    }

    // Raw HTML block — UNMAPPED. Record and pass through as escaped text.
    if (HTML_BLOCK_RE.test(line)) {
      unmapped.push({ kind: "html", line: lineNo, snippet: trimmed });
      blocks.push(escapeTypstText(line));
      i++;
      continue;
    }

    // Footnote / reference-link definition line — UNMAPPED (definitions are not
    // resolved into Typst footnotes/links). Recorded; preserved as escaped text.
    const def = trimmed.match(DEF_LINE_RE);
    if (def) {
      unmapped.push({
        kind: def[1] === "^" ? "footnote" : "reference-link",
        line: lineNo,
        snippet: trimmed,
      });
      blocks.push(escapeTypstText(line));
      i++;
      continue;
    }

    // Blockquote — consecutive `>` lines collapse into one #quote.
    if (BLOCKQUOTE_RE.test(line)) {
      const quoteLines: string[] = [];
      let j = i;
      while (j < lines.length) {
        const m = lines[j]!.replace(/\r$/, "").match(BLOCKQUOTE_RE);
        if (!m) break;
        quoteLines.push(m[1]!);
        j++;
      }
      const inner = quoteLines
        .map((q, k) => convertInline(q, lineNo + k, unmapped))
        .join("\n");
      blocks.push(`#quote[${inner}]`);
      i = j;
      continue;
    }

    // Unordered / ordered list — consecutive item lines form one list block. A
    // list starts at a top-level (unindented) item; INSIDE the block, indented
    // items become nested Typst list items (G2). Indentation widths are mapped to
    // nesting LEVELS via a stack so any consistent indent step (2, 4, tab) nests,
    // normalized to two spaces per level on output.
    if (UL_RE.test(line) || OL_RE.test(line)) {
      const items: string[] = [];
      const indentStack: number[] = []; // ascending indent widths → nesting depth
      let j = i;
      while (j < lines.length) {
        const cur = lines[j]!.replace(/\r$/, "");
        const m = cur.match(LIST_ITEM_RE);
        if (!m) break;
        const indent = m[1]!.replace(/\t/g, "    ").length; // tabs → 4 cols
        while (indentStack.length > 0 && indent < indentStack[indentStack.length - 1]!) {
          indentStack.pop();
        }
        if (indentStack.length === 0 || indent > indentStack[indentStack.length - 1]!) {
          indentStack.push(indent);
        }
        const level = Math.min(indentStack.length - 1, MAX_LIST_DEPTH);
        const marker = /^\d+\./.test(m[2]!) ? "+" : "-"; // ordered → +, else -
        items.push("  ".repeat(level) + marker + " " + convertInline(m[3]!, j + 1, unmapped));
        j++;
      }
      blocks.push(items.join("\n"));
      i = j;
      continue;
    }

    // Paragraph — gather consecutive non-blank, non-special lines.
    const paraLines: string[] = [];
    let j = i;
    while (j < lines.length) {
      const cur = lines[j]!.replace(/\r$/, "");
      if (cur.trim() === "") break;
      if (isBlockStart(cur)) break;
      paraLines.push(cur);
      j++;
    }
    blocks.push(convertParagraph(paraLines, lineNo, unmapped));
    i = j;
  }

  return { typst: blocks.join("\n\n"), unmapped };
}

/**
 * True when a line opens a block-level construct (so a running paragraph must
 * end before it). Keeps paragraph gathering from swallowing lists/headings/etc.
 */
function isBlockStart(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "") return true;
  if (ATX_RE.test(line)) return true;
  if (HR_RE.test(trimmed)) return true;
  if (FENCE_RE.test(trimmed)) return true;
  if (DISPLAY_MATH_RE.test(trimmed)) return true;
  if (UL_RE.test(line)) return true;
  if (OL_RE.test(line)) return true;
  if (BLOCKQUOTE_RE.test(line)) return true;
  if (TABLE_ROW_RE.test(line)) return true;
  if (HTML_BLOCK_RE.test(line)) return true;
  if (DEF_LINE_RE.test(trimmed)) return true;
  return false;
}

/**
 * Convert a multi-line paragraph. A line ending in two+ spaces is a hard break
 * and becomes a Typst `\` linebreak; otherwise lines join with a newline.
 */
function convertParagraph(
  paraLines: string[],
  startLine: number,
  unmapped: UnmappedConstruct[],
): string {
  const out: string[] = [];
  for (let k = 0; k < paraLines.length; k++) {
    const src = paraLines[k]!;
    const hardBreak = /  +$/.test(src) && k < paraLines.length - 1;
    const converted = convertInline(src.replace(/\s+$/, ""), startLine + k, unmapped);
    out.push(hardBreak ? converted + " \\" : converted);
  }
  return out.join("\n");
}
