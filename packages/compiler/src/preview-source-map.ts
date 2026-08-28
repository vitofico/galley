/**
 * Forward source→preview index (#11.3) — pure builder.
 *
 * Given the compiler's `getAst` dump and the rendered SVG string, derive a
 * best-effort map from source ranges to rendered page regions, so the editor can
 * scroll/outline the preview region under the cursor. This is the offline,
 * AST-driven "route (b)" the E4 spike validated (docs/research/span-svg-mapping.md):
 * no per-element `data-span` round-trip, no upstream `typst-preview` glue.
 *
 * It is intentionally **pure** and **fail-soft**: every parser tolerates an
 * unexpected shape and returns an empty result rather than throwing, so a render
 * that can't be indexed simply yields no map (the preview then behaves exactly as
 * it does today).
 *
 * ## Mechanism (proven by the spike)
 *
 * - **AST** `getAst("/main.typ")` emits a YAML-ish indented tree; every node is a
 *   line of the form `s: <span …>Marked::Kind</span> &lt;L:C~L:C&gt;` with an
 *   optional source range. Ranges are **1-based line, 0-based column** (the
 *   heading marker `=` at the start of line 1 is `1:0~1:1`). We collect the
 *   text-bearing leaves (`Text`, `MathText`, …) in document order.
 * - **SVG** the renderer emits a deterministic geometric tree
 *   `typst-doc > typst-page > … > g.typst-text`, every node carrying a cumulative
 *   `transform`. Each `g.typst-text` contains a `<foreignObject class? tsel>` (via
 *   a `scale(16,-16)` group) whose `x/y/width/height` + the composed transform
 *   chain give the run's **document-space bbox** — no DOM layout, works in Node.
 *
 * Aligning the two ordered lists (AST text leaves ↔ SVG text runs) gives
 * `source range → page + bbox`. The memo flags first-cut alignment as possibly
 * coarse; we keep it order-based with a light text-length sanity check and never
 * fail the render over it.
 */

import type {
  PreviewSourceMap,
  PreviewSourceEntry,
  PreviewRect,
  SourceLineCol,
} from "@galley/shared";

/** A text-bearing AST leaf: its kind and its source range. */
export interface AstTextLeaf {
  kind: string;
  start: SourceLineCol;
  end: SourceLineCol;
  /**
   * OPTIONAL in-project path of the file this leaf came from (B14). Set when the
   * leaves are parsed from a specific project file so reverse navigation can
   * switch to it; absent for the single-file path (the active file is implied).
   */
  filePath?: string;
  /**
   * OPTIONAL whitespace-normalized source text sliced from `[start, end)` of the
   * file's source (fix/preview-backlink). Present when the file's source text was
   * threaded into the parser, so the aligner can match this leaf against a
   * rendered run's visible text instead of relying on array position. Absent when
   * no source text was supplied (the aligner then degrades to positional order).
   */
  text?: string;
}

/** A rendered text run extracted from the SVG: its page, bbox, and visible text. */
export interface SvgTextRun {
  page: number;
  rect: PreviewRect;
  /** The `tsel` text content of the run (used as a soft alignment check). */
  text: string;
}

/** A 2×3 affine transform `[a, b, c, d, e, f]` mapping (x,y) → (ax+cy+e, bx+dy+f). */
type Affine = [number, number, number, number, number, number];

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** Compose two affine transforms: `outer` applied after `inner`. */
function compose(outer: Affine, inner: Affine): Affine {
  const [a, b, c, d, e, f] = outer;
  const [a2, b2, c2, d2, e2, f2] = inner;
  return [
    a * a2 + c * b2,
    b * a2 + d * b2,
    a * c2 + c * d2,
    b * c2 + d * d2,
    a * e2 + c * f2 + e,
    b * e2 + d * f2 + f,
  ];
}

/** Apply an affine transform to a point. */
function apply(t: Affine, x: number, y: number): [number, number] {
  return [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
}

/**
 * Parse the `transform` attribute of a single SVG group into an affine matrix.
 * Supports the two forms the renderer emits — `translate(x, y)` and
 * `scale(a, b)` (and a bare `scale(a)`) — composed left-to-right. Unknown forms
 * are skipped (treated as identity) so we never throw on an unexpected attribute.
 */
export function parseTransform(value: string | undefined): Affine {
  if (!value) return IDENTITY;
  let t: Affine = IDENTITY;
  const re = /(translate|scale|matrix)\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const fn = m[1]!;
    const nums = m[2]!
      .split(/[\s,]+/)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n));
    if (fn === "translate") {
      const [x = 0, y = 0] = nums;
      t = compose(t, [1, 0, 0, 1, x, y]);
    } else if (fn === "scale") {
      const [sx = 1, sy = nums[0] ?? 1] = nums;
      t = compose(t, [sx, 0, 0, sy, 0, 0]);
    } else if (fn === "matrix" && nums.length === 6) {
      t = compose(t, nums as Affine);
    }
  }
  return t;
}

/** Decode the handful of XML entities `getAst` emits in its range text. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const RANGE_RE = /<(\d+):(\d+)~(\d+):(\d+)>/;
const KIND_RE = /(?:>|^|\s)([A-Za-z]+::[A-Za-z]+)\b/;

/** Kinds whose ranges carry visible glyphs we can align to a rendered run. */
const TEXT_KINDS = new Set([
  "Text",
  "MathText",
  "MathIdent",
  "Raw",
  "Str",
  "Shorthand",
  "SmartQuote",
]);

/**
 * Parse the `getAst` dump into an ordered list of text-bearing leaves.
 *
 * The dump is line-oriented; we read each line's last `Marked::Kind` token and
 * its `<L:C~L:C>` range (entities first un-escaped). We keep only `TEXT_KINDS`,
 * in file order, which is also document reading order for these leaves. Returns
 * `[]` on any shape we don't recognize.
 */
export function parseAstTextLeaves(
  astText: string | undefined | null,
  filePath?: string,
  sourceText?: string | null,
): AstTextLeaf[] {
  if (!astText || typeof astText !== "string") return [];
  // Pre-split the source text into lines once (O(file)) so each leaf's substring
  // can be sliced by its 1-based-line / 0-based-column range below. Absent source
  // → leaves carry no `text` and the aligner degrades to positional order.
  const sourceLines =
    typeof sourceText === "string" ? sourceText.split("\n") : null;
  const leaves: AstTextLeaf[] = [];
  for (const raw of astText.split("\n")) {
    const line = unescapeXml(raw);
    const km = KIND_RE.exec(line);
    if (!km) continue;
    const kindFull = km[1]!; // e.g. "Marked::Text"
    const kind = kindFull.includes("::") ? kindFull.split("::")[1]! : kindFull;
    if (!TEXT_KINDS.has(kind)) continue;
    const rm = RANGE_RE.exec(line);
    if (!rm) continue;
    const startLine = Number(rm[1]);
    const startCol = Number(rm[2]);
    const endLine = Number(rm[3]);
    const endCol = Number(rm[4]);
    if (![startLine, startCol, endLine, endCol].every(Number.isFinite))
      continue;
    const start = { line: startLine, column: startCol };
    const end = { line: endLine, column: endCol };
    const sliced = sourceLines
      ? sliceSourceRange(sourceLines, start, end)
      : undefined;
    leaves.push({
      kind,
      start,
      end,
      // Only attach the key when a path is supplied (exactOptionalPropertyTypes).
      ...(filePath ? { filePath } : {}),
      // Only carry `text` when we actually sliced something from the source.
      ...(sliced ? { text: sliced } : {}),
    });
  }
  return leaves;
}

/**
 * Slice the source substring covered by a leaf's `[start, end)` range and return
 * it whitespace-normalized for run-text matching (fix/preview-backlink).
 *
 * `start`/`end` are 1-based line, 0-based column (Typst's `getAst` convention).
 * For a multi-line range we join the spanned line fragments with a single space —
 * the rendered run's `tsel` text is itself whitespace-collapsed, and we compare
 * on the normalized form, so exact inter-line whitespace is irrelevant. Bounded:
 * touches only the spanned lines once, with a hard column/line clamp. Fail-soft:
 * an out-of-range or degenerate range yields an empty string (no throw).
 */
function sliceSourceRange(
  lines: string[],
  start: SourceLineCol,
  end: SourceLineCol,
): string {
  const sl = start.line - 1; // → 0-based array index
  const el = end.line - 1;
  if (sl < 0 || sl >= lines.length || el < sl) return "";
  let out: string;
  if (sl === el) {
    const row = lines[sl] ?? "";
    out = row.slice(start.column, end.column);
  } else {
    // Multi-line: head fragment + whole middle lines + tail fragment. Cap the
    // span so a corrupt range can't walk the whole file (bounded work).
    const lastLine = Math.min(el, lines.length - 1);
    const parts: string[] = [];
    parts.push((lines[sl] ?? "").slice(start.column));
    for (let i = sl + 1; i < lastLine; i++) parts.push(lines[i] ?? "");
    if (lastLine > sl) parts.push((lines[lastLine] ?? "").slice(0, end.column));
    out = parts.join(" ");
  }
  return normalizeRunText(out);
}

/**
 * Whitespace-normalize a string for leaf↔run text matching: collapse internal
 * runs of whitespace to a single space and trim. Both the AST slice and the SVG
 * `tsel` text pass through this so comparison is robust to the renderer's own
 * whitespace handling. Pure, linear in the string length.
 */
function normalizeRunText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Strip XML tags and decode entities to recover a `tsel` div's visible text. */
function textContent(fragment: string): string {
  return unescapeXml(fragment.replace(/<[^>]*>/g, "")).trim();
}

/**
 * Walk the SVG and return each rendered text run's page, document-space bbox,
 * and visible text, in document order.
 *
 * We scan the page tree with a lightweight tag tokenizer (no DOM): every `<g …>`
 * pushes its parsed `transform` onto a cumulative-matrix stack; a `</g>` pops it;
 * a `<typst-page>`-classed group bumps the page counter. When we reach a
 * `g.typst-text`, we read its nested `<foreignObject>` extent and compose the
 * current matrix to get the bbox in document (page-stack) space.
 *
 * Fail-soft: returns `[]` if the page tree can't be located or parsed.
 */
export function parseSvgTextRuns(svg: string | undefined | null): SvgTextRun[] {
  if (!svg || typeof svg !== "string") return [];
  const runs: SvgTextRun[] = [];
  // Matrix stack: index i is the cumulative transform after entering depth i.
  const stack: Affine[] = [IDENTITY];
  let page = -1;
  // We pre-split the page tree on tags but need to keep <g …> open/close and
  // foreignObject + tsel content. A single regex tokenizer over the whole SVG.
  const tokenRe = /<(\/?)(g|foreignObject)\b([^>]*?)(\/?)>|<\/foreignObject>/g;
  // To extract tsel text per run we also need the div content; capture it lazily
  // by slicing between a foreignObject open and close once we know we're in a run.
  let inText = false; // inside a g.typst-text
  let textDepth = -1; // g-depth at which the current typst-text started
  let depth = 0;
  let pendingRun: { rect: PreviewRect; page: number } | null = null;

  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(svg)) !== null) {
    const closing = m[1] === "/";
    const tag = m[2];
    const attrs = m[3] ?? "";
    const selfClose = m[4] === "/";

    if (tag === "g") {
      if (closing) {
        if (inText && depth === textDepth) {
          inText = false;
          textDepth = -1;
        }
        depth--;
        if (stack.length > 1) stack.pop();
        continue;
      }
      const transform = attr(attrs, "transform");
      const cur = stack[stack.length - 1] ?? IDENTITY;
      const next = compose(cur, parseTransform(transform));
      if (/class="typst-page"/.test(attrs)) {
        page++;
      }
      if (!selfClose) {
        stack.push(next);
        depth++;
      }
      if (/class="typst-text"/.test(attrs) && !inText) {
        inText = true;
        textDepth = selfClose ? depth + 1 : depth;
        // The run's bbox comes from its nested foreignObject extent composed with
        // this group's cumulative matrix; resolve it eagerly from the open tag.
        pendingRun = {
          rect: bboxFromMatrix(next, svg, m.index),
          page: Math.max(0, page),
        };
      }
    } else if (tag === "foreignObject" && !closing) {
      // Bbox is computed eagerly from the typst-text matrix; nothing to do here
      // beyond letting the run finalize when text is captured below.
      if (inText && pendingRun) {
        const text = extractTselText(svg, tokenRe.lastIndex);
        runs.push({ page: pendingRun.page, rect: pendingRun.rect, text });
        pendingRun = null;
      }
    }
  }
  return runs;
}

/** Read an attribute value out of a raw tag-attribute string. */
function attr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}="([^"]*)"`);
  const m = re.exec(attrs);
  return m ? m[1] : undefined;
}

/**
 * Compute a run's document-space bbox from its cumulative matrix and the nested
 * `foreignObject` extent. The renderer wraps the text in a `scale(16,-16)` group
 * then a `<foreignObject x y width height>`; we read those four numbers from the
 * SVG just after the typst-text open tag and map the rect corners through the
 * matrix (× the inner 16 scale). If anything is missing we fall back to a
 * zero-size box anchored at the matrix origin (still a usable scroll target).
 */
function bboxFromMatrix(
  matrix: Affine,
  svg: string,
  fromIndex: number,
): PreviewRect {
  // Find the first foreignObject within a small window after this g.typst-text.
  const window = svg.slice(fromIndex, fromIndex + 4000);
  const scaleM =
    /<g\s+transform="scale\(([-\d.]+),\s*([-\d.]+)\)"\s*>\s*<foreignObject\s+x="([-\d.]+)"\s+y="([-\d.]+)"\s+width="([-\d.]+)"\s+height="([-\d.]+)"/.exec(
      window,
    );
  const [ox, oy] = apply(matrix, 0, 0);
  if (!scaleM) {
    return { x: ox, y: oy, width: 0, height: 0 };
  }
  const sx = Number(scaleM[1]);
  const sy = Number(scaleM[2]);
  const fx = Number(scaleM[3]);
  const fy = Number(scaleM[4]);
  const fw = Number(scaleM[5]);
  const fh = Number(scaleM[6]);
  if (![sx, sy, fx, fy, fw, fh].every(Number.isFinite)) {
    return { x: ox, y: oy, width: 0, height: 0 };
  }
  // The foreignObject lives under an extra scale(sx,sy); fold it into the matrix.
  const inner = compose(matrix, [sx, 0, 0, sy, 0, 0]);
  const corners: [number, number][] = [
    apply(inner, fx, fy),
    apply(inner, fx + fw, fy),
    apply(inner, fx, fy + fh),
    apply(inner, fx + fw, fy + fh),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}

/** Pull the `tsel` div's visible text from just after a foreignObject open tag. */
function extractTselText(svg: string, fromIndex: number): string {
  const close = svg.indexOf("</foreignObject>", fromIndex);
  if (close < 0) return "";
  return textContent(svg.slice(fromIndex, close));
}

/** Length of a source range's text, in characters, ignoring line wraps. */
function rangeLength(start: SourceLineCol, end: SourceLineCol): number {
  if (end.line !== start.line) return Number.POSITIVE_INFINITY; // multi-line: don't gate
  return Math.max(0, end.column - start.column);
}

/**
 * Build the forward source→preview index by aligning AST text leaves with SVG
 * text runs in document order. The two streams are produced in the same reading
 * order, so a positional zip is the first-cut alignment (memo route (b)). A light
 * length check (source range length vs `tsel` glyph count) guards against drift:
 * when they diverge wildly we still emit the entry (best-effort) but the check is
 * available to callers/tests reasoning about quality.
 *
 * fix/preview-backlink: when the active file's `sourceText` is supplied, each
 * leaf's source substring is matched against the rendered run's visible text so a
 * GENERATED run (ToC, numbering, numbered citations, bibliography) is SKIPPED
 * rather than shifting every later pairing by one. Without `sourceText` the older
 * positional behavior is preserved (no regression for callers that don't pass it).
 *
 * Fail-soft: any missing/empty input yields an empty map (`entries: []`), which a
 * consumer treats as "no index available".
 */
export function buildPreviewSourceMap(
  astText: string | undefined | null,
  svg: string | undefined | null,
  pages: { widthPt: number; heightPt: number }[] = [],
  sourceText?: string | null,
): PreviewSourceMap {
  return alignLeavesToRuns(
    parseAstTextLeaves(astText, undefined, sourceText),
    parseSvgTextRuns(svg),
    pages,
  );
}

/**
 * Multi-file variant of {@link buildPreviewSourceMap} (B14 — reverse navigation
 * across files). Given the `getAst` dump of EVERY relevant project file (each
 * paired with its in-project path), parse and tag each file's text leaves with
 * its `filePath`, concatenate them in the given order, and zip them positionally
 * against the rendered SVG's text runs (the SVG combines all files into one
 * document, so its runs are not file-tagged — the leaf carries the file origin).
 *
 * The caller orders `sources` so the streams line up as closely as possible
 * (conventionally the main file first, then the rest in a stable order).
 *
 * fix/preview-backlink: when each source carries its `sourceText`, the aligner is
 * text-anchored — it matches each leaf's source substring against the rendered
 * run's visible text and SKIPS generated runs, so drift can no longer accumulate
 * and CROSS FILE BOUNDARIES (the reported bug: clicking one paper's body resolved
 * into another file). Without `sourceText` the older positional alignment stands.
 * Fully fail-soft: an empty input yields an empty map, and `filePath` is simply
 * absent on entries from a source given without a path (preserving the legacy
 * "active file" assumption).
 */
/**
 * Reorder project files into DOCUMENT reading order by following the `#include`
 * chain from the main file (fix/preview-backref). The anchored aligner pairs the
 * concatenated leaf stream against the document-ordered SVG runs, so the leaves
 * MUST be concatenated in document order or the cross-file backbone scrambles
 * (clicks resolve into the wrong file / whole `#include`d files drop out). The
 * project's own file list is in arbitrary order (creation / alphabetical), so we
 * can't rely on it: instead DFS the `include "<path>"` statements (typst markup
 * `#include` and code-mode `include` both end in that token), in source order,
 * which reconstructs the order content actually renders in.
 *
 * Robust + bounded: each file is visited once (cycle-safe), include targets are
 * resolved absolute-or-relative-to-the-including-file, and any file never reached
 * by an include (e.g. an unreferenced draft, a `.bib`) is appended in input order.
 * Pure; on any unexpected shape it degrades to "main first, then input order".
 */
export function orderFilesByDocumentOrder<
  T extends { path: string; text?: string | null },
>(mainPath: string, files: T[]): T[] {
  const canon = (p: string) => (p.startsWith("/") ? p : `/${p}`);
  const byPath = new Map<string, T>();
  for (const f of files) if (!byPath.has(canon(f.path))) byPath.set(canon(f.path), f);

  const resolve = (from: string, inc: string): string => {
    if (inc.startsWith("/")) return canon(inc);
    const dir = from.slice(0, from.lastIndexOf("/") + 1);
    const stack: string[] = [];
    for (const seg of (dir + inc).split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") stack.pop();
      else stack.push(seg);
    }
    return `/${stack.join("/")}`;
  };

  const visited = new Set<string>();
  const order: T[] = [];
  const incRe = /\binclude\s+"([^"]+)"/g;
  const visit = (path: string): void => {
    const p = canon(path);
    if (visited.has(p)) return;
    visited.add(p);
    const f = byPath.get(p);
    if (!f) return;
    order.push(f);
    const text = typeof f.text === "string" ? f.text : "";
    const incs: string[] = [];
    incRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = incRe.exec(text)) !== null) incs.push(m[1]!);
    for (const inc of incs) visit(resolve(p, inc));
  };
  visit(canon(mainPath));
  for (const f of files) {
    const p = canon(f.path);
    if (!visited.has(p)) {
      visited.add(p);
      order.push(f);
    }
  }
  return order;
}

export function buildProjectPreviewSourceMap(
  sources: {
    astText: string | undefined | null;
    filePath?: string;
    sourceText?: string | null;
  }[],
  svg: string | undefined | null,
  pages: { widthPt: number; heightPt: number }[] = [],
): PreviewSourceMap {
  const leaves: AstTextLeaf[] = [];
  for (const src of sources) {
    for (const leaf of parseAstTextLeaves(
      src.astText,
      src.filePath,
      src.sourceText,
    )) {
      leaves.push(leaf);
    }
  }
  return alignLeavesToRuns(leaves, parseSvgTextRuns(svg), pages);
}

/**
 * Shortest leaf/run text (normalized chars) eligible to seed an ANCHOR. Below
 * this, text is too common (single glyphs, `:`, `—`, digits) to disambiguate, so
 * it is left to the local densify pass and never used as a backbone anchor.
 */
const MIN_ANCHOR_LEN = 6;

/**
 * Cap on candidate runs considered per leaf when building anchors. Bounds the
 * worst case (a leaf whose prefix bucket is huge) so the whole alignment stays
 * near-linear — honoring the SEC-22.2 DoS posture (no O(leaves·runs) scan).
 */
const MAX_CANDIDATES_PER_LEAF = 16;

/**
 * Align an ordered list of AST text leaves with an ordered list of SVG text runs
 * into the forward index, shared by the single-file and multi-file builders.
 *
 * fix/preview-backref — ANCHORED alignment. The earlier two-cursor "resync"
 * derailed catastrophically on real multi-file documents: the `#outline` table of
 * contents renders every heading's TEXT again (on its own early page), and that
 * ToC run prefix-matches the REAL heading leaf, so the leaf was consumed at the
 * ToC's location and the cursors desynced for the rest of the document (whole
 * `#include`d files dropped, pages left uncovered). We instead pick a globally
 * consistent backbone:
 *  1. Build candidate (leaf, run) pairs for DISTINCTIVE text (≥ {@link
 *     MIN_ANCHOR_LEN}), via a first-prefix bucket so the scan is bounded.
 *  2. Take the maximum-WEIGHT strictly-increasing (in both leaf AND run index)
 *     subsequence of those pairs — a weighted LIS via a Fenwick tree. Weighting by
 *     matched length makes the dense body win over the sparse ToC: choosing a ToC
 *     heading early would forfeit all the body anchors that share lower leaf
 *     indices, so the global optimum maps each heading to its BODY occurrence.
 *  3. Densify: between consecutive anchors, pair leftover leaves to leftover runs
 *     in order with the local text matcher — bounded to the anchor window so it
 *     can never re-derail.
 * When NO leaf carries `text` (no source supplied) the legacy positional zip is
 * kept verbatim, so callers that don't thread source text see no change.
 * Complexity: O((|leaves|+|runs|)·MAX_CANDIDATES_PER_LEAF + P·log|runs|), bounded.
 * Carries each leaf's optional `filePath` onto its entry. Fail-soft throughout.
 */
function alignLeavesToRuns(
  leaves: AstTextLeaf[],
  runs: SvgTextRun[],
  pages: { widthPt: number; heightPt: number }[],
): PreviewSourceMap {
  const entries: PreviewSourceEntry[] = [];
  const push = (leaf: AstTextLeaf, run: SvgTextRun) => {
    entries.push({
      start: leaf.start,
      end: leaf.end,
      page: run.page,
      rect: run.rect,
      // exactOptionalPropertyTypes: only carry a path when the leaf had one.
      ...(leaf.filePath ? { filePath: leaf.filePath } : {}),
    });
  };

  // Legacy path: no leaf carries source text → blind positional zip (byte-for-byte
  // the historical behavior for callers that don't thread `sourceText`).
  const anyText = leaves.some((l) => l.text !== undefined);
  if (!anyText) {
    const n = Math.min(leaves.length, runs.length);
    for (let k = 0; k < n; k++) push(leaves[k]!, runs[k]!);
    return finalize(entries, pages);
  }

  // Pre-normalize both streams once.
  const lt = leaves.map((l) => l.text ?? "");
  const rt = runs.map((r) => normalizeRunText(r.text));

  // Bucket runs by their first MIN_ANCHOR_LEN chars: any prefix relation between a
  // leaf and a run (either direction) implies a shared leading slice of that length.
  const runBucket = new Map<string, number[]>();
  for (let j = 0; j < runs.length; j++) {
    const t = rt[j]!;
    if (t.length < MIN_ANCHOR_LEN) continue;
    const key = t.slice(0, MIN_ANCHOR_LEN);
    const arr = runBucket.get(key);
    if (arr) arr.push(j);
    else runBucket.set(key, [j]);
  }

  // Candidate anchor pairs (distinctive, prefix-compatible).
  const pairs: { i: number; j: number; w: number }[] = [];
  for (let i = 0; i < leaves.length; i++) {
    const a = lt[i]!;
    if (a.length < MIN_ANCHOR_LEN) continue;
    const bucket = runBucket.get(a.slice(0, MIN_ANCHOR_LEN));
    if (!bucket) continue;
    let taken = 0;
    for (const j of bucket) {
      const b = rt[j]!;
      if (textMatches(a, b)) {
        pairs.push({ i, j, w: Math.min(a.length, b.length) });
        if (++taken >= MAX_CANDIDATES_PER_LEAF) break;
      }
    }
  }

  // Max-weight strictly-increasing (i AND j) subsequence — weighted LIS via a
  // Fenwick tree keyed by run index. Process pairs by i asc, ties j DESC, so two
  // pairs sharing an i can never both be chosen (the j-prefix query is strict).
  pairs.sort((p, q) => (p.i !== q.i ? p.i - q.i : q.j - p.j));
  const chain = weightedLis(pairs, runs.length);

  // Emit anchors + densify the gaps between them in order.
  let pi = 0;
  let pj = 0;
  const densify = (iEnd: number, jEnd: number) => {
    let li = pi;
    let rj = pj;
    while (li < iEnd && rj < jEnd) {
      const a = lt[li]!;
      if (a.length === 0 || leaves[li]!.text === undefined) {
        li++;
        continue;
      }
      const b = rt[rj]!;
      if (textMatches(a, b)) {
        push(leaves[li]!, runs[rj]!);
        li++;
        rj++;
      } else {
        rj++; // generated run between anchors → skip
      }
    }
  };
  for (const p of chain) {
    densify(p.i, p.j);
    push(leaves[p.i]!, runs[p.j]!);
    pi = p.i + 1;
    pj = p.j + 1;
  }
  densify(leaves.length, runs.length); // tail after the last anchor

  return finalize(entries, pages);
}

/**
 * Maximum-weight subsequence of `pairs` (pre-sorted i asc / j desc) that strictly
 * increases in both `i` and `j`. A Fenwick (BIT) over run index holds, for every
 * prefix of run indices, the best achievable score and its terminating pair, so
 * each pair's best predecessor is a single O(log R) prefix-max query. Returns the
 * chosen pairs in increasing (i, j) order. O(P · log R).
 */
function weightedLis(
  pairs: { i: number; j: number; w: number }[],
  runCount: number,
): { i: number; j: number }[] {
  const size = runCount + 1;
  const treeScore = new Array<number>(size + 1).fill(0);
  const treeIdx = new Array<number>(size + 1).fill(-1);
  const prev = new Array<number>(pairs.length).fill(-1);
  const score = new Array<number>(pairs.length).fill(0);
  // Prefix-max query over run indices [0, pos].
  const query = (pos: number): { s: number; idx: number } => {
    let s = 0;
    let idx = -1;
    for (let x = pos + 1; x > 0; x -= x & -x) {
      if (treeScore[x]! > s) {
        s = treeScore[x]!;
        idx = treeIdx[x]!;
      }
    }
    return { s, idx };
  };
  // Point-update: keep the best score (and pair) for prefixes covering run `pos`.
  const update = (pos: number, s: number, pairIdx: number) => {
    for (let x = pos + 1; x <= size; x += x & -x) {
      if (s > treeScore[x]!) {
        treeScore[x] = s;
        treeIdx[x] = pairIdx;
      }
    }
  };
  let bestScore = -1;
  let bestIdx = -1;
  for (let k = 0; k < pairs.length; k++) {
    const { j, w } = pairs[k]!;
    const best = query(j - 1); // strictly smaller run index
    score[k] = best.s + w;
    prev[k] = best.idx;
    update(j, score[k]!, k);
    if (score[k]! > bestScore) {
      bestScore = score[k]!;
      bestIdx = k;
    }
  }
  const out: { i: number; j: number }[] = [];
  for (let k = bestIdx; k >= 0; k = prev[k]!) out.push({ i: pairs[k]!.i, j: pairs[k]!.j });
  out.reverse();
  return out;
}

/**
 * Sort entries by source position (line, then column) and pack with `pages` —
 * the shared tail of every alignment path. Entries from different files can share
 * line numbers, which is fine: inverse lookups are geometry-driven and `filePath`
 * disambiguates intent.
 */
function finalize(
  entries: PreviewSourceEntry[],
  pages: { widthPt: number; heightPt: number }[],
): PreviewSourceMap {
  entries.sort((a, b) =>
    a.start.line !== b.start.line
      ? a.start.line - b.start.line
      : a.start.column - b.start.column,
  );
  return { entries, pages };
}

/**
 * Does a leaf's normalized source text match a rendered run's normalized text?
 * The renderer may break one source leaf across multiple runs (line wrapping) or
 * merge adjacent leaves into one run, so we accept a prefix/containment relation
 * in EITHER direction rather than strict equality — enough to anchor alignment
 * without over-rejecting. Both inputs are already whitespace-normalized; the
 * checks are linear in string length (no regex, no backtracking).
 */
function textMatches(leafText: string, runText: string): boolean {
  if (leafText.length === 0 || runText.length === 0) return false;
  if (leafText === runText) return true;
  // One contains the other (wrapped leaf → shorter run; merged runs → longer run).
  return leafText.startsWith(runText) || runText.startsWith(leafText);
}

/** Is `pos` within `[start, end)` (inclusive start, exclusive end)? */
function contains(
  start: SourceLineCol,
  end: SourceLineCol,
  pos: SourceLineCol,
): boolean {
  const afterStart =
    pos.line > start.line ||
    (pos.line === start.line && pos.column >= start.column);
  const beforeEnd =
    pos.line < end.line || (pos.line === end.line && pos.column < end.column);
  return afterStart && beforeEnd;
}

/** Absolute distance from a position to a range (0 when inside). */
function distanceTo(
  start: SourceLineCol,
  end: SourceLineCol,
  pos: SourceLineCol,
): number {
  if (contains(start, end, pos)) return 0;
  // Compare on a synthetic (line * BIG + column) scalar; line dominates.
  const BIG = 1e6;
  const p = pos.line * BIG + pos.column;
  const s = start.line * BIG + start.column;
  const e = end.line * BIG + end.column;
  if (p < s) return s - p;
  return p - e;
}

/**
 * Find the rendered region for a cursor position. Returns the entry whose source
 * range contains `pos`, else the nearest entry by source distance, else
 * `undefined` (empty map). Pure; safe to call on every cursor move.
 */
export function lookupPreviewRegion(
  map: PreviewSourceMap | undefined,
  pos: SourceLineCol,
): PreviewSourceEntry | undefined {
  if (!map || map.entries.length === 0) return undefined;
  let best: PreviewSourceEntry | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const entry of map.entries) {
    const d = distanceTo(entry.start, entry.end, pos);
    if (d < bestDist) {
      bestDist = d;
      best = entry;
      if (d === 0) break; // exact containment wins immediately
    }
  }
  return best;
}

/** A point in document (page-stack) space, in Typst points — the same space as
 * a {@link PreviewRect}. The inverse lookup consumes this. */
export interface PreviewPoint {
  x: number;
  y: number;
}

/** Squared distance from a point to a rect (0 when the point is inside it). */
function pointRectDistSq(rect: PreviewRect, point: PreviewPoint): number {
  // Clamp the point onto the rect; the residual is the closest-edge distance.
  const dx =
    point.x < rect.x
      ? rect.x - point.x
      : point.x > rect.x + rect.width
        ? point.x - (rect.x + rect.width)
        : 0;
  const dy =
    point.y < rect.y
      ? rect.y - point.y
      : point.y > rect.y + rect.height
        ? point.y - (rect.y + rect.height)
        : 0;
  return dx * dx + dy * dy;
}

/** Does `rect` enclose `point` (inclusive on all edges)? */
function rectContains(rect: PreviewRect, point: PreviewPoint): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * Inverse sync (#11.3): map a point in the rendered page's document space back to
 * a source position. Given a `point` in SVG user-space (the same coordinate space
 * as each entry's `rect`), find the entry whose region encloses the point and
 * return its source start as a {@link SourceLineCol}.
 *
 * Resolution policy (documented, by design):
 *  - If one or more entry rects ENCLOSE the point, return the start of the one
 *    with the smallest area (the tightest / innermost run wins — robust when a
 *    line's runs overlap or a zero-size box nests inside a larger one).
 *  - If none encloses it, fall back to the NEAREST entry by squared edge distance
 *    (best-effort; the E4 memo accepts coarse results on footnotes/floats). To
 *    avoid jumping across the whole page from a click in true whitespace, the
 *    nearest fallback only applies within `maxGapPt` of an entry (default 24pt,
 *    ~a line height); a click in a wide gap returns `null`.
 *
 * Pure and fail-soft: a missing/empty map or a point in a gap returns `null`.
 *
 * B14: when the resolved entry carries a `filePath` (multi-file source map), it
 * is attached to the returned position so the caller can switch to the right
 * file before jumping. Single-file maps have no `filePath`, so the result is a
 * bare {@link SourceLineCol} exactly as before.
 */
export function lookupSourceAtPoint(
  map: PreviewSourceMap | undefined,
  point: PreviewPoint,
  maxGapPt = 24,
): SourcePositionWithFile | null {
  if (!map || map.entries.length === 0) return null;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;

  let enclosing: PreviewSourceEntry | undefined;
  let enclosingArea = Number.POSITIVE_INFINITY;
  let nearest: PreviewSourceEntry | undefined;
  let nearestDistSq = Number.POSITIVE_INFINITY;

  for (const entry of map.entries) {
    if (rectContains(entry.rect, point)) {
      const area = entry.rect.width * entry.rect.height;
      // Strictly smaller area wins; ties keep the first (document order).
      if (area < enclosingArea) {
        enclosingArea = area;
        enclosing = entry;
      }
    }
    const d = pointRectDistSq(entry.rect, point);
    if (d < nearestDistSq) {
      nearestDistSq = d;
      nearest = entry;
    }
  }

  if (enclosing) return positionWithFile(enclosing);
  if (nearest && nearestDistSq <= maxGapPt * maxGapPt)
    return positionWithFile(nearest);
  return null;
}

/**
 * A resolved source position with the optional originating file (B14). The
 * `filePath` is present only for entries from a multi-file source map; absent
 * → the caller treats it as the currently active file (legacy behavior).
 */
export type SourcePositionWithFile = SourceLineCol & { filePath?: string };

/** Project an entry to its source start, carrying `filePath` only when present. */
function positionWithFile(entry: PreviewSourceEntry): SourcePositionWithFile {
  return entry.filePath
    ? { ...entry.start, filePath: entry.filePath }
    : { ...entry.start };
}

/** Re-export the soft alignment metric for tests/quality reasoning. */
export { rangeLength };
