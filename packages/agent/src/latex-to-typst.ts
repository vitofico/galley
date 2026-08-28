/**
 * LaTeX → Typst common-subset structural converter (roadmap #15.2) — PURE,
 * offline, framework-free.
 *
 * HARD SCOPE CAP (Architect ruling): this is NOT a general LaTeX parser. There is
 * no macro expansion, no math-engine ambition, no `\usepackage`-aware behavior.
 * It deterministically converts the COMMON DOCUMENT SUBSET (headings, basic
 * inline markup, itemize/enumerate, inline + display math, line breaks, comments)
 * and HONESTLY REPORTS everything else as an `UnconvertedItem` while passing the
 * raw text through so nothing is silently lost. It is a wedge for the agent loop,
 * which repairs the long tail later — lossy, but honest.
 *
 * Implementation is a hand-rolled line/segment scanner (the offline-parser idiom
 * from `citation.ts`); no DOM, no network, no dependencies.
 *
 * Math is PASSED THROUGH verbatim: we never translate LaTeX math into Typst math.
 * Inline `$...$` stays `$...$` and `\(...\)` is normalized to `$...$`; display
 * `\[...\]` / `equation` becomes a Typst block `$ ... $` with the inner body
 * untouched. Translating math is explicitly out of scope.
 */

/** One thing the converter could not faithfully translate (honest reporting). */
export interface UnconvertedItem {
  /** A coarse category, e.g. "unknown-command", "environment", "preamble". */
  kind: string;
  /** 1-based source line where the item was encountered. */
  line: number;
  /** The raw source snippet that was not converted. */
  snippet: string;
}

/** The result of a conversion: the Typst text plus the honest unconverted list. */
export interface LatexConvertResult {
  typst: string;
  unconverted: UnconvertedItem[];
}

/**
 * Convert a LaTeX document (or fragment) to Typst over the common subset.
 * Deterministic and pure: same input always yields the same output.
 */
export function latexToTypst(tex: string): LatexConvertResult {
  const unconverted: UnconvertedItem[] = [];
  if (tex.length === 0) {
    return { typst: "", unconverted };
  }

  const rawLines = tex.split(/\r?\n/);
  // Map every retained line back to its ORIGINAL 1-based line number so the
  // unconverted catalog stays honest even after the preamble is stripped.
  const lines: Array<{ text: string; lineNo: number }> = rawLines.map((text, i) => ({
    text,
    lineNo: i + 1,
  }));

  const stripped = stripPreambleAndDocument(lines, unconverted);

  // #22.2 SEC-22.2-7: per-conversion cache of environment begin/end marker line
  // indices, keyed by env name, so `findEnvEnd` walks only the relevant marker
  // lines instead of rescanning to EOF for every opener. This bounds the total
  // env-matching work to O(n) regardless of how many UNMATCHED `\begin{env}` a
  // hostile input piles up (was O(k·n)). It is a pure performance memo — the
  // depth-counting semantics are identical, so valid output is byte-for-byte
  // unchanged. Built lazily on first lookup for each env name.
  const envMarkers = new EnvMarkerIndex(stripped);

  const out: string[] = [];
  let i = 0;
  while (i < stripped.length) {
    const { text, lineNo } = stripped[i]!;
    const trimmed = text.trim();

    // Environment openers consume through their matching \end{...}.
    const envOpen = trimmed.match(/^\\begin\{([^}]*)\}/);
    if (envOpen) {
      const env = envOpen[1]!;
      const consumed = convertEnvironment(env, stripped, i, out, unconverted, envMarkers);
      i = consumed;
      continue;
    }

    // Display math opener \[ ... \] (possibly spanning lines).
    if (trimmed.startsWith("\\[")) {
      const consumed = convertDisplayMath(stripped, i, out);
      i = consumed;
      continue;
    }

    out.push(convertLine(text, lineNo, unconverted));
    i++;
  }

  return { typst: out.join("\n"), unconverted };
}

// ---------------------------------------------------------------------------
// Preamble / document body isolation
// ---------------------------------------------------------------------------

/**
 * If a `\begin{document}` is present, drop everything before it (the preamble)
 * and the trailing `\end{document}`, recording the document class as a note. If
 * there is no `\begin{document}`, treat the whole input as a body fragment.
 */
function stripPreambleAndDocument(
  lines: Array<{ text: string; lineNo: number }>,
  unconverted: UnconvertedItem[],
): Array<{ text: string; lineNo: number }> {
  const beginIdx = lines.findIndex((l) => /\\begin\{document\}/.test(l.text));
  if (beginIdx === -1) return lines;

  // Record the document class (if any) so the preamble strip is auditable.
  for (let i = 0; i < beginIdx; i++) {
    const m = lines[i]!.text.match(/\\documentclass(?:\[[^\]]*\])?\{([^}]*)\}/);
    if (m) {
      unconverted.push({
        kind: "preamble",
        line: lines[i]!.lineNo,
        snippet: `documentclass: ${m[1]}`,
      });
      break;
    }
  }

  const endIdx = lines.findIndex((l) => /\\end\{document\}/.test(l.text));
  const lastIdx = endIdx === -1 ? lines.length : endIdx;
  return lines.slice(beginIdx + 1, lastIdx);
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

/**
 * Convert (or report) an environment starting at `start`. Returns the index of
 * the line just past the matching `\end{env}` (or past `start` if unmatched).
 * Appends rendered Typst to `out`.
 */
function convertEnvironment(
  env: string,
  lines: Array<{ text: string; lineNo: number }>,
  start: number,
  out: string[],
  unconverted: UnconvertedItem[],
  envMarkers: EnvMarkerIndex,
): number {
  const end = findEnvEnd(env, start, envMarkers);
  // Inner content lines are (start, end) exclusive of the begin/end markers.
  const inner = lines.slice(start + 1, end);

  if (env === "itemize" || env === "enumerate") {
    const marker = env === "itemize" ? "-" : "+";
    renderListEnv(env, marker, inner, out, unconverted);
    return end + 1;
  }

  if (env === "equation" || env === "equation*" || env === "displaymath") {
    const body = inner.map((l) => l.text).join("\n").trim();
    // G6: lift a single `\label{key}` OUT of the math body so it becomes a real
    // Typst post-block label (`$ … $ <key>`) instead of literal text inside the
    // equation. Neutralized like every emitted math body: a raw `$`/`#` inside
    // the environment must not terminate the Typst block / go active.
    out.push(emitDisplayMath(body));
    return end + 1;
  }

  // verbatim / lstlisting → a Typst RAW block (```…```). The body is LITERAL:
  // no inline conversion, no math escaping. The only safety concern is the
  // body breaking OUT of the fence, so we pick a fence longer than any
  // backtick run inside it (the standard raw-block technique). NOT unconverted.
  if (env === "verbatim" || env === "lstlisting") {
    const body = inner.map((l) => l.text).join("\n");
    out.push(renderRawBlock(body));
    return end + 1;
  }

  // figure / table floats → `#figure(image("path"), caption: [text]) <label>`.
  // Only when there is an `\includegraphics` to anchor the figure body; a
  // float WITHOUT a graphic (e.g. a tabular-only table) has no faithful body,
  // so it falls through to the comment fallback below (still reported).
  if (env === "figure" || env === "table") {
    const rendered = renderFloat(inner, lines[start]!.lineNo, unconverted);
    if (rendered !== null) {
      out.push(rendered);
      return end + 1;
    }
  }

  // Everything else (tabular, align, no-graphic floats, custom envs, …) is
  // unconverted but kept verbatim as a Typst comment so the raw content is
  // never silently lost.
  const block = lines.slice(start, end + 1);
  unconverted.push({
    kind: "environment",
    line: lines[start]!.lineNo,
    snippet: block.map((l) => l.text).join("\n"),
  });
  for (const l of block) out.push(`// ${l.text}`);
  return end + 1;
}

/**
 * A per-conversion index of environment begin/end marker lines, grouped by env
 * name. This is the SEC-22.2-7 fix.
 *
 * The whole document is scanned ONCE (`buildMarkers`, on first lookup) with a
 * global `/\\begin\{([^}]*)\}/g` + `/\\end\{([^}]*)\}/g` extraction, appending
 * each marker line to its captured name's begin/end list. Per-name pairing is
 * then computed from just that name's (small) marker lists via a stack pass.
 * So total cost is **O(n + total markers)** regardless of how many DISTINCT env
 * names appear — k unmatched openers of k DISTINCT names no longer trigger k
 * full-document rescans (the earlier per-name lazy build did, reintroducing the
 * O(k·n) DoS this fix exists to kill).
 *
 * EXACT equivalence with the original `findEnvEnd` forward scan is preserved:
 *  - For a given name a line counts as ONE begin if it contains `\begin{NAME}`
 *    and ONE end if it contains `\end{NAME}` (per-line boolean — multiple
 *    occurrences of the same name on one line collapse to one, matching the
 *    original `.test()`); the depth step within a line is +1 then -1
 *    (begin-before-end). A line with both a begin and an end for the same name
 *    is push-then-pop → it pairs with itself, exactly like today.
 *  - Names are captured with `[^}]*`, the same recognizer the main dispatch
 *    loop uses — the recognized-env set is unchanged.
 *  - An unmatched opener resolves to itself (the original returns `start`).
 */
class EnvMarkerIndex {
  private readonly lines: Array<{ text: string; lineNo: number }>;
  // Per env name → ascending line indices of its begin / end markers (one entry
  // per line, deduped, matching the per-line boolean of the original `.test()`).
  private markers: Map<string, { begins: number[]; ends: number[] }> | null = null;
  // Per env name → memoized `begin line → resolved end line` pairing table.
  private readonly pairings = new Map<string, Map<number, number>>();

  constructor(lines: Array<{ text: string; lineNo: number }>) {
    this.lines = lines;
  }

  /**
   * Resolve the matching `\end{env}` line for the `\begin{env}` opener at
   * `start` — O(1) after the one-time global marker scan + a per-name pairing
   * pass over only that name's markers. Falls back to `start` when unmatched.
   */
  endFor(env: string, start: number): number {
    let table = this.pairings.get(env);
    if (!table) {
      table = this.buildPairings(env);
      this.pairings.set(env, table);
    }
    return table.get(start) ?? start;
  }

  /** One global pass: group every begin/end marker line by its captured name. */
  private buildMarkers(): Map<string, { begins: number[]; ends: number[] }> {
    const markers = new Map<string, { begins: number[]; ends: number[] }>();
    const slot = (name: string): { begins: number[]; ends: number[] } => {
      let s = markers.get(name);
      if (!s) {
        s = { begins: [], ends: [] };
        markers.set(name, s);
      }
      return s;
    };
    const beginRe = /\\begin\{([^}]*)\}/g;
    const endRe = /\\end\{([^}]*)\}/g;
    for (let i = 0; i < this.lines.length; i++) {
      const t = this.lines[i]!.text;
      // Per-line, per-name boolean (a name appearing twice on a line is ONE
      // begin / ONE end, matching the original `.test()`); dedupe via a Set.
      let seenBegin: Set<string> | null = null;
      let seenEnd: Set<string> | null = null;
      let m: RegExpExecArray | null;
      beginRe.lastIndex = 0;
      while ((m = beginRe.exec(t)) !== null) {
        const name = m[1]!;
        if (!seenBegin) seenBegin = new Set();
        if (seenBegin.has(name)) continue;
        seenBegin.add(name);
        slot(name).begins.push(i);
      }
      endRe.lastIndex = 0;
      while ((m = endRe.exec(t)) !== null) {
        const name = m[1]!;
        if (!seenEnd) seenEnd = new Set();
        if (seenEnd.has(name)) continue;
        seenEnd.add(name);
        slot(name).ends.push(i);
      }
    }
    return markers;
  }

  private buildPairings(env: string): Map<number, number> {
    if (!this.markers) this.markers = this.buildMarkers();
    const table = new Map<number, number>();
    const m = this.markers.get(env);
    if (!m) return table; // no markers for this name → every opener unmatched
    // Merge this name's begin/end marker lines in ascending order, applying
    // begin-before-end within a line, and pair via a stack — identical to the
    // original forward scan, but over only this name's markers.
    const stack: number[] = [];
    let bi = 0;
    let ei = 0;
    while (bi < m.begins.length || ei < m.ends.length) {
      const bLine = bi < m.begins.length ? m.begins[bi]! : Infinity;
      const eLine = ei < m.ends.length ? m.ends[ei]! : Infinity;
      // On a line carrying both, process the begin first (push), then the end
      // (pop) — net self-contained, so the opener pairs with its own line.
      if (bLine <= eLine) {
        stack.push(bLine);
        bi++;
      } else {
        const open = stack.pop();
        if (open !== undefined) table.set(open, eLine);
        ei++;
      }
    }
    // Unmatched openers resolve to themselves (the original returns `start`).
    for (const open of stack) table.set(open, open);
    return table;
  }
}

/**
 * Find the index of the matching `\end{env}` for `\begin{env}` at `start`.
 * Delegates to the precomputed marker index (SEC-22.2-7): O(1) per opener after
 * a single global O(n + markers) marker scan — byte-for-byte equivalent to the
 * original forward scan, but no longer O(k·n) for k unmatched openers, whether
 * those openers share one env name or are all DISTINCT.
 */
function findEnvEnd(env: string, start: number, envMarkers: EnvMarkerIndex): number {
  return envMarkers.endFor(env, start);
}

/** Render an itemize/enumerate body, mapping each `\item` to `marker`. */
function renderListEnv(
  env: string,
  marker: string,
  inner: Array<{ text: string; lineNo: number }>,
  out: string[],
  unconverted: UnconvertedItem[],
): void {
  for (const { text, lineNo } of inner) {
    const trimmed = text.trim();
    if (trimmed.length === 0) continue;
    const itemMatch = trimmed.match(/^\\item\b\s*(.*)$/);
    if (itemMatch) {
      const content = convertInline(itemMatch[1] ?? "", lineNo, unconverted);
      out.push(`${marker} ${content}`.trimEnd());
    } else {
      // A nested environment or continuation line inside the list: report it but
      // keep the converted text so content survives.
      const nested = trimmed.match(/^\\begin\{([^}]*)\}/);
      if (nested) {
        unconverted.push({
          kind: "nested-environment",
          line: lineNo,
          snippet: `${env} contains nested \\begin{${nested[1]}}`,
        });
      }
      out.push(`  ${convertInline(trimmed, lineNo, unconverted)}`.trimEnd());
    }
  }
}

/**
 * Render a verbatim/lstlisting body as a Typst raw block (G3). The body is kept
 * LITERAL — no inline conversion, no math escaping. To stop the body breaking
 * out of the fence, we choose a backtick fence STRICTLY LONGER than the longest
 * run of backticks anywhere in the body (the standard raw-block escape), so no
 * line inside can ever match (or exceed) the surrounding fence.
 */
function renderRawBlock(body: string): string {
  let longest = 0;
  let run = 0;
  for (const ch of body) {
    if (ch === "`") {
      run++;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${body}\n${fence}`;
}

/**
 * Render an inline code span (`\texttt`) as a Typst inline raw. A backtick inside
 * the body would prematurely close a single-backtick span, so — mirroring
 * `renderRawBlock` — we pick a fence STRICTLY LONGER than the longest backtick run
 * in the body. When the body itself starts or ends with a backtick we pad a single
 * space so the fence and the body stay visually separate. The common case (no
 * backtick) keeps the plain single-backtick form.
 */
function renderInlineCode(body: string): string {
  let longest = 0;
  let run = 0;
  for (const ch of body) {
    if (ch === "`") {
      run++;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  if (longest === 0) return `\`${body}\``;
  const fence = "`".repeat(longest + 1);
  const lead = body.startsWith("`") ? " " : "";
  const trail = body.endsWith("`") ? " " : "";
  return `${fence}${lead}${body}${trail}${fence}`;
}

/**
 * Render a figure/table float as a Typst `#figure(...)` (G3). The body is the
 * first `\includegraphics{path}` mapped to `image("path")` (its optional `[...]`
 * options are dropped, the path routed through `escapeTypstString`); the
 * `\caption{...}` becomes `caption: [<inline-converted text>]`; a `\label{...}`
 * becomes a trailing Typst `<label>`. Returns `null` when there is no
 * `\includegraphics` to anchor the figure — the caller then falls back to the
 * honest comment behavior rather than emitting an empty figure.
 *
 * No document rescan is introduced: this walks ONLY the float's own already-
 * sliced `inner` lines (a per-environment local scan, not a whole-document one),
 * so the O(n) env-matching guarantee from SEC-22.2-7 is untouched.
 */
function renderFloat(
  inner: Array<{ text: string; lineNo: number }>,
  lineNo: number,
  unconverted: UnconvertedItem[],
): string | null {
  let imagePath: string | null = null;
  let caption: string | null = null;
  let label: string | null = null;

  for (const { text } of inner) {
    if (imagePath === null) {
      // `\includegraphics[opts]{path}` — opts are optional; strip them.
      const ig = text.match(/\\includegraphics(?:\[[^\]]*\])?\{([^}]*)\}/);
      if (ig) imagePath = ig[1] ?? "";
    }
    if (caption === null) {
      const capAt = text.indexOf("\\caption");
      if (capAt !== -1) {
        const braceAt = text.indexOf("{", capAt);
        if (braceAt !== -1) {
          const body = readBraceBalanced(text, braceAt);
          if (body) caption = body.inner;
        }
      }
    }
    if (label === null) {
      const lab = text.match(/\\label\{([^}]*)\}/);
      if (lab) label = lab[1] ?? "";
    }
  }

  // No graphic → no faithful figure body; let the caller keep the comment.
  if (imagePath === null) return null;

  const parts: string[] = [`  image("${escapeTypstString(imagePath)}"),`];
  if (caption !== null) {
    // The caption may contain inline LaTeX — convert it with the same inline
    // pass the body text uses (which neutralizes any injection via the shared
    // math/escape helpers). It is interpolated inside a Typst `[...]` content
    // block, so no extra escaping beyond convertInline's own discipline.
    parts.push(`  caption: [${convertInline(caption, lineNo, unconverted)}],`);
  }
  // Emit the Typst label only when it is composed of label-safe characters
  // (letters, digits, and `_-.:`), matching the LaTeX keys real documents use.
  // A label carrying anything else (e.g. a `>` that would close the label, or
  // whitespace) is DROPPED rather than risk injecting active Typst — labels are
  // a best-effort convenience, not load-bearing for content fidelity.
  const labelSuffix = label !== null && /^[A-Za-z0-9_\-.:]+$/.test(label) ? ` <${label}>` : "";
  return `#figure(\n${parts.join("\n")}\n)${labelSuffix}`;
}

// ---------------------------------------------------------------------------
// Display math (\[ ... \])
// ---------------------------------------------------------------------------

/**
 * Convert a `\[ ... \]` display block starting at `start`. The closing `\]` may be
 * on the same line or a later one. Returns the index just past the close.
 */
function convertDisplayMath(
  lines: Array<{ text: string; lineNo: number }>,
  start: number,
  out: string[],
): number {
  const joined: string[] = [];
  let i = start;
  for (; i < lines.length; i++) {
    joined.push(lines[i]!.text);
    if (lines[i]!.text.includes("\\]")) break;
  }
  const blob = joined.join("\n");
  // Strip the \[ … \] delimiters; keep the inner math, neutralized so a raw
  // `$`/`#` in the body cannot terminate the Typst block / go active. G6 lifts a
  // single `\label{key}` out of the body into a Typst post-block label.
  const inner = blob.replace(/\\\[/, "").replace(/\\\]/, "").trim();
  out.push(emitDisplayMath(inner));
  return i + 1;
}

// A LaTeX label key is conventionally letters/digits + `_-.:` (e.g. `eq:gap`);
// match exactly the safe charset the figure path already allows so an emitted
// Typst label can never carry a `>` (which would close the label) or whitespace.
const LABEL_SAFE_RE = /^[A-Za-z0-9_\-.:]+$/;
// One `\label{…}` occurrence; the body is `[^{}]*` so it cannot span nested
// braces (real labels never do) and the single match keeps this a LINEAR scan.
const MATH_LABEL_RE = /\\label\{([^{}]*)\}/;

/**
 * Emit a Typst display-math block for `body`, lifting a single `\label{key}` out
 * of the math (G6). The label is stripped from the math body and, when its key
 * is label-safe, appended as a Typst post-block label (`$ … $ <key>`). When
 * there is no `\label` the output is byte-identical to `$ ${escape(body)} $`.
 * The remaining body is always passed through `escapeTypstMathBody`.
 */
function emitDisplayMath(body: string): string {
  const m = body.match(MATH_LABEL_RE);
  if (m === null) return `$ ${escapeTypstMathBody(body)} $`;
  const key = m[1]!;
  // Remove the FIRST `\label{…}` and tidy the whitespace it leaves behind so the
  // math body reads cleanly (a `\label` on its own source line is common).
  const stripped = body.replace(MATH_LABEL_RE, "").replace(/\s+/g, " ").trim();
  const block = `$ ${escapeTypstMathBody(stripped)} $`;
  // Drop (do not inject) a label whose key carries anything outside the safe
  // charset — labels are a best-effort convenience, not load-bearing content.
  return LABEL_SAFE_RE.test(key) ? `${block} <${key}>` : block;
}

// ---------------------------------------------------------------------------
// Line-level conversion
// ---------------------------------------------------------------------------

/**
 * Convert a single source line that is NOT an environment/display-math opener:
 * headings map to `=`/`==`/`===`, otherwise the line is inline-converted.
 */
function convertLine(text: string, lineNo: number, unconverted: UnconvertedItem[]): string {
  const trimmed = text.trim();

  const heading = trimmed.match(/^\\(section|subsection|subsubsection)\*?\{([\s\S]*)\}\s*$/);
  if (heading) {
    const level = heading[1]!;
    const prefix = level === "section" ? "=" : level === "subsection" ? "==" : "===";
    const title = convertInline(heading[2] ?? "", lineNo, unconverted);
    return `${prefix} ${title}`;
  }

  return convertInline(text, lineNo, unconverted);
}

// ---------------------------------------------------------------------------
// Inline conversion (segment scanner)
// ---------------------------------------------------------------------------

/** Typst-special characters escaped inside PLAIN text runs (not inside math). */
const TYPST_SPECIAL = new Set(["#", "*", "_", "@", "<", "`", ">", "$"]);

/**
 * Maximum inline-markup recursion depth (#22.2 hardening). `renderCommand`
 * recurses into `convertInline` for each nested wrapping command (\textbf{…},
 * \emph{…}, …), so a hostile `\textbf{\textbf{…{x}…}}` nest scales recursion with
 * nesting depth and overflows the call stack (~5000 frames) — an unhandled
 * `RangeError` that crashes the otherwise-throwless import. No real document
 * nests inline markup anywhere near this; at the cap we stop recursing and keep
 * the body as escaped literal text (content preserved), recording the truncation
 * so the loss stays honest. The bound is far above any legitimate nesting and far
 * below the stack limit.
 */
const MAX_INLINE_DEPTH = 200;

/**
 * Convert an inline run. Walks the string segment by segment:
 *   - `% …`        → a LaTeX comment; the rest of the line is dropped.
 *   - `$ … $`      → inline math, PASSED THROUGH verbatim (delimiters kept).
 *   - `\\`         → a Typst line break (literal backslash).
 *   - `\cmd{…}`    → a known markup command, or an honestly-reported unknown one.
 *   - plain text   → emitted with Typst-special chars escaped.
 */
function convertInline(
  input: string,
  lineNo: number,
  unconverted: UnconvertedItem[],
  depth = 0,
): string {
  let out = "";
  let i = 0;
  const n = input.length;
  // #22.2 watermark: once a `\)` probe comes up empty, every LATER opener probes
  // a strict suffix of the already-failed range and must come up empty too — so
  // a hostile "\\(\\(\\(…" run scans the input ONCE, not once per opener (the
  // per-opener rescan was O(n²) time).
  let noInlineMathClose = false;

  while (i < n) {
    const ch = input[i]!;

    // LaTeX comment: drop the remainder of the line (a real `%` is `\%`).
    if (ch === "%") {
      break;
    }

    // Inline math: pass through, delimiters included. The body is neutralized
    // by `escapeTypstMathBody` so a crafted `#` cannot go ACTIVE inside the
    // emitted Typst math; real LaTeX math is byte-identical ($/# are TeX
    // specials and only appear escaped there).
    if (ch === "$") {
      const close = input.indexOf("$", i + 1);
      if (close !== -1) {
        out += `$${escapeTypstMathBody(input.slice(i + 1, close))}$`;
        i = close + 1;
        continue;
      }
      // Unterminated `$`: treat as a literal, escaped dollar.
      out += "\\$";
      i++;
      continue;
    }

    if (ch === "\\") {
      // Line break: `\\` → a literal backslash (Typst's line break).
      if (input[i + 1] === "\\") {
        out += "\\";
        i += 2;
        continue;
      }
      // Inline math in `\( … \)` form (the LaTeX2e idiom, common in real
      // papers): normalize to `$ … $`, body passed through (neutralized) — the
      // same contract as `$…$`. Found by the real-corpus pass: this previously
      // degraded to a bare-backslash unknown-command per delimiter.
      if (input[i + 1] === "(") {
        const close = noInlineMathClose ? -1 : input.indexOf("\\)", i + 2);
        if (close !== -1) {
          out += `$${escapeTypstMathBody(input.slice(i + 2, close))}$`;
          i = close + 2;
          continue;
        }
        noInlineMathClose = true;
      }
      // Escaped special char in LaTeX (e.g. \%, \&, \#, \_, \$): emit the literal
      // character, Typst-escaped where required.
      const esc = input[i + 1];
      if (esc !== undefined && /[%&#_${}~^]/.test(esc)) {
        out += escapeChar(esc);
        i += 2;
        continue;
      }

      const cmd = parseCommand(input, i);
      if (cmd) {
        out += renderCommand(cmd, lineNo, unconverted, depth);
        i = cmd.end;
        continue;
      }

      // A bare backslash we don't understand: report and keep it literally. The
      // snippet is EXCERPTED (#22.2): keeping the whole remainder per occurrence
      // let a hostile run of bare backslashes accumulate O(n²) snippet bytes.
      unconverted.push({
        kind: "unknown-command",
        line: lineNo,
        snippet: snippetExcerpt(input.slice(i, i + MAX_SNIPPET_CHARS + 1)),
      });
      out += "\\";
      i++;
      continue;
    }

    // Plain character: escape if Typst-special.
    out += escapeChar(ch);
    i++;
  }

  return out;
}

interface ParsedCommand {
  name: string;
  /** The brace argument body (empty string if the command took none). */
  arg: string;
  /** True if the command had a `{…}` argument. */
  hadArg: boolean;
  /** Index in the source just past the command (and its argument). */
  end: number;
  /** The full raw command text, for honest reporting. */
  raw: string;
}

/**
 * Parse a `\name` or `\name{arg}` starting at the backslash `at`. The argument is
 * read brace-balanced. Returns null if there is no command name after the slash.
 */
function parseCommand(input: string, at: number): ParsedCommand | null {
  let j = at + 1;
  const nameStart = j;
  while (j < input.length && /[a-zA-Z]/.test(input[j]!)) j++;
  if (j === nameStart) return null;
  const name = input.slice(nameStart, j);

  // An optional `[...]` argument (e.g. \item[x]) is skipped over for known cmds.
  // A `{...}` argument is read brace-balanced.
  if (input[j] === "{") {
    const body = readBraceBalanced(input, j);
    if (body) {
      return {
        name,
        arg: body.inner,
        hadArg: true,
        end: body.end,
        raw: input.slice(at, body.end),
      };
    }
  }
  return { name, arg: "", hadArg: false, end: j, raw: input.slice(at, j) };
}

/** Read a brace-balanced `{ … }` starting at the `{` index `open`. */
function readBraceBalanced(input: string, open: number): { inner: string; end: number } | null {
  let depth = 0;
  for (let i = open; i < input.length; i++) {
    const c = input[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { inner: input.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** The inline markup commands we translate, each wrapping its (inline) argument. */
const WRAP_COMMANDS: Record<string, { open: string; close: string }> = {
  textbf: { open: "*", close: "*" },
  textit: { open: "_", close: "_" },
  emph: { open: "_", close: "_" },
  texttt: { open: "`", close: "`" },
};

/**
 * Render a parsed command. Known wrapping commands recurse on their argument;
 * `texttt` keeps its body literal (raw block). Unknown commands are reported and
 * their raw text is passed through (with a TODO marker for cite/ref) so content
 * is never silently dropped.
 */
function renderCommand(
  cmd: ParsedCommand,
  lineNo: number,
  unconverted: UnconvertedItem[],
  depth = 0,
): string {
  const wrap = WRAP_COMMANDS[cmd.name];
  if (wrap && cmd.hadArg) {
    // Depth guard (#22.2): a hostile nest like \textbf{\textbf{…}} recurses per
    // level and would overflow the stack. Past the cap, stop recursing — keep the
    // body as escaped literal text (content preserved) and report the truncation.
    if (depth >= MAX_INLINE_DEPTH) {
      unconverted.push({ kind: "nesting-too-deep", line: lineNo, snippet: cmd.raw });
      return escapePlain(cmd.arg);
    }
    // `texttt` is a raw (code) span — do not re-interpret its body. Render it via
    // renderInlineCode so a backtick inside the body can't break out of the span.
    if (cmd.name === "texttt") return renderInlineCode(cmd.arg);
    const body = convertInline(cmd.arg, lineNo, unconverted, depth + 1);
    return `${wrap.open}${body}${wrap.close}`;
  }

  // Citation/reference: leave a visible TODO marker and report, keeping the key.
  // #22.2 SEC-22.2-8: the arg is interpolated into a Typst block comment, so a
  // crafted cite/ref arg containing `*/` would close the comment early and let
  // the remainder become syntactically-active Typst. Neutralize `*/` (and `/*`)
  // in the emitted comment body so the marker can never break out.
  if (cmd.name === "cite" || cmd.name === "ref" || cmd.name === "eqref") {
    unconverted.push({ kind: cmd.name, line: lineNo, snippet: cmd.raw });
    return `/* TODO ${cmd.name}: ${escapeTypstComment(cmd.arg)} */`;
  }

  // Any other command is unconverted: report it and pass the raw text through as
  // plain (escaped) text so it survives in the output.
  unconverted.push({ kind: "unknown-command", line: lineNo, snippet: cmd.raw });
  return escapePlain(cmd.raw);
}

// ---------------------------------------------------------------------------
// Escaping helpers
// ---------------------------------------------------------------------------

/**
 * Max characters retained in an `UnconvertedItem.snippet` ("a short literal
 * excerpt", per the interface contract). The bare-backslash report used to keep
 * the WHOLE remaining segment per occurrence, so a hostile run of unknown
 * backslashes accumulated O(n²) snippet bytes (#22.2). Longer snippets are
 * truncated with an ellipsis.
 */
const MAX_SNIPPET_CHARS = 120;

/** Truncate a snippet to MAX_SNIPPET_CHARS, appending an ellipsis when cut. */
function snippetExcerpt(s: string): string {
  return s.length <= MAX_SNIPPET_CHARS ? s : `${s.slice(0, MAX_SNIPPET_CHARS)}…`;
}

/**
 * Neutralize Typst-ACTIVE characters inside an emitted math body (#22.2, the
 * SEC-22.2-8 posture): a raw `$` terminates the Typst math block early and a
 * raw `#` invokes code mode even INSIDE math, so `\(x $ #set …$ y\)` would
 * smuggle an active `#set` into the imported document. Bare `$`/`#` become
 * `\$`/`\#` (legal Typst math escapes that render the literal character);
 * already-escaped pairs (`\$`, `\#`) and every other backslash sequence pass
 * through untouched — real LaTeX math, where `$`/`#` are TeX specials and only
 * ever appear escaped, is byte-for-byte unchanged. Applied at EVERY math
 * emission site (`$…$`, `\(…\)`, `\[…\]`, equation environments). Exported for
 * tests.
 */
export function escapeTypstMathBody(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && i + 1 < s.length) {
      out += ch + s[i + 1]!;
      i++;
      continue;
    }
    out += ch === "$" || ch === "#" ? `\\${ch}` : ch;
  }
  return out;
}

/** Escape one character if it is Typst-special; otherwise return it unchanged. */
function escapeChar(ch: string): string {
  return TYPST_SPECIAL.has(ch) ? `\\${ch}` : ch;
}

/** Escape every Typst-special character in a plain string. */
function escapePlain(s: string): string {
  let out = "";
  for (const ch of s) out += escapeChar(ch);
  return out;
}

/**
 * Neutralize Typst block-comment delimiters in a string destined for the body
 * of an emitted `/* … *​/` comment (#22.2 SEC-22.2-8). A raw `*​/` in the body
 * would terminate the comment early and let the rest become active Typst; a raw
 * `/​*` could open a nested comment. We break both pairs by inserting a benign
 * space between the two characters, so `*​/` → `* /` and `/​*` → `/ *`. Output is
 * unchanged for any body that contains no comment delimiter. Exported for tests.
 */
export function escapeTypstComment(s: string): string {
  return s.replace(/\*\//g, "* /").replace(/\/\*/g, "/ *");
}

/**
 * Escape a string for safe interpolation inside a Typst double-quoted STRING
 * literal (#22.2 SEC-22.2-8). A raw `"` would close the literal and a raw `\`
 * could start an escape sequence, either of which lets a crafted include/bib
 * path inject syntactically-active Typst. Backslash MUST be escaped first so we
 * don't double-escape the backslash we add for the quote. Output is unchanged
 * for any string with no `"` or `\`. Exported for tests / reuse by the importer.
 */
export function escapeTypstString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
