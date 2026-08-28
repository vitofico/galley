/**
 * Roadmap #17.4: literature search — PURE core + a single injected-fetch IO seam.
 *
 * Feeds Galley's `@`-cite source from a live metadata search. Queries Crossref's
 * public works-search endpoint (`https://api.crossref.org/works?query=…`) through
 * an INJECTED `fetch` — never the global — exactly mirroring citation.ts's
 * resolver posture: fixed host, no credentials, no full-text (read-only
 * metadata). Each result item is a Crossref message envelope, so we reuse
 * citation.ts's `crossrefToEntry`, then `dedupeEntries` and assign stable keys
 * via `makeCiteKey`; the output is ready for `toHayagriva`.
 *
 * FAIL-CLOSED CHOICE: search is a best-effort, list-shaped capability feeding an
 * autocomplete, so on ANY failure — thrown network error, non-OK status,
 * malformed/Non-JSON body, or a body missing `message.items` — we return `[]`
 * rather than throw. (citation.ts's single-DOI resolver throws a typed error
 * because a failed resolve of a specific DOI is a hard error the user asked for;
 * a search that finds nothing degrades gracefully to "no results".) The seam
 * stays auditable and offline-testable with a fake fetch.
 */
import {
  type CitationEntry,
  type CrossrefMessage,
  crossrefToEntry,
  dedupeEntries,
  makeCiteKey,
} from "./citation.js";

const CROSSREF_WORKS_HOST = "https://api.crossref.org/works";
const DEFAULT_ROWS = 10;
const MIN_ROWS = 1;
const MAX_ROWS = 100;

/** Clamp a requested row count into Crossref's practical [1, 100] window. */
function clampRows(rows: number | undefined): number {
  const n = typeof rows === "number" && Number.isFinite(rows) ? Math.floor(rows) : DEFAULT_ROWS;
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, n));
}

/**
 * Build the fixed-host Crossref works-search URL for a query. No credentials, no
 * full-text — read-only metadata search only. Pure.
 */
export function buildSearchUrl(query: string, rows?: number): string {
  const params = new URLSearchParams({
    query: query.trim(),
    rows: String(clampRows(rows)),
  });
  return `${CROSSREF_WORKS_HOST}?${params.toString()}`;
}

/** The Crossref works-search envelope: `{ message: { items: [...] } }`. */
interface CrossrefSearchEnvelope {
  message?: { items?: CrossrefMessage[] };
}

/**
 * The outcome of a literature search. Crucially distinguishes a GENUINE empty
 * result set (`{ ok: true, entries: [] }` — Crossref answered, nothing matched)
 * from a FAILED request the user should hear about:
 *   - `network`   — the fetch threw (offline, DNS, CORS/CSP block, aborted).
 *   - `server`    — Crossref answered non-2xx (rate-limited 429, 5xx, …).
 *   - `malformed` — the body wasn't the expected `{ message: { items: [] } }`.
 * The legacy {@link searchLiterature} flattens this to `[]`, but the UI uses the
 * detailed form so "couldn't reach Crossref" reads differently from "no matches"
 * — otherwise a blocked request looks identical to a query that found nothing.
 */
export type LiteratureSearchOutcome =
  | { ok: true; entries: CitationEntry[] }
  | { ok: false; reason: "network" | "server" | "malformed" };

/**
 * Search Crossref for works matching `query`, returning a {@link LiteratureSearchOutcome}
 * that separates real failures from an honestly-empty result set. Uses ONLY the
 * injected `opts.fetch` (auditable + offline-testable). An empty/whitespace query
 * short-circuits to `{ ok: true, entries: [] }` without touching the network.
 */
export async function searchLiteratureDetailed(
  query: string,
  opts: { fetch: typeof fetch; rows?: number },
): Promise<LiteratureSearchOutcome> {
  if (typeof query !== "string" || query.trim().length === 0) {
    return { ok: true, entries: [] };
  }

  let res: Response;
  try {
    res = await opts.fetch(buildSearchUrl(query, opts.rows), {
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

  const items = (json as CrossrefSearchEnvelope).message?.items;
  // An empty `items` array is a real "no matches"; a MISSING array is a body we
  // didn't understand (malformed) — the two must not collapse together.
  if (!Array.isArray(items)) return { ok: false, reason: "malformed" };

  // Map each item through the shared Crossref→entry adapter; drop items with no
  // usable metadata (mirrors fetchCitation's "had no usable metadata" guard).
  const mapped: CitationEntry[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const entry = crossrefToEntry({ message: item });
    if (!entry.title && (!entry.author || entry.author.length === 0)) continue;
    mapped.push(entry);
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
 * Back-compat thin wrapper over {@link searchLiteratureDetailed}: returns ordered,
 * de-duplicated, stably-keyed `CitationEntry[]`, FAILING CLOSED to `[]` on any
 * network/parse error or a body without usable items. Prefer the detailed form
 * when you need to tell a failed request apart from an empty result set.
 */
export async function searchLiterature(
  query: string,
  opts: { fetch: typeof fetch; rows?: number },
): Promise<CitationEntry[]> {
  const outcome = await searchLiteratureDetailed(query, opts);
  return outcome.ok ? outcome.entries : [];
}
