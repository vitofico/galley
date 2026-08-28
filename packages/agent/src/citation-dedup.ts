/**
 * Citation library DEDUPLICATION (roadmap #6) — PURE, offline, framework-free.
 *
 * This is NOT import-time dedup (`dedupeEntries` in citation.ts already drops a
 * later duplicate on the way IN). This module operates on the user's CURRENT
 * bibliography: it DETECTS entries that already coexist in the library AND MERGES
 * each duplicate cluster into a single richer entry, coalescing data rather than
 * silently discarding the loser. It is user-initiated, preview-able, and applied
 * by the host as one undoable CRDT edit; nothing here touches React/DOM/network.
 *
 * Identity is decided EXACTLY as `dedupeEntries` decides it (so detection here and
 * dedupe-on-import never disagree): a normalized DOI when present, else a
 * normalized title + year. Entries with neither a DOI nor a title have no stable
 * identity and are never grouped. The normalization is `citation.ts`'s own
 * `normDoi`/`normTitle` (imported, not re-derived) so identity can never drift —
 * see `identityOf`.
 */
import {
  type CitationEntry,
  parseBibtex,
  normDoi,
  normTitle,
} from "./citation.js";

// Identity normalization shares ONE definition with citation.ts (`normDoi` /
// `normTitle`, imported above) so grouping here can never drift from how
// `dedupeEntries` decides identity. `identityOf` composes them below.

/**
 * The stable IDENTITY of an entry, or null when it has none. Matches
 * `dedupeEntries`: DOI (when present, normalized) wins; otherwise normalized
 * title + year. An entry with neither a DOI nor a title cannot be grouped.
 */
function identityOf(e: CitationEntry): string | null {
  if (e.doi && e.doi.trim().length > 0) return `doi:${normDoi(e.doi)}`;
  if (e.title && e.title.trim().length > 0) return `tt:${normTitle(e.title)}|${e.year ?? ""}`;
  return null;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Find the clusters of entries that share a stable identity. Returns ONLY groups
 * of size ≥ 2 (singletons are not duplicates), each in first-occurrence order,
 * and the groups themselves ordered by where their first member appears. Entries
 * with no stable identity are never grouped. Pure — inputs untouched.
 */
export function detectDuplicateGroups(entries: CitationEntry[]): CitationEntry[][] {
  // Preserve discovery order: an array of identity buckets, indexed for stability.
  const order: string[] = [];
  const buckets = new Map<string, CitationEntry[]>();
  for (const e of entries) {
    const id = identityOf(e);
    if (id === null) continue;
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = [];
      buckets.set(id, bucket);
      order.push(id);
    }
    bucket.push(e);
  }
  const out: CitationEntry[][] = [];
  for (const id of order) {
    const bucket = buckets.get(id)!;
    if (bucket.length >= 2) out.push(bucket);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** Scalar fields that are coalesced (first non-empty wins, later FILLS gaps). */
const COALESCE_FIELDS = [
  "doi",
  "url",
  "journal",
  "publisher",
  "volume",
  "number",
  "pages",
  "year",
  "abstract",
] as const;

/**
 * Merge a duplicate cluster into ONE entry. The first entry wins on every
 * conflict (its key, type, title, and any scalar it already has are kept), but
 * missing scalar fields are FILLED from later duplicates in order, and the
 * RICHEST author list (the longest among the group, first occurrence winning a
 * tie) is adopted so we never lose names. Never mutates its inputs. Pure.
 */
export function mergeGroup(group: CitationEntry[]): CitationEntry {
  const [first, ...rest] = group;
  if (!first) throw new Error("mergeGroup: empty group");
  const merged: CitationEntry = { ...first };

  for (const dup of rest) {
    for (const field of COALESCE_FIELDS) {
      const have = merged[field];
      if ((have === undefined || have === "") && dup[field] !== undefined && dup[field] !== "") {
        merged[field] = dup[field];
      }
    }
    // Title is conflict-won by the first, but fill it if the first had none.
    if ((merged.title === undefined || merged.title === "") && dup.title) {
      merged.title = dup.title;
    }
    // Adopt a STRICTLY richer author list (more names). First occurrence wins ties.
    const dupAuthors = dup.author?.length ?? 0;
    const haveAuthors = merged.author?.length ?? 0;
    if (dupAuthors > haveAuthors && dup.author) {
      merged.author = [...dup.author];
    }
    // Editor list coalesces IDENTICALLY to the author list (G7): adopt the
    // strictly-richer one, first occurrence winning ties.
    const dupEditors = dup.editor?.length ?? 0;
    const haveEditors = merged.editor?.length ?? 0;
    if (dupEditors > haveEditors && dup.editor) {
      merged.editor = [...dup.editor];
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Whole-library dedup
// ---------------------------------------------------------------------------

export interface DeduplicateResult {
  /** The de-duplicated entry list: each group collapsed to its merged entry in
   *  first-occurrence position; singletons unchanged; order preserved. */
  merged: CitationEntry[];
  /** How many entries were removed (total members − number of groups). */
  removed: number;
  /** The duplicate groups that were collapsed (for a preview). */
  groups: CitationEntry[][];
}

/**
 * Collapse every duplicate cluster in `entries` to its merged entry, keeping the
 * cluster's first-occurrence slot; singletons (and identity-less entries) are kept
 * as-is in place. Reports how many entries were removed. Deterministic: the merged
 * fields are independent of duplicate ordering within a group (the first member's
 * conflicts win; the rest only fill gaps / contribute the richest author list).
 * Pure — returns fresh entries; inputs untouched.
 */
export function deduplicateEntries(entries: CitationEntry[]): DeduplicateResult {
  const groups = detectDuplicateGroups(entries);
  if (groups.length === 0) {
    return { merged: entries.map((e) => ({ ...e })), removed: 0, groups: [] };
  }

  // Map each non-first group member's object identity → "drop", and the first
  // member's object identity → the merged replacement. Object identity is safe
  // here because `entries` are the very objects detectDuplicateGroups returned.
  const dropSet = new Set<CitationEntry>();
  const replaceAt = new Map<CitationEntry, CitationEntry>();
  let removed = 0;
  for (const group of groups) {
    const mergedEntry = mergeGroup(group);
    replaceAt.set(group[0]!, mergedEntry);
    for (let i = 1; i < group.length; i++) {
      dropSet.add(group[i]!);
      removed++;
    }
  }

  const merged: CitationEntry[] = [];
  for (const e of entries) {
    if (dropSet.has(e)) continue;
    const replacement = replaceAt.get(e);
    merged.push(replacement ? replacement : { ...e });
  }
  return { merged, removed, groups };
}

// ---------------------------------------------------------------------------
// BibTeX emission (faithful round-trip with parseBibtex)
// ---------------------------------------------------------------------------

// The order in which fields are emitted. Covers EXACTLY the fields parseBibtex
// reads back (so parse(emit(x)) === x for those fields). `author`/`year` are
// emitted specially; the rest are plain `name = {value}` scalars.
const BIBTEX_SCALAR_FIELDS = [
  "title",
  "doi",
  "url",
  "journal",
  "publisher",
  "volume",
  "number",
  "pages",
  "abstract",
] as const;

/**
 * Escape a field value so `{ … }` is brace-balanced and round-trips through
 * `parseBibtex`'s `readEntryBody` (which counts `{`/`}` to find the closing brace).
 * parseBibtex strips ALL braces from a value (`cleanBibtexValue` does `replace(/[{}]/g,"")`)
 * and collapses internal whitespace, so to round-trip a value's VISIBLE text we
 * must emit no stray braces. We drop any `{`/`}` already in the value (they would
 * be stripped on read anyway) and collapse whitespace to single spaces (read also
 * collapses), guaranteeing parse(emit(v)) === collapse(stripBraces(v)). For the
 * field set we emit, values are plain metadata text, so this is faithful.
 */
function bibtexValue(raw: string): string {
  return raw.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

/** Emit a key safely: parseBibtex takes everything up to the first comma as the
 *  citekey and trims it, so a key must contain no comma/newline. Sanitize defensively. */
function bibtexKey(key: string): string {
  const cleaned = key.replace(/[,{}\n\r]/g, "").trim();
  return cleaned.length > 0 ? cleaned : "ref";
}

/**
 * Render a `CitationEntry` as a BibTeX entry that round-trips through
 * `parseBibtex` for every field parseBibtex reads back (key, type, title, author,
 * editor, year, doi, url, journal, publisher, volume, number, pages, abstract). The canonical
 * on-disk/compile format for a `.bib` is BibTeX (Typst compiles `.bib` AS BibTeX,
 * and every Galley reader parses it with parseBibtex) — so dedup MUST re-emit
 * BibTeX, never Hayagriva. Pure.
 */
export function toBibtex(entry: CitationEntry): string {
  const type = (entry.type && entry.type.trim().length > 0 ? entry.type : "misc").toLowerCase();
  const key = bibtexKey(entry.key);
  const lines: string[] = [`@${type}{${key},`];
  for (const field of BIBTEX_SCALAR_FIELDS) {
    const v = entry[field];
    if (v !== undefined && String(v).length > 0) {
      lines.push(`  ${field} = {${bibtexValue(String(v))}},`);
    }
  }
  // year is its own field (parseBibtex keeps a 4-digit run); emit as-is.
  if (entry.year !== undefined && String(entry.year).length > 0) {
    lines.push(`  year = {${bibtexValue(String(entry.year))}},`);
  }
  // author: BibTeX joins names with " and " (parseBibtex splits on /\s+and\s+/i).
  if (entry.author && entry.author.length > 0) {
    const joined = entry.author.map((a) => bibtexValue(a)).join(" and ");
    lines.push(`  author = {${joined}},`);
  }
  // editor: IDENTICAL " and "-joined shape as author (parseBibtex reads it back
  // through the same author code path) — G7.
  if (entry.editor && entry.editor.length > 0) {
    const joined = entry.editor.map((ed) => bibtexValue(ed)).join(" and ");
    lines.push(`  editor = {${joined}},`);
  }
  lines.push(`}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Source-span scan (mirrors parseBibtex's tokenizer) — for SURGICAL removal
// ---------------------------------------------------------------------------

/** A parsed entry plus its EXACT byte span `[start, end)` in the source. */
interface EntrySpan {
  entry: CitationEntry;
  /** Index of the leading `@`. */
  start: number;
  /** Index just past the entry's closing `}`. */
  end: number;
}

/** Read the brace-balanced body starting at `openIdx` (the `{`); returns the
 *  index just past the matching `}`, or null if unbalanced. Mirrors citation.ts. */
function entryBodyEnd(src: string, openIdx: number): number | null {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

/**
 * Scan `src` for BibTeX entries, returning each parsed entry alongside its exact
 * source span. Uses the SAME tokenizer shape as `parseBibtex` (same `@type{` regex,
 * same brace-balanced body read, same skip of comment/string/preamble) so the
 * entries here are identical to `parseBibtex(src)` AND carry byte-accurate spans.
 * The returned entries are produced BY `parseBibtex` over the entry's own slice so
 * field parsing matches exactly. Pure.
 */
function scanBibtexEntries(src: string): EntrySpan[] {
  const out: EntrySpan[] = [];
  const at = /@([a-zA-Z]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = at.exec(src)) !== null) {
    const type = m[1]!.toLowerCase();
    const openIdx = src.indexOf("{", m.index);
    if (openIdx === -1) break;
    const end = entryBodyEnd(src, openIdx);
    if (end === null) break;
    if (type !== "comment" && type !== "string" && type !== "preamble") {
      // Parse the entry's own slice so the CitationEntry matches parseBibtex's
      // single-entry result for this span exactly.
      const parsed = parseBibtex(src.slice(m.index, end));
      if (parsed.length === 1) out.push({ entry: parsed[0]!, start: m.index, end });
    }
    at.lastIndex = end;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Coalescing enrichment — surgical field injection into the survivor's span
// ---------------------------------------------------------------------------

// The scalar fields we are willing to INJECT into a survivor that lacks them.
// (Title is intentionally excluded: a missing title is exotic and re-emitting it
//  is conflict-prone; the survivor's title — present or absent — is left as-is.)
const INJECTABLE_SCALAR_FIELDS = [
  "doi",
  "url",
  "journal",
  "publisher",
  "volume",
  "number",
  "pages",
  "year",
  "abstract",
] as const;

/**
 * Build the BibTeX field lines to INJECT into `survivor` so it gains the fields
 * the dropped duplicates carry but it LACKS — formatted EXACTLY like `toBibtex`
 * (same `bibtexValue` escaping, same `  name = {value},` shape) so the spliced
 * result round-trips through `parseBibtex`. Returns an empty array when the
 * survivor is missing nothing (caller then leaves the span byte-for-byte intact).
 *
 * The author/editor nuance: we only ADD an author/editor line when the survivor
 * LACKS one entirely. We never rewrite an existing author/editor line — the
 * survivor's first-occurrence list wins, and re-emitting it could drop formatting
 * or extra names the survivor intentionally carries. (mergeGroup's "richer list"
 * is therefore surfaced ONLY to a survivor that had none.) Pure.
 */
function injectionLines(survivor: CitationEntry, merged: CitationEntry): string[] {
  const lines: string[] = [];
  for (const field of INJECTABLE_SCALAR_FIELDS) {
    const have = survivor[field];
    const filled = merged[field];
    if (
      (have === undefined || have === "") &&
      filled !== undefined &&
      String(filled).length > 0
    ) {
      lines.push(`  ${field} = {${bibtexValue(String(filled))}},`);
    }
  }
  // author/editor: ADD only when the survivor has none; never rewrite an existing
  // list (first-occurrence wins, preserving its formatting/extra names).
  if ((!survivor.author || survivor.author.length === 0) && merged.author && merged.author.length > 0) {
    const joined = merged.author.map((a) => bibtexValue(a)).join(" and ");
    lines.push(`  author = {${joined}},`);
  }
  if ((!survivor.editor || survivor.editor.length === 0) && merged.editor && merged.editor.length > 0) {
    const joined = merged.editor.map((ed) => bibtexValue(ed)).join(" and ");
    lines.push(`  editor = {${joined}},`);
  }
  return lines;
}

/**
 * Surgically splice `lines` into the survivor's ORIGINAL BibTeX entry text (the
 * exact `src` slice `[start, end)`), inserting them just before the entry's
 * closing `}` WITHOUT disturbing the survivor's existing fields, key, type, or any
 * field `toBibtex` doesn't model (month/keywords/…). We locate the closing brace
 * as the LAST `}` in the span (the body is brace-balanced — the scan already
 * verified `end` is just past it). The inserted block matches `toBibtex`'s
 * multi-line shape (`\n  field = {value},`) and we keep the brace on its own line
 * so the result re-parses cleanly whether the survivor was single- or multi-line.
 *
 * BibTeX separates fields with commas; a compact entry's LAST field has no trailing
 * comma before `}` (e.g. `…, doi={x}}`). Since each injected line begins a new
 * field, we ensure the survivor's existing body terminates in a comma first —
 * otherwise the parser would absorb our first injected field name into the prior
 * value. We add the comma ONLY when the trimmed body doesn't already end in `,`
 * or the opening `{` (an empty body), so we never disturb an already-terminated
 * field. Returns the survivor's span unchanged when there are no lines. Pure.
 */
function spliceInjection(span: string, lines: string[]): string {
  if (lines.length === 0) return span;
  const closeIdx = span.lastIndexOf("}");
  if (closeIdx === -1) return span; // defensive: not a real entry, leave it be
  const before = span.slice(0, closeIdx);
  const after = span.slice(closeIdx); // the closing `}` + any trailing bytes
  // Ensure the existing body ends in a newline before our block, then put the
  // closing brace on its own line — robust for both single-line and pretty bodies.
  const trimmedBefore = before.replace(/\s*$/, "");
  const last = trimmedBefore[trimmedBefore.length - 1];
  const sep = last === "," || last === "{" ? "" : ",";
  return `${trimmedBefore}${sep}\n${lines.join("\n")}\n${after}`;
}

export interface DeduplicateSourceResult {
  /** The de-duplicated bibliography text. SURGICAL: every surviving byte is
   *  preserved verbatim — only the duplicate entries' spans are removed. */
  text: string;
  removed: number;
  groups: CitationEntry[][];
  /**
   * True when `text` is safe to write back: the apply preserves all non-duplicate
   * content byte-for-byte and never converts formats. Always true for the surgical
   * path; the field exists so the host can assert the no-data-loss contract.
   */
  safe: boolean;
}

/**
 * De-duplicate a bibliography library STRING by SURGICALLY removing only the
 * duplicate entries from the ORIGINAL source — every surviving byte (the kept
 * entries' exact BibTeX text, comments, whitespace, any non-BibTeX remainder) is
 * preserved verbatim. The kept member of each duplicate cluster is the FIRST
 * occurrence, untouched. NO format conversion (the file stays BibTeX, so Typst's
 * `.bib` compile and every BibTeX reader keep working) and NO data loss (content
 * `parseBibtex` doesn't recognize is never dropped). Robust to junk/empty input
 * (returns the source unchanged, removed 0). Pure.
 */
export function deduplicateBibliographySource(src: string): DeduplicateSourceResult {
  if (typeof src !== "string" || src.trim().length === 0) {
    return { text: typeof src === "string" ? src : "", removed: 0, groups: [], safe: true };
  }

  const spans = scanBibtexEntries(src);
  // Detect duplicate groups over the scanned entries (same order as the source).
  const groups = detectDuplicateGroups(spans.map((s) => s.entry));
  if (groups.length === 0) {
    return { text: src, removed: 0, groups: [], safe: true };
  }

  // The entries to DROP are every non-first member of each group. Map them back to
  // their spans via object identity (the group members ARE the scanned entries).
  // For each group we also compute the merged (coalesced) entry, and map the
  // SURVIVOR (first member) → the field lines we must inject so the apply actually
  // ENRICHES the survivor with what the dropped dups carried but it lacked.
  const dropEntries = new Set<CitationEntry>();
  const injectFor = new Map<CitationEntry, string[]>();
  for (const group of groups) {
    const merged = mergeGroup(group);
    const lines = injectionLines(group[0]!, merged);
    if (lines.length > 0) injectFor.set(group[0]!, lines);
    for (let i = 1; i < group.length; i++) dropEntries.add(group[i]!);
  }
  const dropSpans = spans
    .filter((s) => dropEntries.has(s.entry))
    .sort((a, b) => a.start - b.start);
  // Survivor spans that need enrichment, in source order (the scan is already
  // ordered), advanced by a single shared cursor so the whole splice stays linear.
  const injectSpans: { start: number; end: number; lines: string[] }[] = [];
  for (const s of spans) {
    const lines = injectFor.get(s.entry);
    if (lines) injectSpans.push({ start: s.start, end: s.end, lines });
  }
  const injectCursor = { i: 0 };

  // Splice the dropped spans out of the ORIGINAL source, keeping everything else,
  // AND splice the injected field lines into each enriched survivor's span. Both
  // happen in ONE linear pass over the same ordered span scan (no quadratic work).
  // Also trim a single trailing blank-line gap left behind by a removed entry so
  // we don't accumulate blank runs, WITHOUT touching any surviving entry's bytes.
  let text = "";
  let cursor = 0;
  for (const span of dropSpans) {
    // Copy the gap before the dropped span, enriching any survivor span it covers.
    text += spliceSurvivors(src, cursor, span.start, injectSpans, injectCursor);
    cursor = span.end;
    // Swallow the inter-entry separator that followed the removed entry (the run of
    // blank lines / spaces up to and including one newline) so the gap closes
    // cleanly. This only removes whitespace that BELONGED to the removed entry's
    // trailing separator — never a surviving entry's content.
    let j = cursor;
    while (j < src.length && (src[j] === " " || src[j] === "\t" || src[j] === "\r")) j++;
    if (src[j] === "\n") {
      j++;
      // collapse an immediately following blank line too (the visual gap).
      let k = j;
      while (k < src.length && (src[k] === " " || src[k] === "\t" || src[k] === "\r")) k++;
      if (src[k] === "\n") j = k + 1;
      cursor = j;
    }
  }
  text += spliceSurvivors(src, cursor, src.length, injectSpans, injectCursor);

  const removed = dropSpans.length;
  return { text, removed, groups, safe: true };
}

/**
 * Copy `src[from, to)` to the output, rewriting any enriched-survivor span that
 * STARTS within `[from, to)` through `spliceInjection`. `injectSpans` is in source
 * order and `cursor.i` is a SHARED monotone index across all calls, so across the
 * whole apply each survivor is visited exactly once — the entire splice is a single
 * linear pass (no rescans, no quadratic work). A survivor span always lies fully
 * inside one preserved gap (survivors are never dropped, so a survivor can never
 * straddle a removed-span boundary). Pure aside from advancing the shared cursor.
 */
function spliceSurvivors(
  src: string,
  from: number,
  to: number,
  injectSpans: { start: number; end: number; lines: string[] }[],
  cursor: { i: number },
): string {
  let out = "";
  let i = from;
  while (cursor.i < injectSpans.length && injectSpans[cursor.i]!.start < to) {
    const { start, end, lines } = injectSpans[cursor.i]!;
    // Spans before this gap were already emitted by an earlier call; skip them.
    if (start < from) {
      cursor.i++;
      continue;
    }
    out += src.slice(i, start);
    out += spliceInjection(src.slice(start, end), lines);
    i = end;
    cursor.i++;
  }
  out += src.slice(i, to);
  return out;
}
