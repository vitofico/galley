/**
 * OpenAlex literature search — a THIRD search source alongside Crossref + arXiv.
 *
 * OpenAlex (`https://api.openalex.org/works`) is a fully open scholarly index
 * (~250M works, no API key, CORS-enabled) — effectively a free Crossref superset.
 * This core mirrors literature-search.ts's posture EXACTLY: a PURE core whose ONLY
 * IO is an INJECTED `fetch` (never the global), a FIXED HTTPS host, NO credentials
 * (we deliberately do NOT send a `mailto` identifier), read-only metadata, and a
 * DISCRIMINATED outcome that keeps a real failure (`network`/`server`/`malformed`)
 * distinct from an honestly-empty result set. The mapped entries are deduped +
 * stably keyed via citation.ts's `dedupeEntries`/`makeCiteKey`, so an OpenAlex hit
 * is byte-for-byte downstream-identical to a Crossref hit (ready for `toHayagriva`,
 * the same review→insert path).
 *
 * Like Crossref this is JSON (`{ results: [...] }`), so there is no XML/parser
 * surface — `res.json()` bounds the parse. We still cap the number of mapped works
 * (`MAX_RESULTS`) so a surprising/hostile body can't make the map walk unbounded.
 */
import {
  type CitationEntry,
  dedupeEntries,
  makeCiteKey,
} from "./citation.js";
import type { LiteratureSearchOutcome } from "./literature-search.js";

const OPENALEX_WORKS_HOST = "https://api.openalex.org/works";
const DEFAULT_ROWS = 10;
const MIN_ROWS = 1;
const MAX_ROWS = 100;
/** Hard ceiling on works mapped from one response, independent of `per_page`. */
const MAX_RESULTS = 200;

/** Clamp a requested result count into OpenAlex's practical [1, 100] window. */
function clampRows(rows: number | undefined): number {
  const n = typeof rows === "number" && Number.isFinite(rows) ? Math.floor(rows) : DEFAULT_ROWS;
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, n));
}

/**
 * Build the fixed-host OpenAlex works-search URL for a query. No credentials, no
 * `mailto` (we stay anonymous on the common pool). Pure.
 */
export function buildOpenAlexSearchUrl(query: string, rows?: number): string {
  const params = new URLSearchParams({
    search: query.trim(),
    per_page: String(clampRows(rows)),
  });
  return `${OPENALEX_WORKS_HOST}?${params.toString()}`;
}

// --- OpenAlex JSON shape (only the fields we consume; all optional) ----------
interface OpenAlexAuthorship {
  author?: { display_name?: string | null } | null;
  raw_author_name?: string | null;
}
interface OpenAlexWork {
  id?: string | null;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  type?: string | null;
  authorships?: OpenAlexAuthorship[] | null;
  primary_location?: {
    source?: { display_name?: string | null; host_organization_name?: string | null } | null;
  } | null;
  biblio?: {
    volume?: string | null;
    issue?: string | null;
    first_page?: string | null;
    last_page?: string | null;
  } | null;
}
interface OpenAlexEnvelope {
  results?: OpenAlexWork[];
}

// OpenAlex `type` vocabulary (Crossref-derived) → our internal type.
const OPENALEX_TYPE_MAP: Record<string, string> = {
  article: "article",
  "journal-article": "article",
  preprint: "article",
  "proceedings-article": "inproceedings",
  book: "book",
  "book-chapter": "inbook",
  dissertation: "phdthesis",
  report: "techreport",
  dataset: "misc",
};

const DOI_PREFIX_RE = /^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)/i;

/** Strip a `doi:`/`https://doi.org/` wrapper to the bare DOI core (downstream
 *  `normDoi` lowercases on compare/render). */
function bareDoi(input: string): string {
  return input.trim().replace(DOI_PREFIX_RE, "");
}

/** Join OpenAlex `biblio.first_page`/`last_page` into a BibTeX-style page range. */
function pageRange(first?: string | null, last?: string | null): string | undefined {
  const f = (first ?? "").trim();
  const l = (last ?? "").trim();
  if (f && l) return f === l ? f : `${f}-${l}`;
  return f || l || undefined;
}

/**
 * Map ONE OpenAlex work to a CitationEntry (key left for the caller to assign).
 * Returns null when the work has no usable metadata (mirrors the Crossref guard).
 * Authors are stored as their `display_name` ("Given Family") verbatim — the SAME
 * choice as the arXiv core; `makeCiteKey`/`familyName` handle that form, and we
 * avoid the lossy guesswork of splitting a full name into family/given. Pure.
 */
function openAlexToEntry(work: OpenAlexWork): CitationEntry | null {
  const title = (work.title ?? work.display_name ?? "").trim();
  const authors: string[] = [];
  for (const a of work.authorships ?? []) {
    const name = (a?.author?.display_name ?? a?.raw_author_name ?? "").trim();
    if (name.length > 0) authors.push(name);
  }
  if (title.length === 0 && authors.length === 0) return null;

  const type = (work.type ?? "").toLowerCase();
  const entry: CitationEntry = { key: "", type: OPENALEX_TYPE_MAP[type] ?? "article" };
  if (title.length > 0) entry.title = title;
  if (authors.length > 0) entry.author = authors;

  if (typeof work.publication_year === "number" && Number.isFinite(work.publication_year)) {
    entry.year = String(work.publication_year);
  }
  if (work.doi) {
    const doi = bareDoi(work.doi);
    if (doi.length > 0) entry.doi = doi;
  }
  const source = work.primary_location?.source;
  const journal = (source?.display_name ?? "").trim();
  if (journal.length > 0) entry.journal = journal;
  const publisher = (source?.host_organization_name ?? "").trim();
  if (publisher.length > 0) entry.publisher = publisher;
  const volume = (work.biblio?.volume ?? "").trim();
  if (volume.length > 0) entry.volume = volume;
  const issue = (work.biblio?.issue ?? "").trim();
  if (issue.length > 0) entry.number = issue;
  const pages = pageRange(work.biblio?.first_page, work.biblio?.last_page);
  if (pages) entry.pages = pages;
  // Keep the OpenAlex landing page as the entry URL ONLY when it is a well-formed
  // https://openalex.org/… id (scheme/host allowlist — defense in depth).
  const id = (work.id ?? "").trim();
  if (/^https:\/\/openalex\.org\/\S+$/i.test(id)) entry.url = id;

  return entry;
}

/**
 * Search OpenAlex for works matching `query`, returning a {@link LiteratureSearchOutcome}
 * (the SAME discriminated shape Crossref uses) that separates a real failure from
 * an honestly-empty result set. Uses ONLY the injected `opts.fetch` (auditable +
 * offline-testable). An empty/whitespace query short-circuits to an empty success
 * without touching the network. Never throws.
 */
export async function searchOpenAlexDetailed(
  query: string,
  opts: { fetch: typeof fetch; rows?: number },
): Promise<LiteratureSearchOutcome> {
  if (typeof query !== "string" || query.trim().length === 0) {
    return { ok: true, entries: [] };
  }

  let res: Response;
  try {
    res = await opts.fetch(buildOpenAlexSearchUrl(query, opts.rows), {
      headers: { accept: "application/json" },
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  if (!res.ok) return { ok: false, reason: "server" };

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof json !== "object" || json === null) return { ok: false, reason: "malformed" };

  const results = (json as OpenAlexEnvelope).results;
  // An empty `results` array is a real "no matches"; a MISSING array is a body we
  // didn't understand (malformed) — the two must not collapse together.
  if (!Array.isArray(results)) return { ok: false, reason: "malformed" };

  const mapped: CitationEntry[] = [];
  for (const work of results.slice(0, MAX_RESULTS)) {
    if (typeof work !== "object" || work === null) continue;
    const entry = openAlexToEntry(work as OpenAlexWork);
    if (entry) mapped.push(entry);
  }

  const deduped = dedupeEntries(mapped);
  const used = new Set<string>();
  const out: CitationEntry[] = [];
  for (const entry of deduped) {
    const key = makeCiteKey(entry, used);
    used.add(key);
    out.push({ ...entry, key });
  }
  return { ok: true, entries: out };
}

/**
 * Back-compat FAIL-CLOSED wrapper over {@link searchOpenAlexDetailed}: returns
 * ordered, de-duplicated, stably-keyed `CitationEntry[]`, flattening any failure to
 * `[]`. Prefer the detailed form when a failed request must read differently from
 * an empty result set.
 */
export async function searchOpenAlex(
  query: string,
  opts: { fetch: typeof fetch; rows?: number },
): Promise<CitationEntry[]> {
  const outcome = await searchOpenAlexDetailed(query, opts);
  return outcome.ok ? outcome.entries : [];
}
