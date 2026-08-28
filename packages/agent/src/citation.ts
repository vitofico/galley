/**
 * Citation ergonomics core (roadmap #6) — PURE, offline, framework-free.
 *
 * Hayagriva is Typst's native bibliography format (a YAML mapping of cite-key →
 * entry). The crux of this slice is NOT the UI: it is making cite-KEYS that are
 * STABLE and deterministic across runs, and DEDUPING entries that arrive from
 * different sources (DOI, URL, pasted BibTeX). Everything here is a pure function
 * of its inputs — no React, no DOM, no global `fetch`.
 *
 * The single network path (`fetchCitation`) mirrors the package-registry posture
 * (package-resolver.ts): the capability is behind an INJECTED `fetch`, never the
 * global, and it FAILS CLOSED (throws a typed error) on a non-OK response. That
 * makes it offline-testable with a fake fetch and keeps the seam auditable.
 */

/** What kind of thing a user pasted into the "add citation" box. */
export type CitationInputKind = "doi" | "url" | "bibtex" | "unknown";

/**
 * A normalized citation. Field set is intentionally a common-denominator subset
 * that BibTeX, Crossref, and Hayagriva all express; unknown source fields are
 * dropped rather than guessed.
 */
export interface CitationEntry {
  /** Stable Hayagriva mapping key (see `makeCiteKey`). May be empty until keyed. */
  key: string;
  /** Entry type, lowercased (article, book, inproceedings, web, …). */
  type: string;
  title?: string;
  /** Authors as "Family, Given" strings (BibTeX/Hayagriva convention). */
  author?: string[];
  /** Editors as "Family, Given" strings (same shape as `author`). G7. */
  editor?: string[];
  /** Free-text abstract/summary (scalar). G7. */
  abstract?: string;
  /** 4-digit year as a string (avoids number/locale ambiguity). */
  year?: string;
  doi?: string;
  url?: string;
  journal?: string;
  publisher?: string;
  volume?: string;
  number?: string;
  pages?: string;
  /**
   * BibTeX `crossref` parent key (G5-crossref). Transient: used by `parseBibtex`
   * to do one-level field inheritance, then it is NOT emitted by `toHayagriva`
   * (it is not a bibliographic field, just a pointer). Lowercased compare on use.
   */
  crossref?: string;
}

/** Thrown by `fetchCitation` on any failure (fail-closed network path). */
export class CitationFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CitationFetchError";
  }
}

// ---------------------------------------------------------------------------
// Input classification
// ---------------------------------------------------------------------------

// A DOI is "10." followed by a registrant code and a slash + suffix. We accept an
// optional doi:/https://doi.org/ prefix and validate the bare core strictly.
const DOI_CORE_RE = /^10\.\d{4,9}\/\S+$/;
const DOI_PREFIX_RE = /^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)/i;
const HTTP_URL_RE = /^https?:\/\/\S+$/i;
// A BibTeX entry opens with `@type{` (citekey optional in our detection).
const BIBTEX_OPEN_RE = /@[a-zA-Z]+\s*\{/;

/** Strip a `doi:`/`https://doi.org/` wrapper, returning the bare DOI core. */
function bareDoi(input: string): string {
  return input.trim().replace(DOI_PREFIX_RE, "");
}

/**
 * Classify a pasted string. Order matters: a `https://doi.org/10.…` URL is a DOI
 * (the more specific, more useful kind), a `@article{…}` blob is BibTeX, any
 * other http(s) string is a plain URL, everything else is unknown.
 */
export function detectInputKind(input: string): CitationInputKind {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "unknown";
  if (DOI_CORE_RE.test(bareDoi(trimmed))) return "doi";
  if (BIBTEX_OPEN_RE.test(trimmed)) return "bibtex";
  if (HTTP_URL_RE.test(trimmed)) return "url";
  return "unknown";
}

// ---------------------------------------------------------------------------
// BibTeX parsing (common fields; one or more entries)
// ---------------------------------------------------------------------------

// Map common BibTeX field names onto CitationEntry fields. Anything not listed is
// ignored (we keep the common denominator rather than carry arbitrary fields).
const BIBTEX_FIELD_MAP: Record<string, keyof CitationEntry> = {
  title: "title",
  year: "year",
  doi: "doi",
  url: "url",
  journal: "journal",
  booktitle: "journal",
  publisher: "publisher",
  volume: "volume",
  number: "number",
  pages: "pages",
  abstract: "abstract",
};

// G5-accents: common TeX accent commands → the base letter they decorate. The
// accent char is the map KEY (`"` for the umlaut `\"`, `'` for the acute `\'`,
// etc.); the value maps each supported base letter to its precomposed Unicode
// codepoint. A letter not present for a given accent is left to fall through
// (the accent command is then simply removed and the bare letter kept).
const ACCENT_MAP: Record<string, Record<string, string>> = {
  // \"o umlaut / diaeresis
  '"': { a: "ä", e: "ë", i: "ï", o: "ö", u: "ü", y: "ÿ", A: "Ä", E: "Ë", I: "Ï", O: "Ö", U: "Ü", Y: "Ÿ" },
  // \'e acute
  "'": { a: "á", e: "é", i: "í", o: "ó", u: "ú", y: "ý", c: "ć", n: "ń", s: "ś", z: "ź", A: "Á", E: "É", I: "Í", O: "Ó", U: "Ú", Y: "Ý", C: "Ć", N: "Ń", S: "Ś", Z: "Ź" },
  // \`a grave
  "`": { a: "à", e: "è", i: "ì", o: "ò", u: "ù", A: "À", E: "È", I: "Ì", O: "Ò", U: "Ù" },
  // \^o circumflex
  "^": { a: "â", e: "ê", i: "î", o: "ô", u: "û", A: "Â", E: "Ê", I: "Î", O: "Ô", U: "Û" },
  // \~n tilde
  "~": { a: "ã", n: "ñ", o: "õ", A: "Ã", N: "Ñ", O: "Õ" },
  // \=o macron
  "=": { a: "ā", e: "ē", i: "ī", o: "ō", u: "ū", A: "Ā", E: "Ē", I: "Ī", O: "Ō", U: "Ū" },
  // \.x over-dot
  ".": { e: "ė", z: "ż", I: "İ", E: "Ė", Z: "Ż" },
  // \u{s} breve
  u: { a: "ă", e: "ĕ", g: "ğ", i: "ĭ", o: "ŏ", u: "ŭ", A: "Ă", E: "Ĕ", G: "Ğ", O: "Ŏ", U: "Ŭ" },
  // \v{s} caron / háček
  v: { c: "č", e: "ě", n: "ň", r: "ř", s: "š", z: "ž", C: "Č", E: "Ě", N: "Ň", R: "Ř", S: "Š", Z: "Ž" },
  // \c{c} cedilla
  c: { c: "ç", s: "ş", C: "Ç", S: "Ş" },
  // \H{o} double acute
  H: { o: "ő", u: "ű", O: "Ő", U: "Ű" },
  // \k{a} ogonek
  k: { a: "ą", e: "ę", A: "Ą", E: "Ę" },
  // \r{a} ring
  r: { a: "å", u: "ů", A: "Å", U: "Ů" },
};

// Special standalone letter commands (no argument): `\ss` → ß etc. Mapped whole.
const SPECIAL_LETTER_MAP: Record<string, string> = {
  ss: "ß", o: "ø", O: "Ø", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ",
  l: "ł", L: "Ł", aa: "å", AA: "Å", i: "ı", j: "ȷ",
  dh: "ð", DH: "Ð", th: "þ", TH: "Þ", ng: "ŋ", NG: "Ŋ",
};

// One linear-scan alternation covering EVERY supported accent form. Each branch
// is anchored at a literal `\`, matches a BOUNDED, NON-OVERLAPPING shape, and is
// applied in a SINGLE global `.replace` pass (O(n), no rescanning, no
// iterate-to-stable). A crafted value of tens of thousands of `\"` runs is
// matched left-to-right exactly once, so cost is strictly linear in length.
//
//  group layout (mutually exclusive — at most one set per match):
//   1: single-char accent op (one of "'`^~=.) ; 2: its braced letter ; 3: its bare letter
//   4: word accent op (u v c H k r) ; 5: its braced letter ; 6: its bare letter
//   7: special letter command (ss/o/ae/…), word-boundaried so it can't eat a longer name
const ACCENT_RE =
  /\\(["'`^~=.])(?:\{([A-Za-z])\}|\s*([A-Za-z]))|\\([uvcHkr])(?:\{([A-Za-z])\}|\s+([A-Za-z]))|\\(ss|AE|ae|OE|oe|AA|aa|DH|dh|TH|th|NG|ng|O|o|L|l|i|j)(?![A-Za-z])/g;

/**
 * Fold the common LaTeX accent escapes in a BibTeX field value to precomposed
 * Unicode (e.g. `{\"o}`→ö, `\'e`→é, `\v{s}`→š, `{\ss}`→ß). PURE.
 *
 * SECURITY/PERF (wave-4 SEC-22.2): this is a SINGLE linear `.replace` pass over
 * a fixed, non-overlapping alternation — no per-accent rescan, no
 * iterate-until-stable loop, and every branch matches a bounded shape, so a
 * hostile value (e.g. tens of thousands of `\"` runs) stays O(n). The result is
 * still handed to the existing brace-strip + whitespace-collapse, so no new
 * Typst/YAML injection surface is introduced (the downstream `yamlScalar`
 * emitter already quotes any value that is not a trivially safe plain scalar).
 *
 * Unmapped combinations (an accent over a letter we don't carry, e.g. `\"q`)
 * degrade gracefully: the accent command is dropped and the bare letter kept,
 * which is strictly better than leaving the raw `\"q` escape in the value.
 */
export function foldLatexAccents(s: string): string {
  if (s.indexOf("\\") === -1) return s; // fast path: no escapes at all
  return s.replace(
    ACCENT_RE,
    (
      _m,
      op1: string | undefined,
      braced1: string | undefined,
      bare1: string | undefined,
      op2: string | undefined,
      braced2: string | undefined,
      bare2: string | undefined,
      special: string | undefined,
    ): string => {
      if (special !== undefined) return SPECIAL_LETTER_MAP[special] ?? special;
      const op = op1 ?? op2;
      const letter = braced1 ?? bare1 ?? braced2 ?? bare2;
      if (op === undefined || letter === undefined) return _m;
      return ACCENT_MAP[op]?.[letter] ?? letter;
    },
  );
}

/** Collapse internal whitespace/newlines and strip the outer {…} or "…" wrapper. */
function cleanBibtexValue(raw: string): string {
  let v = raw.trim();
  // Outer wrapper may be {…} or "…"; remove one matched layer.
  if ((v.startsWith("{") && v.endsWith("}")) || (v.startsWith('"') && v.endsWith('"'))) {
    v = v.slice(1, -1);
  }
  // G5-accents: decode TeX accent escapes to Unicode BEFORE the brace strip
  // below destroys them ({\"o}→{ö}→ö). Linear, single pass — see foldLatexAccents.
  v = foldLatexAccents(v);
  // BibTeX uses {} for protecting case; drop the braces but keep their content.
  v = v.replace(/[{}]/g, "");
  return v.replace(/\s+/g, " ").trim();
}

/**
 * Resolve a single BibTeX value EXPRESSION to its cleaned string, expanding
 * `@string` macros (G5-@string). A value expression is either one literal
 * ({braced} / "quoted" / bareword) OR a `#`-separated concatenation of those
 * (the BibTeX concat operator), e.g. `"Proc. " # conf # " 2020"`.
 *
 * SECURITY/PERF (wave-4 SEC-22.2): expansion is a SINGLE NON-RECURSIVE pass.
 * Each bareword token is looked up ONCE in `macros`; the looked-up value is taken
 * VERBATIM and is NEVER re-scanned for further macros. That makes a cyclic
 * definition (`a = b`, `b = a`) terminate immediately — there is no
 * iterate-to-stable loop and no recursion — and keeps cost strictly linear in the
 * field-value length regardless of how many macros exist. An unknown bareword
 * fails OPEN to its own literal text (never throws). The concatenated result is
 * still handed to `cleanBibtexValue` by the caller, so the existing accent-fold +
 * brace-strip + YAML-quoting hardening runs and no new injection surface opens.
 */
function expandValueExpr(expr: string, macros?: Map<string, string>): string {
  const trimmed = expr.trim();
  // Fast path: a value with no `#` AND that is a single braced/quoted literal is
  // returned as-is for the caller's existing cleaner (byte-identical to before).
  // We only diverge from the old behavior for barewords and `#`-concatenations.
  const tokens = splitConcatTokens(trimmed);
  if (tokens.length === 1) {
    const t = tokens[0]!.trim();
    if (isBracedOrQuoted(t)) return t; // literal — unchanged path
    // bareword: a macro reference (or, if unknown, its own literal text).
    return resolveMacro(t, macros);
  }
  // `#`-concatenation: unwrap each segment to its plain text, then join. We must
  // PRESERVE each segment's internal/edge whitespace (e.g. `"Proc. "` keeps its
  // trailing space) so the concatenation reads correctly — so braced/quoted
  // segments are unwrapped via `unwrapLiteral` (wrapper + accents + braces, NO
  // trim/collapse), NOT `cleanBibtexValue`. Barewords resolve once against the map.
  // The caller's final `cleanBibtexValue` does the single trim/collapse of the join.
  let out = "";
  for (const raw of tokens) {
    const t = raw.trim();
    if (t.length === 0) continue;
    if (isBracedOrQuoted(t)) out += unwrapLiteral(t);
    else out += resolveMacro(t, macros);
  }
  return out;
}

/**
 * Strip ONE matched {…}/"…" wrapper and decode accents + case-protecting braces,
 * but PRESERVE internal whitespace (no trim/collapse). Used for `#`-concat
 * segments where edge spaces are significant; the joined result is collapsed once
 * by the caller's `cleanBibtexValue`. Mirrors that function's transforms minus the
 * whitespace normalization, so the same accent/brace hardening still runs.
 */
function unwrapLiteral(t: string): string {
  let v = t;
  if ((v.startsWith("{") && v.endsWith("}")) || (v.startsWith('"') && v.endsWith('"'))) {
    v = v.slice(1, -1);
  }
  v = foldLatexAccents(v);
  return v.replace(/[{}]/g, "");
}

/** True when a value token is wrapped in matched {…} or "…". */
function isBracedOrQuoted(t: string): boolean {
  return (
    (t.startsWith("{") && t.endsWith("}")) || (t.startsWith('"') && t.endsWith('"'))
  );
}

/**
 * Look up ONE bareword against the macro map (case-insensitive per BibTeX). On a
 * hit, return the stored macro value VERBATIM — NO re-expansion at substitution
 * time. (Macro values were already flattened against EARLIER defs when collected,
 * which is forward-only and cycle-free by construction, so a single lookup here is
 * sufficient and can never loop.) On a miss, fail open to the bareword's own text.
 */
function resolveMacro(bare: string, macros?: Map<string, string>): string {
  if (!macros) return bare;
  const hit = macros.get(bare.toLowerCase());
  return hit !== undefined ? hit : bare;
}

/**
 * Split a value expression on the top-level `#` concat operator, respecting
 * {brace} nesting and "quoted" spans so a `#` inside a literal is not a split
 * point. SINGLE linear pass over the expression — no backtracking. Returns the
 * raw (untrimmed) segments; the caller trims/cleans each.
 */
function splitConcatTokens(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inQuote = false;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inQuote) {
      if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"' && depth === 0) inQuote = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      if (depth > 0) depth--;
    } else if (ch === "#" && depth === 0) {
      out.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  out.push(expr.slice(start));
  return out;
}

/** Split a BibTeX `author` value ("A and B and C") into "Family, Given" parts. */
function splitBibtexAuthors(raw: string): string[] {
  return raw
    .split(/\s+and\s+/i)
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

/**
 * Read the brace-balanced body of one `@type{ … }` entry starting at `openIdx`
 * (the index of the `{`). Returns the inner text and the index just past the
 * closing brace, or null if unbalanced WITHIN `[openIdx, limit)`.
 *
 * `limit` (default end-of-string) bounds the scan so a malformed entry is never
 * re-scanned across the whole library: `parseBibtex` passes the start of the NEXT
 * plausible entry as the limit, so each entry is visited at most once overall —
 * the resync stays LINEAR (no quadratic backtracking; wave-4 SEC-22.2). Field-body
 * scanning (`parseEntryBody`) passes no limit, keeping its existing behavior.
 */
function readEntryBody(
  src: string,
  openIdx: number,
  limit: number = src.length,
): { body: string; end: number } | null {
  let depth = 0;
  for (let i = openIdx; i < limit; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { body: src.slice(openIdx + 1, i), end: i + 1 };
    }
  }
  return null;
}

/**
 * Find the start of the next plausible BibTeX entry at/after `from` — a `@` that
 * begins a line (preceded by a newline or the string start), the canonical entry
 * opener. Used as both the resync target after a malformed entry AND the scan
 * ceiling for the preceding (possibly malformed) entry's brace balance, so the
 * recovery never re-traverses a region it has already passed (LINEAR resync).
 * Returns `src.length` when no further line-initial `@` exists.
 */
function nextEntryStart(src: string, from: number): number {
  let idx = src.indexOf("@", from);
  while (idx !== -1) {
    // Line-initial: the @ is at string start or the char before it is a newline.
    if (idx === 0 || src[idx - 1] === "\n" || src[idx - 1] === "\r") return idx;
    idx = src.indexOf("@", idx + 1);
  }
  return src.length;
}

/**
 * Parse the `key, field = value, …` body of a single entry into a partial entry.
 *
 * `macros` (optional) is the per-parse `@string` map (G5-@string): a field whose
 * value is a bareword (or a `#`-concatenation) is expanded against it via
 * `expandValueExpr` before the existing cleaning runs. Omitted ⇒ macros are not
 * expanded (barewords stay literal), so every existing caller is byte-for-byte
 * unchanged.
 */
function parseEntryBody(
  type: string,
  body: string,
  macros?: Map<string, string>,
): CitationEntry {
  // First comma separates the citekey from the field list.
  const firstComma = body.indexOf(",");
  const citekey = (firstComma === -1 ? body : body.slice(0, firstComma)).trim();
  const fieldsText = firstComma === -1 ? "" : body.slice(firstComma + 1);

  const entry: CitationEntry = { key: citekey, type: type.toLowerCase() };

  let i = 0;
  const n = fieldsText.length;
  while (i < n) {
    // Read a field name up to '='.
    const eq = fieldsText.indexOf("=", i);
    if (eq === -1) break;
    const name = fieldsText.slice(i, eq).trim().toLowerCase().replace(/^,/, "").trim();
    // Read the value EXPRESSION: a single {balanced}/"quoted"/bareword literal OR
    // a `#`-concatenation of them. We scan to the next TOP-LEVEL comma (one not
    // inside braces or quotes), so a `#`-concat spanning a quoted comma is read
    // whole. SINGLE linear pass — `readEntryBody` handles brace balance, an inline
    // quote/bareword scan handles the rest; no region is re-traversed.
    let j = eq + 1;
    while (j < n && /\s/.test(fieldsText[j]!)) j++;
    const valueStart = j;
    let k = j;
    let depth = 0;
    let inQuote = false;
    let bracesBalanced = true;
    while (k < n) {
      const ch = fieldsText[k];
      if (inQuote) {
        // Inside a top-level "quoted" span: only a closing quote ends it. (A `"`
        // only delimits at brace-depth 0, so we enter quote-mode only there.)
        if (ch === '"') inQuote = false;
      } else if (ch === '"' && depth === 0) {
        inQuote = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        if (depth > 0) depth--;
      } else if (ch === "," && depth === 0) {
        break;
      }
      k++;
    }
    // A value whose braces never balanced (depth>0 at the comma/EOF) is malformed;
    // the old reader bailed (`break`) on an unbalanced brace value — preserve that.
    if (depth > 0) bracesBalanced = false;
    const rawValue = fieldsText.slice(valueStart, k);
    i = k + 1;
    if (!bracesBalanced) break;

    // Expand `@string` macros / `#`-concat to plain text, THEN run the existing
    // cleaner (accent fold + brace strip). For a single braced/quoted literal this
    // is byte-identical to the old `cleanBibtexValue(rawValue)` path.
    const expanded = expandValueExpr(rawValue, macros);

    if (name === "author" || name === "editor") {
      // editor uses the IDENTICAL name-splitting code path as author (G7).
      const names = splitBibtexAuthors(cleanBibtexValue(expanded));
      if (names.length > 0) entry[name] = names;
      continue;
    }
    if (name === "crossref") {
      // G5-crossref: record the parent key (cleaned, e.g. brace-stripped) for the
      // one-level inheritance pass in `parseBibtex`. Not a bibliographic field.
      const ref = cleanBibtexValue(expanded);
      if (ref.length > 0) entry.crossref = ref;
      continue;
    }
    const target = BIBTEX_FIELD_MAP[name];
    if (target) {
      const value = cleanBibtexValue(expanded);
      if (value.length > 0) {
        // year: keep only a 4-digit run if present.
        if (target === "year") {
          const m = value.match(/\d{4}/);
          if (m) (entry as unknown as Record<string, unknown>)[target] = m[0];
        } else {
          (entry as unknown as Record<string, unknown>)[target] = value;
        }
      }
    }
  }
  return entry;
}

/**
 * Optional, additive parse statistics for `parseBibtex` — the HONEST denominator
 * behind a "parsed N of M (k skipped)" import summary. Counts only BIBLIOGRAPHIC
 * `@type{` starts (`@comment`/`@string`/`@preamble` directives are excluded, they
 * are not entries). `malformed === total - parsed` always. The object is MUTATED
 * in place; `parseBibtex`'s return value (a `CitationEntry[]`) is unchanged, so
 * every existing one-arg caller is unaffected.
 */
export interface BibtexParseStats {
  /** Bibliographic `@type{` entry-starts seen (excludes comment/string/preamble). */
  total: number;
  /** Of those, how many balanced + parsed successfully. */
  parsed: number;
  /** Of those, how many were skipped because their braces never balanced. */
  malformed: number;
}

/**
 * Parse one or more BibTeX entries from a source string. Tolerant of surrounding
 * text and `@comment`/`@string` noise (those are skipped). Pure (modulo the
 * optional `stats` out-param, which is only written, never read).
 *
 * RESYNC (G4): a malformed entry whose braces never balance no longer stops the
 * whole parse — it is skipped and parsing resumes at the next line-initial `@…{`.
 * The scan stays LINEAR: each (possibly broken) entry's brace balance is bounded
 * by the start of the next entry (`nextEntryStart`), so no region is re-traversed
 * and a library of N broken openers is O(total length), not O(N · length).
 */
export function parseBibtex(src: string, stats?: BibtexParseStats): CitationEntry[] {
  const out: CitationEntry[] = [];
  // G5-@string: macro table collected DURING the single scan below (no second
  // pass). Name is lowercased (BibTeX macro names are case-insensitive); value is
  // already run through the standard cleaner so substitution emits clean text.
  const macros = new Map<string, string>();
  const at = /@([a-zA-Z]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = at.exec(src)) !== null) {
    const type = m[1]!.toLowerCase();
    const openIdx = src.indexOf("{", m.index);
    if (openIdx === -1) break;
    // The next line-initial `@…{` bounds this entry's brace scan AND is where we
    // resync to if it turns out malformed — one pass, no overlap (linear).
    const ceiling = nextEntryStart(src, openIdx + 1);
    const isDirective = type === "comment" || type === "string" || type === "preamble";
    const read = readEntryBody(src, openIdx, ceiling);
    if (!read) {
      // Malformed: braces never balanced before the next entry / EOF. Count it
      // (bibliographic entries only) and resync to the next plausible start
      // instead of breaking — the rest of the library is no longer swallowed.
      if (!isDirective && stats) {
        stats.total++;
        stats.malformed++;
      }
      if (ceiling >= src.length) break;
      at.lastIndex = ceiling;
      continue;
    }
    if (type === "string") {
      // G5-@string: record `name = value` for later field substitution. This rides
      // the SAME linear scan — one extra branch, no re-traversal of the source.
      collectStringMacro(read.body, macros);
    } else if (!isDirective) {
      out.push(parseEntryBody(type, read.body, macros));
      if (stats) {
        stats.total++;
        stats.parsed++;
      }
    }
    at.lastIndex = read.end;
  }
  // G5-crossref: one-level, best-effort field inheritance over the parsed entries.
  inheritCrossref(out);
  return out;
}

/**
 * Parse a single `@string{ name = value }` body into the macro map (G5-@string).
 * The body is `name = value` (value is {braced}, "quoted", or — rarely — a
 * `#`-concatenation of earlier macros). We resolve the value through
 * `expandValueExpr` (so `@string{ x = a # b }` works against macros defined
 * EARLIER in the file) + the standard cleaner, and store it under the LOWERCASED
 * name. A later redefinition overwrites an earlier one (last wins, BibTeX-like).
 * Malformed bodies (no `=`) are ignored. PURE w.r.t. the source; mutates `macros`.
 */
function collectStringMacro(body: string, macros: Map<string, string>): void {
  const eq = body.indexOf("=");
  if (eq === -1) return;
  const name = body.slice(0, eq).trim().toLowerCase();
  if (name.length === 0) return;
  // The value may end with the entry's closing context; trim and resolve. Pass the
  // macros collected SO FAR — substitution is still single-pass and non-recursive
  // (a self-reference resolves to the prior definition or its own literal).
  const value = cleanBibtexValue(expandValueExpr(body.slice(eq + 1), macros));
  macros.set(name, value);
}

/**
 * Best-effort, ONE-LEVEL `crossref` field inheritance (G5-crossref). For any entry
 * carrying a `crossref` pointer to a parent KEY, fill ONLY the child's MISSING
 * common-denominator fields from that parent. Pure-ish: mutates `entries` in place
 * (they were just constructed here).
 *
 * SECURITY/PERF (wave-4 SEC-22.2): a SINGLE O(n) pass builds a key→entry index
 * (case-insensitive), a SINGLE O(n) pass snapshots each entry's OWN field set, then
 * a SINGLE O(n) pass fills children from the parent's SNAPSHOT via O(1) Map
 * lookups. Filling from the snapshot — the parent's fields BEFORE any inheritance —
 * makes "one level" ORDER-INDEPENDENT: a parent that itself has a `crossref` cannot
 * pass its OWN inherited (grandparent) fields down, so there are no chains, no
 * cycles to guard, and no quadratic chasing. A missing/self/unknown parent is a
 * no-op. `crossref` itself is not emitted by `toHayagriva`, so nothing leaks.
 */
function inheritCrossref(entries: CitationEntry[]): void {
  // Fast exit: no crossref anywhere ⇒ skip both extra passes entirely.
  let anyCrossref = false;
  for (const e of entries) {
    if (e.crossref) {
      anyCrossref = true;
      break;
    }
  }
  if (!anyCrossref) return;

  // Build the parent index (last definition of a key wins, mirroring how a
  // reference manager resolves a crossref target by key).
  const byKey = new Map<string, CitationEntry>();
  for (const e of entries) {
    if (e.key) byKey.set(e.key.toLowerCase(), e);
  }
  // Fields eligible for inheritance: the scalar + array common-denominator set.
  const FIELDS: (keyof CitationEntry)[] = [
    "title", "author", "editor", "abstract", "year", "doi", "url",
    "journal", "publisher", "volume", "number", "pages",
  ];
  // Snapshot each entry's OWN fields BEFORE any filling, so inheritance reads only
  // a parent's intrinsic fields (never its own inherited ones) — one level, exact,
  // regardless of array order.
  const own = new Map<CitationEntry, Partial<Record<keyof CitationEntry, unknown>>>();
  for (const e of entries) {
    const snap: Partial<Record<keyof CitationEntry, unknown>> = {};
    for (const f of FIELDS) if (e[f] !== undefined) snap[f] = e[f];
    own.set(e, snap);
  }
  for (const child of entries) {
    const ref = child.crossref;
    if (!ref) continue;
    const parent = byKey.get(ref.toLowerCase());
    // Self-reference or missing parent: leave the child untouched (best-effort).
    if (!parent || parent === child) continue;
    const parentOwn = own.get(parent)!;
    for (const f of FIELDS) {
      if (child[f] === undefined && parentOwn[f] !== undefined) {
        // Copy the parent's OWN (already-expanded/cleaned) value. Arrays are shared
        // by reference — safe: entries are never mutated in place downstream.
        (child as unknown as Record<string, unknown>)[f] = parentOwn[f];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Cite-key generation (the crux): stable, deterministic, collision-suffixed
// ---------------------------------------------------------------------------

// Minimal, dependency-free ASCII folding for the Latin-1/Latin Extended-A ranges
// that dominate author names. Anything outside is dropped after folding.
const FOLD_MAP: Record<string, string> = {
  à: "a", á: "a", â: "a", ã: "a", ä: "a", å: "a", ā: "a", ă: "a", ą: "a",
  ç: "c", ć: "c", č: "c",
  è: "e", é: "e", ê: "e", ë: "e", ē: "e", ė: "e", ę: "e", ě: "e",
  ì: "i", í: "i", î: "i", ï: "i", ī: "i", į: "i",
  ñ: "n", ń: "n", ň: "n",
  ò: "o", ó: "o", ô: "o", õ: "o", ö: "o", ø: "o", ō: "o", ő: "o",
  ù: "u", ú: "u", û: "u", ü: "u", ū: "u", ů: "u", ű: "u",
  ý: "y", ÿ: "y",
  ß: "ss",
  ž: "z", ź: "z", ż: "z",
  ł: "l", đ: "d", þ: "th", æ: "ae", œ: "oe",
};

/** Fold accents to ASCII (NFD-then-strip-combining, plus a small fallback map). */
function asciiFold(s: string): string {
  let normalized = s;
  // Decompose + strip combining marks where the runtime supports it.
  try {
    normalized = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
  } catch {
    normalized = s;
  }
  let out = "";
  for (const ch of normalized) {
    const lower = ch.toLowerCase();
    if (FOLD_MAP[lower]) out += FOLD_MAP[lower];
    else out += ch;
  }
  return out;
}

/**
 * Extract a family (last) name from a single author string. Handles both BibTeX
 * "Family, Given" and plain "Given Family" forms.
 */
function familyName(author: string): string {
  const trimmed = author.trim();
  if (trimmed.includes(",")) return trimmed.slice(0, trimmed.indexOf(",")).trim();
  const parts = trimmed.split(/\s+/);
  return parts.length > 0 ? parts[parts.length - 1]! : trimmed;
}

/** Lowercase ASCII slug of a name: fold accents, drop non-[a-z0-9]. */
function slug(s: string): string {
  return asciiFold(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Deterministic collision suffix sequence: "", "b", "c", … "z", "aa", "ab", …
 * (a 1-indexed base-26 sequence where index 0 yields the empty suffix). Stable
 * regardless of insertion timing — same index always yields the same suffix.
 */
function collisionSuffix(index: number): string {
  if (index <= 0) return "";
  // The base key is the implicit "a", so the FIRST collision is suffixed "b".
  // Treat index as a 0-based offset into the letter sequence STARTING at "b":
  // 1 -> "b" … 25 -> "z", 26 -> "aa" (bijective base-26 on n = index + 1).
  let n = index + 1; // 1-based, where 1 would be "a" (never emitted; index>=1)
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(97 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * Resolve a `base` key to the first non-colliding deterministic variant against
 * `existingKeys` (base, then base+"b", base+"c", …). Shared by every keyer
 * (`makeCiteKey` here, plus bibliography.ts / reference-import.ts) so a provided
 * key and a generated one suffix identically.
 *
 * `hints` (optional) makes this O(1) AMORTIZED instead of O(n) per call: it caches
 * the next suffix index to TRY for each base, so N entries sharing one base key
 * resolve in O(N) total rather than O(N²) (the search no longer restarts from the
 * base on every collision — a local-DoS path on a hostile library, #22.2). The
 * cache is only a starting hint: we still verify each candidate against
 * `existingKeys` and advance past any provided-key collision, so the keys produced
 * are byte-for-byte identical to the hint-less search. `existingKeys` is NOT
 * mutated (the caller owns insertion).
 */
export function nextDeterministicKey(
  base: string,
  existingKeys: Set<string>,
  hints?: Map<string, number>,
): string {
  let index = hints?.get(base) ?? 0;
  let candidate = index <= 0 ? base : `${base}${collisionSuffix(index)}`;
  while (existingKeys.has(candidate)) {
    index++;
    candidate = `${base}${collisionSuffix(index)}`;
  }
  // Remember where to resume for the next entry sharing this base. `index + 1`:
  // the chosen `candidate` will be inserted into `existingKeys` by the caller, so
  // the next search for this base can skip it.
  if (hints) hints.set(base, index + 1);
  return candidate;
}

/**
 * Build a STABLE, deterministic cite-key for an entry: `<family><year>`,
 * lowercased + ASCII-folded (e.g. "müller, 2019" → "muller2019"). Falls back to
 * the title's first word, then "ref", when author/year are missing. On collision
 * within `existingKeys`, append a deterministic suffix ("b", "c", …) — the base
 * key is the implicit "a". `existingKeys` is NOT mutated (caller owns it).
 *
 * Pass `hints` (a base→next-index Map threaded across a batch) to keep batch
 * keying O(n) on pathological all-colliding input; omit it for one-off calls.
 */
export function makeCiteKey(
  entry: CitationEntry,
  existingKeys: Set<string>,
  hints?: Map<string, number>,
): string {
  let base = "";
  if (entry.author && entry.author.length > 0) {
    base = slug(familyName(entry.author[0]!));
  }
  if (base.length === 0 && entry.title) {
    base = slug(entry.title.split(/\s+/)[0] ?? "");
  }
  if (base.length === 0) base = "ref";
  const year = entry.year && /\d{4}/.test(entry.year) ? entry.year.match(/\d{4}/)![0] : "";
  base = `${base}${year}`;

  return nextDeterministicKey(base, existingKeys, hints);
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

/** Normalize a DOI for comparison (lowercase, strip wrapper). Exported so the
 *  dedup module shares ONE identity definition (no drift). */
export function normDoi(doi: string): string {
  return bareDoi(doi).toLowerCase();
}

/** Normalize a title for fuzzy comparison: fold, lowercase, alnum-only.
 *  Exported so the dedup module shares ONE identity definition (no drift). */
export function normTitle(title: string): string {
  return asciiFold(title).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Collapse duplicate entries. Identity is DOI (when present, normalized);
 * otherwise normalized-title + year. Order-preserving: the FIRST occurrence wins.
 * Pure — returns a new array, inputs untouched.
 */
export function dedupeEntries(entries: CitationEntry[]): CitationEntry[] {
  const seen = new Set<string>();
  const out: CitationEntry[] = [];
  for (const e of entries) {
    let identity: string;
    if (e.doi && e.doi.trim().length > 0) {
      identity = `doi:${normDoi(e.doi)}`;
    } else if (e.title && e.title.trim().length > 0) {
      identity = `tt:${normTitle(e.title)}|${e.year ?? ""}`;
    } else {
      // No stable identity — never dedupe these against each other.
      out.push(e);
      continue;
    }
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hayagriva rendering
// ---------------------------------------------------------------------------

// Map our internal type onto Hayagriva entry types. Hayagriva's vocabulary
// differs from BibTeX; this covers the common cases and defaults conservatively.
const HAYAGRIVA_TYPE_MAP: Record<string, string> = {
  article: "article",
  inproceedings: "article",
  conference: "article",
  book: "book",
  inbook: "chapter",
  incollection: "chapter",
  techreport: "report",
  phdthesis: "thesis",
  mastersthesis: "thesis",
  misc: "misc",
  web: "web",
  online: "web",
  unpublished: "manuscript",
};

// A STRICT plain-scalar allowlist: starts alnum, then alnum/space/_/.//- only.
// Anything outside (colons, #, newlines, control chars, leading/odd specials,
// trailing space) is emitted quoted instead — we never try to partially detect
// "unsafe" plain scalars by hand (the source of YAML-injection bugs).
const PLAIN_SCALAR_RE = /^[A-Za-z0-9][A-Za-z0-9 _.\-]*$/;
// YAML 1.1 keywords / number-like values that LOOK like a plain scalar but parse
// as a non-string — these MUST be quoted to round-trip as the intended string.
const YAML_KEYWORD_RE = /^(?:true|false|null|yes|no|on|off|y|n|~)$/i;
const NUMBER_LIKE_RE = /^[+-]?(?:\d[\d_]*\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Render a value as a YAML scalar that round-trips to EXACTLY this string.
 * Emits a strict, unambiguous plain scalar only when it is trivially safe;
 * otherwise emits `JSON.stringify(value)` — a JSON string is a valid YAML
 * double-quoted flow scalar and correctly escapes `\`, `"`, newlines, tabs, and
 * C0 control chars, so no embedded content can break out into new YAML nodes.
 */
function yamlScalar(value: string): string {
  if (
    value.length > 0 &&
    PLAIN_SCALAR_RE.test(value) &&
    !YAML_KEYWORD_RE.test(value) &&
    !NUMBER_LIKE_RE.test(value)
  ) {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * Render a Hayagriva YAML block for an entry. The entry's `key` is the top-level
 * mapping key; remaining fields nest under it. Output is a valid standalone
 * Hayagriva document fragment (2-space indented). Pure.
 */
export function toHayagriva(entry: CitationEntry): string {
  // The cite key is the top-level mapping key. `makeCiteKey` yields safe keys,
  // but a RAW parsed BibTeX key is user-controlled, so emit it through the same
  // robust scalar emitter — an unsafe key gets double-quoted (a valid YAML
  // mapping key) rather than injecting new top-level keys.
  const key = entry.key && entry.key.length > 0 ? entry.key : "ref";
  const lines: string[] = [`${yamlScalar(key)}:`];
  const hayaType = HAYAGRIVA_TYPE_MAP[entry.type] ?? entry.type ?? "misc";
  lines.push(`  type: ${yamlScalar(hayaType)}`);
  if (entry.title) lines.push(`  title: ${yamlScalar(entry.title)}`);
  if (entry.author && entry.author.length > 0) {
    if (entry.author.length === 1) {
      lines.push(`  author: ${yamlScalar(entry.author[0]!)}`);
    } else {
      lines.push(`  author:`);
      for (const a of entry.author) lines.push(`    - ${yamlScalar(a)}`);
    }
  }
  if (entry.editor && entry.editor.length > 0) {
    // editor mirrors the author single/multi shape EXACTLY (G7).
    if (entry.editor.length === 1) {
      lines.push(`  editor: ${yamlScalar(entry.editor[0]!)}`);
    } else {
      lines.push(`  editor:`);
      for (const ed of entry.editor) lines.push(`    - ${yamlScalar(ed)}`);
    }
  }
  if (entry.year) lines.push(`  date: ${yamlScalar(entry.year)}`);
  // abstract: Hayagriva has a native `abstract` key (it carries it as a
  // formattable string). Emitted through the same hardened scalar emitter as
  // every other field, so no new YAML-injection surface (G7).
  if (entry.abstract) lines.push(`  abstract: ${yamlScalar(entry.abstract)}`);
  if (entry.journal) lines.push(`  parent: ${yamlScalar(entry.journal)}`);
  if (entry.publisher) lines.push(`  publisher: ${yamlScalar(entry.publisher)}`);
  if (entry.volume) lines.push(`  volume: ${yamlScalar(entry.volume)}`);
  if (entry.number) lines.push(`  issue: ${yamlScalar(entry.number)}`);
  if (entry.pages) lines.push(`  page-range: ${yamlScalar(entry.pages)}`);
  if (entry.doi) lines.push(`  serial-number:\n    doi: ${yamlScalar(normDoi(entry.doi))}`);
  if (entry.url) lines.push(`  url: ${yamlScalar(entry.url)}`);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Network path (injected fetch; fail-closed) — mirrors package-registry posture
// ---------------------------------------------------------------------------

/**
 * The JSON shape `fetchCitation` expects back from the resolver endpoint. This is
 * a Crossref-style envelope (`{ message: { … } }`) — the same shape the public
 * Crossref REST API returns for `https://api.crossref.org/works/<doi>`. We define
 * it explicitly here so the offline fake fetch can produce it verbatim.
 *
 * Fields consumed (all optional; missing fields are simply omitted from the
 * resulting entry):
 *   - DOI: string
 *   - title: string[]            (first element used)
 *   - author: [{ family, given }]
 *   - issued: { "date-parts": [[year, …]] }
 *   - type: string               (Crossref type, mapped to a CitationEntry type)
 *   - container-title: string[]  (journal/venue; first element used)
 *   - publisher, volume, issue, page, URL
 */
export interface CrossrefMessage {
  DOI?: string;
  URL?: string;
  title?: string[];
  "container-title"?: string[];
  author?: Array<{ family?: string; given?: string; name?: string }>;
  issued?: { "date-parts"?: number[][] };
  type?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  page?: string;
}

export interface CrossrefEnvelope {
  message?: CrossrefMessage;
}

// Crossref type vocabulary → our internal type.
const CROSSREF_TYPE_MAP: Record<string, string> = {
  "journal-article": "article",
  "proceedings-article": "inproceedings",
  book: "book",
  "book-chapter": "inbook",
  report: "techreport",
  dissertation: "phdthesis",
  "posted-content": "misc",
  dataset: "misc",
};

/** Build a "Family, Given" string from a Crossref author record. */
function crossrefAuthor(a: { family?: string; given?: string; name?: string }): string | null {
  if (a.family && a.given) return `${a.family}, ${a.given}`;
  if (a.family) return a.family;
  if (a.name) return a.name;
  return null;
}

/** Map a Crossref envelope to a CitationEntry (key left empty; caller assigns). */
export function crossrefToEntry(env: CrossrefEnvelope): CitationEntry {
  const msg = env.message ?? {};
  const entry: CitationEntry = {
    key: "",
    type: (msg.type && CROSSREF_TYPE_MAP[msg.type]) ?? "article",
  };
  if (msg.title && msg.title.length > 0 && msg.title[0]) entry.title = msg.title[0];
  if (msg.author && msg.author.length > 0) {
    const authors = msg.author.map(crossrefAuthor).filter((a): a is string => a !== null);
    if (authors.length > 0) entry.author = authors;
  }
  const parts = msg.issued?.["date-parts"]?.[0];
  if (parts && parts.length > 0 && typeof parts[0] === "number") {
    entry.year = String(parts[0]);
  }
  if (msg.DOI) entry.doi = msg.DOI;
  if (msg.URL) entry.url = msg.URL;
  if (msg["container-title"] && msg["container-title"][0]) entry.journal = msg["container-title"][0];
  if (msg.publisher) entry.publisher = msg.publisher;
  if (msg.volume) entry.volume = msg.volume;
  if (msg.issue) entry.number = msg.issue;
  if (msg.page) entry.pages = msg.page;
  return entry;
}

/** The Crossref REST endpoint for a single DOI. */
function crossrefUrl(doi: string): string {
  return `https://api.crossref.org/works/${encodeURIComponent(bareDoi(doi))}`;
}

/**
 * Resolve a DOI or URL to citation metadata via an INJECTED `fetch`. Never calls
 * the global fetch (mirrors the package-registry seam: the capability is passed
 * in, so it is auditable + offline-testable). FAILS CLOSED — throws
 * `CitationFetchError` on a non-OK response, a non-DOI input, or malformed JSON.
 *
 * The injected fetch is expected to return a Crossref-style envelope
 * (`{ message: { … } }`); see `CrossrefEnvelope`. A fake fetch in tests returns
 * that shape verbatim.
 */
export async function fetchCitation(
  input: string,
  opts: { fetch: typeof fetch },
): Promise<CitationEntry> {
  const kind = detectInputKind(input);
  if (kind !== "doi" && kind !== "url") {
    throw new CitationFetchError(`cannot fetch citation for ${kind} input`);
  }
  // For a URL we still resolve via Crossref's DOI endpoint only when it is a DOI
  // URL; a bare web URL has no metadata source in this seam, so fail closed.
  if (kind === "url" && !DOI_CORE_RE.test(bareDoi(input))) {
    throw new CitationFetchError("plain URL resolution is not supported by this seam");
  }
  const target = crossrefUrl(input);
  let res: Response;
  try {
    res = await opts.fetch(target, { headers: { accept: "application/json" } });
  } catch (err) {
    throw new CitationFetchError(`citation fetch failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new CitationFetchError(`citation fetch returned HTTP ${res.status}`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new CitationFetchError("citation response was not valid JSON");
  }
  // Guard the parsed shape so a null/non-object body can't throw a raw TypeError
  // out of crossrefToEntry — the seam must stay fail-closed with its typed error.
  if (typeof json !== "object" || json === null) {
    throw new CitationFetchError("citation response was not a JSON object");
  }
  const entry = crossrefToEntry(json as CrossrefEnvelope);
  if (!entry.title && (!entry.author || entry.author.length === 0)) {
    throw new CitationFetchError("citation response had no usable metadata");
  }
  return entry;
}
