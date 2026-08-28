/**
 * #17.1 reference-library import + #17.4 literature search — the pure
 * helpers behind the CitationPanel's extra modes (paste-library, literature
 * search, and — reusing the same re-keying seam — the Zotero pull). They wrap the already-landed
 * `@galley/agent` cores (`importReferences`, `searchLiterature`, `toHayagriva`,
 * `makeCiteKey`) and shape their output into the SAME `ResolvedCitation` the paste
 * flow produces, so a library row or a search hit flows through the panel's
 * existing review → `onInsert(@key)` / `onAddToBibliography` path with zero new
 * insertion machinery.
 *
 * Why re-key here: `importReferences` / `searchLiterature` assign keys against a
 * fresh, internal set — they don't know the project's existing bibliography. These
 * helpers re-key every entry against `existingKeys` (via the core's `makeCiteKey`,
 * the same deterministic `<family><year>` + collision-suffix contract) so an Add
 * can never clobber an entry already in the bib, and flag the ones that collided
 * as `duplicate` for an honest "N already in your library" hint.
 *
 * PURE except for the injected `fetch` `searchCitations` is handed (mirrors the
 * panel's seam). `searchCitations` is FAIL-CLOSED — it flattens any failure to `[]`
 * and never throws. Prefer `searchCitationsDetailed`, which preserves every
 * backend's failure/empty distinction so a request the panel could not complete is
 * never rendered as a confident "no results".
 */
import {
  importReferencesDetailed,
  searchLiteratureDetailed,
  searchArxivDetailed,
  searchOpenAlexDetailed,
  searchSemanticScholarDetailed,
  toHayagriva,
  toBibtex,
  makeCiteKey,
} from "@galley/agent";
import type { CitationEntry, CitationInputKind, ImportFormat } from "@galley/agent";
import type { ResolvedCitation } from "./CitationPanel.js";

/** A reviewable, collision-free `ResolvedCitation` plus whether it duplicates an
 *  entry already in the project bibliography (keyed clear so an Add is safe). */
export interface LibraryRow extends ResolvedCitation {
  /** True when this work's natural key already existed in `existingKeys`. */
  duplicate: boolean;
}

export interface ImportLibraryResult {
  /** Reviewable rows, in import order, each re-keyed clear of `existingKeys`. */
  entries: LibraryRow[];
  /** How many DISTINCT works were parsed (post-dedupe) — the honest count. */
  parsedCount: number;
  /** How many parsed works already existed in `existingKeys`. */
  duplicateCount: number;
  /**
   * Present when auto-detection fell back to the other format because the
   * detected one parsed to zero entries (see `importReferencesDetailed`) — the
   * summary line surfaces it so the recovery is never silent.
   */
  formatNote?: string;
  /**
   * Honest "parsed N of M" provenance from the parser (G4): how many entry-starts
   * were SEEN in the source (`seenCount`) vs how many were SKIPPED because they
   * were malformed (`malformedCount` — e.g. a BibTeX entry whose braces never
   * balanced; the parser now resyncs past it instead of swallowing the rest).
   * `malformedCount === 0` for a clean import, in which case the UI hides the
   * "(k skipped)" note (behavior unchanged). NOTE: `seenCount` is the RAW source
   * count and may exceed `entries.length`, which is post-dedupe + duplicate-clear.
   */
  seenCount: number;
  malformedCount: number;
}

/**
 * Wrap an already-keyed `CitationEntry` (key clear of collisions) into the
 * `ResolvedCitation` shape the panel's Accept flow consumes. The `kind` records
 * its provenance (`bibtex`/`ris` for an import, `doi`/`url` for a search hit).
 * Pure.
 */
export function entryToResolved(
  entry: CitationEntry,
  kind: CitationInputKind,
): ResolvedCitation {
  const keyed: CitationEntry = { ...entry, key: entry.key };
  return { kind, key: entry.key, entry: keyed, hayagriva: toHayagriva(keyed) };
}

/**
 * The text to APPEND to the project's `.bib` file when an author adds a
 * `ResolvedCitation` to the bibliography. A `.bib` file is compiled by Typst AS
 * BibTeX and every Galley reader (`parseBibliography`/`citeKeysFromBibliography`)
 * parses it with `parseBibtex` — so a `.bib` entry MUST be BibTeX, never the
 * Hayagriva YAML the panel renders for review. We re-emit the structured
 * `resolved.entry` via the well-tested `toBibtex` so the appended entry is visible
 * to autocomplete/ref-check and never breaks the compile. Pure.
 */
export function bibEntryText(resolved: ResolvedCitation): string {
  return toBibtex(resolved.entry);
}

/**
 * Filter resolved-citation rows by a free-text query (substring match on the
 * cite-key, title, and author names, case-insensitive). An empty/whitespace query
 * returns the rows unchanged. Lets the author *search* an imported/pulled library
 * before inserting — the OSS substrate for "dynamically search your reference
 * manager". Generic over `ResolvedCitation` (so `LibraryRow` works too). Pure.
 */
export function filterCitationRows<T extends ResolvedCitation>(rows: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return rows.slice();
  return rows.filter((r) => {
    const haystack = [r.key, r.entry.title ?? "", ...(r.entry.author ?? [])].join(" ").toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * Re-key a parsed/searched entry list against the project's existing bibliography
 * keys, preserving order. Returns each entry paired with whether its natural key
 * collided (so it was suffixed). Uses the core's `makeCiteKey` so the keys match
 * the rest of Galley's keying contract exactly. Pure.
 */
function rekeyAgainst(
  entries: CitationEntry[],
  existing: Iterable<string>,
): { entry: CitationEntry; duplicate: boolean }[] {
  const seed = new Set<string>(existing);
  const used = new Set<string>(existing);
  const out: { entry: CitationEntry; duplicate: boolean }[] = [];
  for (const entry of entries) {
    // The work's NATURAL (unsuffixed) key — `makeCiteKey` against an empty set
    // yields `<family><year>` with no collision suffix. If THAT key is already in
    // the bibliography, this work is a duplicate — an honest "already present"
    // signal, independent of any earlier row in this same batch.
    const naturalKey = makeCiteKey(entry, new Set());
    const duplicate = seed.has(naturalKey);
    // The ACTUAL assigned key avoids colliding with both the bibliography AND
    // earlier rows of this batch, so a bulk Add never clobbers anything.
    const key = makeCiteKey(entry, used);
    used.add(key);
    out.push({ entry: { ...entry, key }, duplicate });
  }
  return out;
}

/**
 * Re-key an entry list against the existing bibliography and wrap each entry into
 * a reviewable, collision-free `LibraryRow` (the EXACT shape the panel's library
 * list renders). `kind` records provenance (`bibtex` for an offline parse / a
 * Zotero pull, `doi` for a search hit). This is the shared seam reused by
 * `importLibrary` AND the Zotero pull (`zotero-import.ts`) so a pulled library
 * and a pasted .bib produce byte-identical rows. Pure.
 */
export function rekeyEntries(
  entries: CitationEntry[],
  existing: Iterable<string>,
  kind: CitationInputKind,
): LibraryRow[] {
  return rekeyAgainst(entries, existing).map(({ entry, duplicate }) => ({
    ...entryToResolved(entry, kind),
    duplicate,
  }));
}

/** Tally an already-re-keyed row list into the panel's summary counts. Pure.
 *  `seen`/`malformed` default to a clean tally (no malformed source entries) for
 *  callers without parser provenance (e.g. the Zotero pull); `importLibrary`
 *  overrides them with the real parser counts so the UI can show "N of M". */
export function summariseRows(
  entries: LibraryRow[],
  seen?: number,
  malformed?: number,
): ImportLibraryResult {
  return {
    entries,
    parsedCount: entries.length,
    duplicateCount: entries.filter((e) => e.duplicate).length,
    seenCount: seen ?? entries.length,
    malformedCount: malformed ?? 0,
  };
}

/**
 * #17.1 — parse a pasted BibTeX/RIS reference-library export into a reviewable,
 * de-duplicated, collision-free list of `LibraryRow`s ready for review then
 * `onAddToBibliography`. `format` selects the parser (`"auto"` detects RIS by a
 * leading `TY  - ` tag, else BibTeX). Robust to junk/empty (returns an empty
 * result, never throws). Pure.
 */
export function importLibrary(opts: {
  text: string;
  format?: ImportFormat;
  existingKeys?: Iterable<string>;
}): ImportLibraryResult {
  const detailed = importReferencesDetailed(opts.text, opts.format ?? "auto");
  const existing = opts.existingKeys ?? [];
  // Both BibTeX and RIS are offline library parses; `CitationInputKind` has no
  // dedicated `ris` member, so all library rows carry the `bibtex` (local-parse)
  // provenance — matching the paste flow's label for an offline-resolved entry.
  const kind: CitationInputKind = "bibtex";
  // Thread the parser's honest "seen vs malformed" provenance (G4) onto the
  // summary so the panel can show "Parsed N of M — k malformed entr… skipped".
  const result = summariseRows(
    rekeyEntries(detailed.entries, existing, kind),
    detailed.totalCount,
    detailed.malformedCount,
  );
  // Surface an auto-detect format fallback on the summary channel — honest, calm.
  return detailed.fallbackNote === undefined
    ? result
    : { ...result, formatNote: detailed.fallbackNote };
}

/** Which literature backend a search runs against. Crossref is the default so
 *  every existing caller/test is byte-for-byte unchanged. arXiv (Atom),
 *  OpenAlex + Semantic Scholar (JSON) are the additional, opt-in sources. */
export type CitationSearchSource = "crossref" | "arxiv" | "openalex" | "semanticscholar";

/** The outcome of a literature search, preserving the failure/empty distinction. */
export type CitationSearchOutcome =
  | { ok: true; results: ResolvedCitation[] }
  | { ok: false; reason: "network" | "server" | "malformed" };

/**
 * #17.4 / #6 — search the literature for `query` (via the panel's INJECTED
 * `fetch`) and return reviewable, collision-free `ResolvedCitation`s, each ready
 * for the SAME review → insert(`@key`) / add-to-bibliography path as a pasted
 * citation. `source` picks the backend: `"crossref"` (default, JSON works-search),
 * `"arxiv"` (Atom feed, XXE/DoS-safe parse), `"openalex"` or `"semanticscholar"`
 * (both JSON). Every source collapses to the IDENTICAL `ResolvedCitation` shape.
 *
 * EVERY path surfaces a failure REASON so the panel can tell "couldn't reach the
 * source" apart from an honestly-empty result set (`{ ok: true, results: [] }`) —
 * arXiv included, since its core gained the same discriminated outcome as the other
 * three. Never throws; an empty/whitespace query short-circuits to an empty success.
 */
export async function searchCitationsDetailed(opts: {
  query: string;
  fetch: typeof fetch;
  existingKeys?: Iterable<string>;
  source?: CitationSearchSource;
}): Promise<CitationSearchOutcome> {
  const existing = opts.existingKeys ?? [];
  // Every backend's entries flow through the IDENTICAL re-key + resolve path, so a
  // hit from any source is byte-for-byte interchangeable downstream. Search hits
  // carry `doi` provenance by default (they originate from a remote metadata
  // record); `kindOf` lets a source refine that per entry.
  const toResults = (
    entries: Parameters<typeof rekeyAgainst>[0],
    kindOf: (entry: CitationEntry) => CitationInputKind = () => "doi",
  ): ResolvedCitation[] =>
    rekeyAgainst(entries, existing).map(({ entry }) => entryToResolved(entry, kindOf(entry)));

  if (opts.source === "arxiv") {
    const outcome = await searchArxivDetailed(opts.query, { fetch: opts.fetch });
    if (!outcome.ok) return outcome;
    // Unlike the other backends, an arXiv hit is often an unpublished preprint with
    // no DOI — those are identified by their abs URL, so label them honestly.
    return { ok: true, results: toResults(outcome.entries, (e) => (e.doi ? "doi" : "url")) };
  }
  if (opts.source === "openalex") {
    const outcome = await searchOpenAlexDetailed(opts.query, { fetch: opts.fetch });
    if (!outcome.ok) return outcome;
    return { ok: true, results: toResults(outcome.entries) };
  }
  if (opts.source === "semanticscholar") {
    const outcome = await searchSemanticScholarDetailed(opts.query, { fetch: opts.fetch });
    if (!outcome.ok) return outcome;
    return { ok: true, results: toResults(outcome.entries) };
  }
  const outcome = await searchLiteratureDetailed(opts.query, { fetch: opts.fetch });
  if (!outcome.ok) return outcome;
  return { ok: true, results: toResults(outcome.entries) };
}

/**
 * Back-compat FAIL-CLOSED wrapper: returns just the rows, flattening any failure
 * to `[]`. Prefer {@link searchCitationsDetailed} when a failed request must read
 * differently from "no matches". Honors `source` like the detailed form.
 */
export async function searchCitations(opts: {
  query: string;
  fetch: typeof fetch;
  existingKeys?: Iterable<string>;
  source?: CitationSearchSource;
}): Promise<ResolvedCitation[]> {
  const outcome = await searchCitationsDetailed(opts);
  return outcome.ok ? outcome.results : [];
}
