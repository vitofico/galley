/**
 * Semantic Scholar literature search — a FOURTH search source alongside Crossref,
 * arXiv + OpenAlex. Semantic Scholar's Graph API
 * (`https://api.semanticscholar.org/graph/v1/paper/search`) is the closest thing
 * to "Google Scholar with an API": a CORS-friendly REST endpoint, no key required
 * (an optional key only raises rate limits), with rich CS/bio/medicine coverage.
 *
 * This core mirrors literature-search.ts's posture EXACTLY: a PURE core whose ONLY
 * IO is an INJECTED `fetch` (never the global), a FIXED HTTPS host, NO credentials,
 * read-only metadata, and a DISCRIMINATED outcome that keeps a real failure
 * (`network`/`server`/`malformed`) distinct from an honestly-empty result set —
 * notably the un-keyed rate limit (HTTP 429) surfaces as `server`, not as an empty
 * "no results". Mapped entries are deduped + stably keyed via citation.ts's
 * `dedupeEntries`/`makeCiteKey`, so a hit is byte-for-byte downstream-identical to
 * a Crossref hit (ready for `toHayagriva`, the same review→insert path).
 *
 * Like Crossref this is JSON (`{ data: [...] }`), so there is no XML/parser surface
 * — `res.json()` bounds the parse. We still cap the number of mapped papers
 * (`MAX_RESULTS`) so a surprising/hostile body can't make the map walk unbounded.
 */
import {
  type CitationEntry,
  dedupeEntries,
  makeCiteKey,
} from "./citation.js";
import type { LiteratureSearchOutcome } from "./literature-search.js";

const S2_SEARCH_HOST = "https://api.semanticscholar.org/graph/v1/paper/search";
/** The metadata fields we ask the Graph API to return (minimises payload). */
const S2_FIELDS = "title,year,authors,externalIds,venue,journal,url";
const DEFAULT_ROWS = 10;
const MIN_ROWS = 1;
const MAX_ROWS = 100;
/** Hard ceiling on papers mapped from one response, independent of `limit`. */
const MAX_RESULTS = 200;

/** Clamp a requested result count into Semantic Scholar's practical [1, 100] window. */
function clampRows(rows: number | undefined): number {
  const n = typeof rows === "number" && Number.isFinite(rows) ? Math.floor(rows) : DEFAULT_ROWS;
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, n));
}

/**
 * Build the fixed-host Semantic Scholar search URL for a query. No credentials —
 * the optional API key (an `x-api-key` header) is deliberately NOT sent. Pure.
 */
export function buildSemanticScholarSearchUrl(query: string, rows?: number): string {
  const params = new URLSearchParams({
    query: query.trim(),
    limit: String(clampRows(rows)),
    fields: S2_FIELDS,
  });
  return `${S2_SEARCH_HOST}?${params.toString()}`;
}

// --- Semantic Scholar JSON shape (only the fields we consume; all optional) ---
interface S2Author {
  name?: string | null;
}
interface S2Paper {
  paperId?: string | null;
  title?: string | null;
  year?: number | null;
  authors?: S2Author[] | null;
  externalIds?: { DOI?: string | null } | null;
  venue?: string | null;
  journal?: { name?: string | null; volume?: string | null; pages?: string | null } | null;
  url?: string | null;
}
interface S2Envelope {
  data?: S2Paper[];
}

const DOI_PREFIX_RE = /^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)/i;

/** Accept only an `https://…semanticscholar.org/…` landing page as the entry URL
 *  (host + scheme allowlist — defense in depth, matching the arXiv/OpenAlex cores
 *  so a hostile response can't plant an arbitrary https link in the bibliography). */
const S2_URL_RE = /^https:\/\/(?:[a-z0-9-]+\.)*semanticscholar\.org\/\S+$/i;

/** Strip a `doi:`/`https://doi.org/` wrapper to the bare DOI core. */
function bareDoi(input: string): string {
  return input.trim().replace(DOI_PREFIX_RE, "");
}

/**
 * Map ONE Semantic Scholar paper to a CitationEntry (key left for the caller to
 * assign). Returns null when the paper has no usable metadata (mirrors the Crossref
 * guard). Authors are stored as their full `name` ("Given Family") verbatim — the
 * SAME choice as the arXiv/OpenAlex cores; `makeCiteKey`/`familyName` handle that
 * form, and we avoid lossy family/given guesswork. The Graph API does not expose a
 * reliable work type in basic search, so we default to `article`. Pure.
 */
function s2ToEntry(paper: S2Paper): CitationEntry | null {
  const title = (paper.title ?? "").trim();
  const authors: string[] = [];
  for (const a of paper.authors ?? []) {
    const name = (a?.name ?? "").trim();
    if (name.length > 0) authors.push(name);
  }
  if (title.length === 0 && authors.length === 0) return null;

  const entry: CitationEntry = { key: "", type: "article" };
  if (title.length > 0) entry.title = title;
  if (authors.length > 0) entry.author = authors;

  if (typeof paper.year === "number" && Number.isFinite(paper.year)) {
    entry.year = String(paper.year);
  }
  const doiRaw = paper.externalIds?.DOI;
  if (doiRaw) {
    const doi = bareDoi(doiRaw);
    if (doi.length > 0) entry.doi = doi;
  }
  const journal = (paper.journal?.name ?? paper.venue ?? "").trim();
  if (journal.length > 0) entry.journal = journal;
  const volume = (paper.journal?.volume ?? "").trim();
  if (volume.length > 0) entry.volume = volume;
  const pages = (paper.journal?.pages ?? "").trim();
  if (pages.length > 0) entry.pages = pages;
  // Keep the Semantic Scholar landing page as the entry URL ONLY when it is a
  // well-formed https://…semanticscholar.org/… URL (host + scheme allowlist).
  const url = (paper.url ?? "").trim();
  if (S2_URL_RE.test(url)) entry.url = url;

  return entry;
}

/**
 * Search Semantic Scholar for papers matching `query`, returning a
 * {@link LiteratureSearchOutcome} (the SAME discriminated shape Crossref uses) that
 * separates a real failure from an honestly-empty result set. Uses ONLY the
 * injected `opts.fetch` (auditable + offline-testable). An empty/whitespace query
 * short-circuits to an empty success without touching the network. Never throws.
 */
export async function searchSemanticScholarDetailed(
  query: string,
  opts: { fetch: typeof fetch; rows?: number },
): Promise<LiteratureSearchOutcome> {
  if (typeof query !== "string" || query.trim().length === 0) {
    return { ok: true, entries: [] };
  }

  let res: Response;
  try {
    res = await opts.fetch(buildSemanticScholarSearchUrl(query, opts.rows), {
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

  const data = (json as S2Envelope).data;
  // An empty `data` array is a real "no matches"; a MISSING array is a body we
  // didn't understand (malformed) — the two must not collapse together.
  if (!Array.isArray(data)) return { ok: false, reason: "malformed" };

  const mapped: CitationEntry[] = [];
  for (const paper of data.slice(0, MAX_RESULTS)) {
    if (typeof paper !== "object" || paper === null) continue;
    const entry = s2ToEntry(paper as S2Paper);
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
 * Back-compat FAIL-CLOSED wrapper over {@link searchSemanticScholarDetailed}:
 * returns ordered, de-duplicated, stably-keyed `CitationEntry[]`, flattening any
 * failure to `[]`. Prefer the detailed form when a failed request must read
 * differently from an empty result set.
 */
export async function searchSemanticScholar(
  query: string,
  opts: { fetch: typeof fetch; rows?: number },
): Promise<CitationEntry[]> {
  const outcome = await searchSemanticScholarDetailed(query, opts);
  return outcome.ok ? outcome.entries : [];
}
