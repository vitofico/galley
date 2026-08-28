/**
 * Roadmap #17.1: reference-library import — PURE, offline, framework-free.
 *
 * Galley's `@`-cite source is fed from a real reference library. Users export
 * that library from Zotero/Mendeley/EndNote as either BibTeX or RIS. The BibTeX
 * path already exists (citation.ts `parseBibtex` + bibliography.ts
 * `parseBibliography`); this module ADDS a RIS parser and a single
 * `importReferences` entry point that:
 *   1. detects the format (RIS by a leading `TY  - ` tag, else BibTeX),
 *   2. parses to `CitationEntry[]`,
 *   3. de-duplicates (DOI, else title+year; first occurrence wins) via
 *      `dedupeEntries` — so the SAME work exported in both formats collapses,
 *   4. assigns STABLE, globally-unique keys (provided key preserved, else
 *      `makeCiteKey` derives `<family><year>` and self-suffixes on collision),
 *      mirroring bibliography.ts's keying contract exactly.
 *
 * HONESTY: RIS is a flat tag stream; we map only the common, well-understood
 * tags (see `RIS_TAG_MAP`) and DROP everything else (notes, abstracts, keywords,
 * vendor-specific tags) rather than guess. `countRisRecords` exposes how many
 * `TY..ER` records were seen so a caller can report "parsed N of M".
 */
import {
  type CitationEntry,
  type BibtexParseStats,
  parseBibtex,
  dedupeEntries,
  makeCiteKey,
  nextDeterministicKey,
} from "./citation.js";

export type ImportFormat = "bibtex" | "ris" | "auto";

// ---------------------------------------------------------------------------
// RIS parsing
// ---------------------------------------------------------------------------

// A RIS line is `<TAG><two spaces>- <value>` where TAG is two uppercase
// alphanumerics. Reference managers are sloppy about the exact spacing, so we
// accept any run of spaces around the dash.
const RIS_LINE_RE = /^([A-Z][A-Z0-9])\s{1,}-\s?(.*)$/;
// A record opens with a TY line and closes with an ER line.
const RIS_TY_RE = /^TY\s{1,}-\s?/m;

// Map RIS reference types onto our internal (BibTeX-flavoured) type vocabulary.
// Anything unlisted falls back to "article" — the common-denominator default.
const RIS_TYPE_MAP: Record<string, string> = {
  JOUR: "article",
  EJOUR: "article",
  BOOK: "book",
  EBOOK: "book",
  CHAP: "inbook",
  ECHAP: "inbook",
  CONF: "inproceedings",
  CPAPER: "inproceedings",
  RPRT: "techreport",
  THES: "phdthesis",
  GEN: "misc",
  ELEC: "web",
  WEB: "web",
  DATA: "misc",
  UNPB: "unpublished",
};

// Map the RIS tags we understand onto CitationEntry fields. Multi-valued tags
// (authors) and the date/page tags are handled specially below; everything else
// is a last-write-wins scalar. Tags NOT in this map are deliberately dropped.
//
// Mapped tags:
//   TI, T1        → title
//   AU, A1, A2…   → author (accumulated)
//   PY, Y1        → year (4-digit run extracted)
//   DO            → doi
//   JO, JF, J2,
//   T2, T3        → journal / container
//   PB            → publisher
//   VL            → volume
//   IS            → number (issue)
//   SP, EP        → pages (joined SP--EP)
//   UR            → url
//   ED, E1…E3     → editor (accumulated) — see RIS_EDITOR_TAGS note below
//   AB, N2        → abstract (scalar; AB wins, N2 fills)
const RIS_SCALAR_MAP: Record<string, keyof CitationEntry> = {
  TI: "title",
  T1: "title",
  DO: "doi",
  JO: "journal",
  JF: "journal",
  J2: "journal",
  T2: "journal",
  T3: "journal",
  PB: "publisher",
  VL: "volume",
  IS: "number",
  UR: "url",
  AB: "abstract",
  N2: "abstract",
};
const RIS_AUTHOR_TAGS = new Set(["AU", "A1", "A2", "A3", "A4"]);
// G7 — DEDICATED editor tags only. `ED` is the canonical RIS editor tag; some
// managers emit `E1`/`E2`/`E3` as numbered editors. We deliberately do NOT treat
// `A2`/`A3` as editors: although the RIS spec loosely overloads them as
// "secondary/tertiary author" (often editors of a containing work), real exports
// from Zotero/EndNote routinely put genuine co-AUTHORS in `A2`/`A3`. Reclassifying
// them would silently demote primary authors and regress the existing
// RIS_AUTHOR_TAGS behavior, so they stay as additional authors (the SAFE call).
const RIS_EDITOR_TAGS = new Set(["ED", "E1", "E2", "E3"]);
const RIS_YEAR_TAGS = new Set(["PY", "Y1", "DA"]);

interface RisAccumulator {
  entry: CitationEntry;
  authors: string[];
  editors: string[];
  startPage?: string;
  endPage?: string;
}

/** Finalize an in-progress record into a CitationEntry (authors + pages joined). */
function finishRecord(acc: RisAccumulator): CitationEntry {
  const e = acc.entry;
  if (acc.authors.length > 0) e.author = acc.authors;
  if (acc.editors.length > 0) e.editor = acc.editors;
  if (acc.startPage || acc.endPage) {
    e.pages = acc.startPage && acc.endPage
      ? `${acc.startPage}--${acc.endPage}`
      : (acc.startPage ?? acc.endPage)!;
  }
  return e;
}

/**
 * Parse a (possibly multi-record) RIS string into CitationEntry[]. Records run
 * from a `TY  - <type>` line to the next `ER  -` line. Tags outside the mapped
 * set are dropped. Keys are left empty (caller assigns). Pure; tolerant of junk
 * (returns `[]` when no record opens).
 */
export function parseRis(src: string): CitationEntry[] {
  if (typeof src !== "string" || src.trim().length === 0) return [];
  const out: CitationEntry[] = [];
  let acc: RisAccumulator | null = null;

  for (const rawLine of src.split(/\r\n|\r|\n/)) {
    const m = rawLine.match(RIS_LINE_RE);
    if (!m) continue;
    const tag = m[1]!;
    const value = m[2]!.trim();

    if (tag === "TY") {
      // A new record opens; if one was unterminated, still emit it.
      if (acc) out.push(finishRecord(acc));
      acc = {
        entry: { key: "", type: RIS_TYPE_MAP[value] ?? "article" },
        authors: [],
        editors: [],
      };
      continue;
    }
    if (tag === "ER") {
      if (acc) out.push(finishRecord(acc));
      acc = null;
      continue;
    }
    if (!acc) continue; // tags before any TY are ignored

    if (RIS_AUTHOR_TAGS.has(tag)) {
      if (value.length > 0) acc.authors.push(value);
      continue;
    }
    if (RIS_EDITOR_TAGS.has(tag)) {
      if (value.length > 0) acc.editors.push(value);
      continue;
    }
    if (RIS_YEAR_TAGS.has(tag)) {
      const y = value.match(/\d{4}/);
      if (y && !acc.entry.year) acc.entry.year = y[0];
      continue;
    }
    if (tag === "SP") {
      if (value.length > 0) acc.startPage = value;
      continue;
    }
    if (tag === "EP") {
      if (value.length > 0) acc.endPage = value;
      continue;
    }
    const target = RIS_SCALAR_MAP[tag];
    if (target && value.length > 0) {
      // Do not overwrite an already-set container from a higher-priority tag
      // (e.g. JO before a later T3). First mapped value wins per field.
      if (acc.entry[target] === undefined) {
        (acc.entry as unknown as Record<string, unknown>)[target] = value;
      }
    }
  }
  // Unterminated trailing record (no closing ER).
  if (acc) out.push(finishRecord(acc));
  return out;
}

/**
 * Count the RIS records (TY lines) in a source string — the HONEST denominator
 * for "parsed N of M". A record is any `TY  - ` line; malformed records still
 * count so the caller can see the gap between seen and successfully mapped.
 */
export function countRisRecords(src: string): number {
  if (typeof src !== "string") return 0;
  let count = 0;
  for (const line of src.split(/\r\n|\r|\n/)) {
    if (/^TY\s{1,}-/.test(line)) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Format detection + unified import
// ---------------------------------------------------------------------------

// The BibTeX opener shape (`@type{`), mirroring citation.ts's detection — used
// only to ORDER the two formats' first occurrence in `detectImportFormat`.
const BIBTEX_OPEN_RE = /@[a-zA-Z]+\s*\{/;

/**
 * Detect the library format. RIS is recognized by a `TY  - ` tag line anywhere
 * before the first BibTeX `@type{` (a leading TY is the canonical RIS opener);
 * otherwise we assume BibTeX. Pure.
 *
 * Real-corpus fix: the original test was `RIS_TY_RE.test(src)` alone, so a TY
 * line ANYWHERE flipped a BibTeX-first paste to RIS and silently dropped every
 * BibTeX entry. Now the doc contract above is what actually runs: whichever
 * format's opener appears FIRST wins.
 */
export function detectImportFormat(src: string): "bibtex" | "ris" {
  const ty = RIS_TY_RE.exec(src);
  if (ty === null) return "bibtex";
  const bib = BIBTEX_OPEN_RE.exec(src);
  return bib === null || ty.index < bib.index ? "ris" : "bibtex";
}

/** The detailed result of a unified import — entries plus honest provenance. */
export interface ImportReferencesResult {
  /** Ordered, de-duplicated, collision-free entries (see `importReferences`). */
  entries: CitationEntry[];
  /** The format whose parse PRODUCED `entries`. */
  format: "bibtex" | "ris";
  /**
   * Present when auto-detection chose a format that parsed to ZERO entries
   * while the OTHER format parsed at least one — e.g. a malformed BibTeX
   * opener ahead of a valid RIS block. The import falls back rather than
   * silently losing the library, and this note says so for the UI summary.
   */
  fallbackNote?: string;
  /**
   * HONEST count of entry-starts SEEN in the source (the "M" in "parsed N of M").
   * For BibTeX this is the number of bibliographic `@type{` openers (directives
   * excluded); for RIS the number of `TY` records. `parsedCount + malformedCount`.
   */
  totalCount: number;
  /** Of `totalCount`, how many parsed successfully (the "N"). */
  parsedCount: number;
  /**
   * Of `totalCount`, how many were skipped because they were malformed (e.g. a
   * BibTeX entry whose braces never balanced — G4 resync). 0 means a clean import;
   * the UI hides the "(k skipped)" note in that case (behavior unchanged).
   */
  malformedCount: number;
}

/** Dedupe + stable keying shared by both import entry points. Pure. */
function keyEntries(parsed: CitationEntry[]): CitationEntry[] {
  const deduped = dedupeEntries(parsed);
  const used = new Set<string>();
  // base→next-suffix-index cache: O(n) batch keying on all-colliding input
  // instead of O(n²) (#22.2); shared across the provided/generated key paths.
  const hints = new Map<string, number>();
  const out: CitationEntry[] = [];
  for (const entry of deduped) {
    const provided = entry.key?.trim() ?? "";
    const key =
      provided.length > 0
        ? nextDeterministicKey(provided, used, hints)
        : makeCiteKey(entry, used, hints);
    used.add(key);
    out.push({ ...entry, key });
  }
  return out;
}

/**
 * `importReferences` plus honest provenance: which format actually produced the
 * entries, and whether the import FELL BACK because the auto-detected format
 * parsed to zero entries while the other one held the library (a malformed
 * first opener can defeat first-opener-wins detection — the entries themselves
 * must not be lost silently). Fallback applies in `"auto"` mode ONLY: a forced
 * format is honored even when it parses to nothing. Pure.
 *
 * (The reverse fallback — detected-RIS recovering as BibTeX — is structurally
 * unreachable today: any `TY  - ` line that triggers RIS detection also opens a
 * RIS record, so a RIS parse of RIS-detected input is never empty. The branch
 * is symmetric anyway so the invariant lives in code, not in an assumption.)
 */
export function importReferencesDetailed(
  text: string,
  format: ImportFormat = "auto",
): ImportReferencesResult {
  if (typeof text !== "string" || text.trim().length === 0) {
    return {
      entries: [],
      format: format === "ris" ? "ris" : "bibtex",
      totalCount: 0,
      parsedCount: 0,
      malformedCount: 0,
    };
  }

  // Parse the CHOSEN format, capturing honest counts. For BibTeX the `stats`
  // out-param tallies bibliographic entry-starts vs successfully-parsed (the G4
  // resync skips malformed ones); for RIS the seen count is the TY-record count
  // and `parseRis` emits one entry per record (so malformed is 0 today).
  const parseChosen = (fmt: "bibtex" | "ris"): { entries: CitationEntry[]; total: number; malformed: number } => {
    if (fmt === "ris") {
      const entries = parseRis(text);
      return { entries, total: countRisRecords(text), malformed: 0 };
    }
    const stats: BibtexParseStats = { total: 0, parsed: 0, malformed: 0 };
    const entries = parseBibtex(text, stats);
    return { entries, total: stats.total, malformed: stats.malformed };
  };

  const chosen = format === "auto" ? detectImportFormat(text) : format;
  let result = parseChosen(chosen);
  let used: "bibtex" | "ris" = chosen;
  let fallbackNote: string | undefined;

  if (format === "auto" && result.entries.length === 0) {
    const other: "bibtex" | "ris" = chosen === "ris" ? "bibtex" : "ris";
    const reparsed = parseChosen(other);
    if (reparsed.entries.length > 0) {
      result = reparsed;
      used = other;
      fallbackNote = `the input looked like ${chosen} but parsed to zero entries; imported as ${other} instead`;
    }
  }

  const entries = keyEntries(result.entries);
  const counts = {
    totalCount: result.total,
    parsedCount: result.total - result.malformed,
    malformedCount: result.malformed,
  };
  return fallbackNote === undefined
    ? { entries, format: used, ...counts }
    : { entries, format: used, fallbackNote, ...counts };
}

/**
 * Import a reference library (BibTeX or RIS) into an ordered, de-duplicated list
 * of citations, each with a STABLE, globally-unique `key`. `format` selects the
 * parser; `"auto"` detects by first opener (see `detectImportFormat`) and falls
 * back to the other format when the detected one parses to zero entries —
 * `importReferencesDetailed` additionally REPORTS that fallback.
 *
 * Dedupe (DOI, else title+year; first wins) runs AFTER parsing, so the same work
 * exported in both formats and concatenated will collapse. Keying mirrors
 * bibliography.ts exactly: a provided key is preserved (suffixed on collision),
 * an empty key is derived via `makeCiteKey`. Robust to junk/empty (returns `[]`).
 * Pure — fresh entry objects, inputs untouched.
 */
export function importReferences(text: string, format: ImportFormat = "auto"): CitationEntry[] {
  return importReferencesDetailed(text, format).entries;
}
