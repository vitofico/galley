/**
 * Roadmap #17.1 (Mendeley sibling of the Zotero core): Mendeley Web API client
 * core — read-only, PURE except a single injected-fetch seam, fail-closed
 * (ADR-0016 posture). Mirrors zotero-library.ts exactly in structure and
 * security posture; the only deliberate divergences are the Mendeley specifics
 * called out below.
 *
 * Pulls the AUTHENTICATED user's OWN Mendeley library (`GET /documents`) and
 * maps each JSON document onto a `CitationEntry`, then runs the SAME
 * `dedupeEntries` semantics the .bib/RIS import path uses (DOI else title+year,
 * first wins), so a Mendeley pull and a pasted .bib collapse identically. Final
 * stable cite-keys are NOT assigned here: entries leave with an EMPTY `key` and
 * are rekeyed downstream by the web seam (`rekeyEntries`), exactly as the Zotero
 * path does.
 *
 * AUTH (OSS boundary): per galley's roadmap (internal/features.md OPERATOR CALL
 * 2026-06-15) the full OAuth "Link" redirect flow is HOSTED-ONLY (galley-cloud
 * C3); the OSS boundary is paste-a-token. Mendeley's token IS an OAuth2 *bearer
 * access token* the user obtains out-of-band and pastes; we send it ONLY as the
 * `Authorization: Bearer <token>` header. There is NO OAuth redirect/login flow
 * in this repo.
 *
 * Security posture (mirrors citation.ts / zotero-library.ts / browser-git-http.ts,
 * ADR-0016):
 *   - INJECTED fetch only — `deps.fetch` is required; the global is never used.
 *   - FIXED host: every URL is built from a constant base; callers cannot supply
 *     any URL part. Pagination markers are not followed verbatim (see below).
 *   - The bearer token travels ONLY in the `Authorization` header — never in the
 *     URL — and no error message ever echoes it (messages are constant strings
 *     plus, at most, an HTTP status code).
 *   - `redirect: "error"`: any redirect rejects the request (no cross-origin hop,
 *     no https→http downgrade) — REC-5 from the git-transport review.
 *   - Per-response size cap: a declared Content-Length over the cap aborts before
 *     reading (cancelling the body stream so the connection is not left
 *     draining), and the body is read through a CAPPED streaming reader: bytes
 *     are counted per chunk and the reader is cancelled THE MOMENT the cap is
 *     exceeded, so a length-lying / chunked hostile body can never be fully
 *     buffered into memory. (A post-read length check remains ONLY as the
 *     fallback for Response-likes without a body stream.)
 *   - Bounded pagination: at most {@link MENDELEY_MAX_PAGES} pages of
 *     {@link MENDELEY_PAGE_LIMIT} items; hitting the cap with more pages pending
 *     sets `truncated: true` honestly instead of looping forever.
 *   - FIXED-HOST PAGINATION: Mendeley paginates with an RFC-8288 `Link` header
 *     rel="next" whose URL carries an opaque `?marker=…`. We do NOT follow that
 *     upstream URL verbatim (a redirect-by-Link could otherwise smuggle a
 *     different host). Instead we EXTRACT the `marker` value, VALIDATE it against
 *     a strict charset, and REBUILD the next URL from our fixed base — exactly as
 *     the Zotero client rebuilds `start=` offsets. A marker that fails validation
 *     is a `bad-response`.
 *   - No AbortSignal timeout — citation.ts's seam has none and we mirror it; the
 *     injected fetch is where a host would add one.
 *
 * DIFFERENCES FROM ZOTERO (do not blindly copy these bits):
 *   - No user/group ref and no library id input — Mendeley pulls the caller's own
 *     library, so there is nothing to validate before IO except the token.
 *   - No If-Modified-Since-Version / Last-Modified-Version / 304 / notModified
 *     path and no libraryVersion in the result — Mendeley has no simple library
 *     version. KEEP: entries, truncated, and the ok/error shape.
 *   - The body is a JSON ARRAY of document objects, not BibTeX text. FAIL-CLOSED:
 *     a body that is not a JSON array is `bad-response`.
 *
 * The function never throws: every outcome is a structured
 * {@link FetchMendeleyLibraryResult}.
 */
import type { CitationEntry } from "./citation.js";
import { dedupeEntries } from "./citation.js";

/** Fixed Mendeley Web API host — never derived from caller input. */
export const MENDELEY_API_BASE = "https://api.mendeley.com";

/** Items per page; 100 is a sane upper bound for the `limit` query param. */
export const MENDELEY_PAGE_LIMIT = 100;

/** Hard page cap: 20 pages × 100 items = 2000 items before `truncated`. */
export const MENDELEY_MAX_PAGES = 20;

/** Per-response size cap (UTF-16 code units of the read text). */
export const MENDELEY_MAX_RESPONSE_CHARS = 2 * 1024 * 1024; // 2 MiB of text

export interface FetchMendeleyLibraryOptions {
  /** Mendeley OAuth2 bearer access token — sent ONLY as `Authorization: Bearer …`. */
  apiToken: string;
}

/** The single injected capability — no global-fetch fallback exists. */
export interface MendeleyFetchDeps {
  fetch: typeof fetch;
}

/** Typed, message-safe failure kinds (messages NEVER contain the token). */
export type MendeleyErrorKind =
  | "invalid-token" // empty token, or HTTP 401
  | "forbidden" // HTTP 403
  | "not-found" // HTTP 404
  | "rate-limited" // HTTP 429 — fail now, retry later
  | "upstream" // HTTP 5xx
  | "network" // injected fetch threw (includes redirect rejection)
  | "too-large" // a single response exceeded MENDELEY_MAX_RESPONSE_CHARS
  | "bad-response"; // unexpected status / non-JSON / non-array / bad marker

export interface MendeleyError {
  kind: MendeleyErrorKind;
  message: string;
}

export type FetchMendeleyLibraryResult =
  | {
      ok: true;
      entries: CitationEntry[];
      /** True when the page cap cut off a library with more pages pending. */
      truncated: boolean;
    }
  | { ok: false; error: MendeleyError };

function fail(kind: MendeleyErrorKind, message: string): FetchMendeleyLibraryResult {
  return { ok: false, error: { kind, message } };
}

/** Map a non-2xx status to its typed failure (constant, token-free messages). */
function failForStatus(status: number): FetchMendeleyLibraryResult {
  if (status === 401) return fail("invalid-token", "Mendeley rejected the access token (HTTP 401)");
  if (status === 403) return fail("forbidden", "access token lacks the required scope (HTTP 403)");
  if (status === 404) return fail("not-found", "Mendeley resource not found (HTTP 404)");
  if (status === 429) return fail("rate-limited", "Mendeley rate limit hit — retry later (HTTP 429)");
  if (status >= 500) return fail("upstream", `Mendeley upstream error (HTTP ${status})`);
  return fail("bad-response", `unexpected HTTP ${status} from Mendeley`);
}

// ---------------------------------------------------------------------------
// Type map: Mendeley document type -> internal/BibTeX type (default "article").
// Mirrors reference-import.ts's RIS_TYPE_MAP style; anything unlisted defaults.
// ---------------------------------------------------------------------------
const MENDELEY_TYPE_MAP: Record<string, string> = {
  journal: "article",
  magazine_article: "article",
  newspaper_article: "article",
  book: "book",
  book_section: "incollection",
  encyclopedia_article: "incollection",
  conference_proceedings: "inproceedings",
  working_paper: "unpublished",
  report: "techreport",
  web_page: "web",
  thesis: "phdthesis",
  generic: "misc",
  patent: "misc",
  statute: "misc",
  bill: "misc",
  case: "misc",
  film: "misc",
  hearing: "misc",
  television_broadcast: "misc",
  computer_program: "misc",
};

/** A Mendeley person record (author/editor). `last_name` is required to keep. */
interface MendeleyPerson {
  first_name?: string;
  last_name?: string;
}

/** The Mendeley document fields we consume (null fields are omitted by the API). */
interface MendeleyDocument {
  title?: string;
  type?: string;
  year?: number;
  source?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  abstract?: string;
  authors?: MendeleyPerson[];
  editors?: MendeleyPerson[];
  identifiers?: { doi?: string; isbn?: string; issn?: string; pmid?: string; arxiv?: string };
  websites?: string[];
}

/** Build "Family, Given" (or bare "Family") strings; skip persons with no last_name. */
function mapPersons(persons: MendeleyPerson[] | undefined): string[] | undefined {
  if (!Array.isArray(persons)) return undefined;
  const out: string[] = [];
  for (const p of persons) {
    if (!p || typeof p.last_name !== "string" || p.last_name.trim().length === 0) continue;
    const last = p.last_name.trim();
    const first = typeof p.first_name === "string" ? p.first_name.trim() : "";
    out.push(first.length > 0 ? `${last}, ${first}` : last);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Map ONE Mendeley document object to a `CitationEntry` (key left EMPTY — final
 * stable keys are assigned downstream by the web seam's `rekeyEntries`, exactly
 * as the Zotero path does). Unknown/empty fields are dropped, never guessed.
 */
function mapDocument(doc: MendeleyDocument): CitationEntry {
  const entry: CitationEntry = {
    key: "",
    type: (doc.type && MENDELEY_TYPE_MAP[doc.type]) ?? "article",
  };
  if (typeof doc.title === "string" && doc.title.length > 0) entry.title = doc.title;
  if (typeof doc.abstract === "string" && doc.abstract.length > 0) entry.abstract = doc.abstract;
  if (typeof doc.publisher === "string" && doc.publisher.length > 0) entry.publisher = doc.publisher;
  if (typeof doc.volume === "string" && doc.volume.length > 0) entry.volume = doc.volume;
  if (typeof doc.issue === "string" && doc.issue.length > 0) entry.number = doc.issue; // issue -> number
  if (typeof doc.pages === "string" && doc.pages.length > 0) entry.pages = doc.pages;
  if (typeof doc.source === "string" && doc.source.length > 0) entry.journal = doc.source; // source -> journal
  if (doc.identifiers && typeof doc.identifiers.doi === "string" && doc.identifiers.doi.length > 0) {
    entry.doi = doc.identifiers.doi;
  }
  if (Array.isArray(doc.websites) && typeof doc.websites[0] === "string" && doc.websites[0].length > 0) {
    entry.url = doc.websites[0]; // websites[0] -> url
  }
  // year only when it is an integer with a 4-digit value; else omit.
  if (typeof doc.year === "number" && Number.isInteger(doc.year) && /^\d{4}$/.test(String(doc.year))) {
    entry.year = String(doc.year);
  }
  const authors = mapPersons(doc.authors);
  if (authors) entry.author = authors;
  const editors = mapPersons(doc.editors);
  if (editors) entry.editor = editors;
  return entry;
}

/** A Response that may expose a web body stream (typed loosely for fakes). */
type ResponseLike = Response & { body?: ReadableStream<Uint8Array> | null };

/** Best-effort cancel of a response body stream (never throws). */
async function cancelBody(res: ResponseLike): Promise<void> {
  const body = res.body;
  if (body && typeof body.cancel === "function") {
    try {
      await body.cancel();
    } catch {
      /* already errored/locked — nothing to drain */
    }
  }
}

type CappedRead =
  | { ok: true; text: string }
  | { ok: false; kind: "too-large" | "unreadable" };

/**
 * Read a response body WITHOUT ever buffering more than `cap` bytes. When a web
 * stream is available we count bytes per chunk and `reader.cancel()` the instant
 * the running total exceeds the cap — a hostile chunked/length-lying upstream can
 * therefore exhaust at most `cap` memory, not ours. Chunks are only decoded once
 * the whole body is known to be under the cap. For Response-likes WITHOUT a body
 * stream (minimal fakes, exotic polyfills) we fall back to `text()` + a post-read
 * length check. (Copied verbatim from zotero-library.ts to keep this module
 * self-contained and the diff reviewable.)
 */
async function readTextCapped(res: ResponseLike, cap: number): Promise<CappedRead> {
  const body = res.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > cap) {
          // Cancel IMMEDIATELY — do not pull (or buffer) the rest of the body.
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          return { ok: false, kind: "too-large" };
        }
        chunks.push(value);
      }
    } catch {
      return { ok: false, kind: "unreadable" };
    }
    const buf = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      buf.set(c, at);
      at += c.byteLength;
    }
    try {
      return { ok: true, text: new TextDecoder().decode(buf) };
    } catch {
      return { ok: false, kind: "unreadable" };
    }
  }
  // Fallback (no stream): post-read check only — fakes/polyfills are trusted
  // test infrastructure, not the hostile-upstream path.
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { ok: false, kind: "unreadable" };
  }
  if (text.length > cap) return { ok: false, kind: "too-large" };
  return { ok: true, text };
}

/** Strict marker charset: opaque pagination tokens are URL-safe alnum + `._~-`. */
const MARKER_RE = /^[A-Za-z0-9._~-]+$/;

/**
 * Extract the `marker` value from an RFC-8288 `Link` header's rel="next" entry,
 * or null when there is no next page. We parse the URL inside the `<…>` and read
 * its `marker` query param — we NEVER follow the upstream URL verbatim (fixed-host
 * rule). Returns the marker STRING (unvalidated; the caller validates it) or null.
 */
function nextMarker(link: string | null): string | null {
  if (link === null) return null;
  // Find the <url>; …; rel="next" segment. A Link header may list several links
  // separated by top-level commas; we only need the one advertising rel="next".
  const match = /<([^>]*)>\s*;[^,]*\brel="next"/.exec(link);
  if (!match) return null;
  const rawUrl = match[1];
  if (typeof rawUrl !== "string") return null;
  // Read the marker query param out of the advertised URL without trusting its
  // host: a simple, dependency-free `?…&marker=…` scan over the query string.
  const q = rawUrl.indexOf("?");
  if (q === -1) return null;
  const query = rawUrl.slice(q + 1);
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq) !== "marker") continue;
    try {
      return decodeURIComponent(pair.slice(eq + 1));
    } catch {
      return pair.slice(eq + 1);
    }
  }
  return null;
}

/** Build the fixed-host documents URL for one page. Pure. */
function pageUrl(marker: string | null): string {
  const base = `${MENDELEY_API_BASE}/documents`;
  const params = `view=all&limit=${MENDELEY_PAGE_LIMIT}`;
  // The marker is already validated URL-safe; encode anyway (belt and braces).
  return marker !== null ? `${base}?${params}&marker=${encodeURIComponent(marker)}` : `${base}?${params}`;
}

/**
 * Fetch the authenticated user's whole Mendeley library (read-only) as deduped
 * `CitationEntry[]`. Uses ONLY the injected `deps.fetch`. Never throws — see the
 * module header for the posture and the fail-closed rules.
 */
export async function fetchMendeleyLibrary(
  opts: FetchMendeleyLibraryOptions,
  deps: MendeleyFetchDeps,
): Promise<FetchMendeleyLibraryResult> {
  const { apiToken } = opts;

  // ---- Pre-IO validation (fail closed BEFORE any network capability is used).
  if (typeof apiToken !== "string" || apiToken.trim().length === 0) {
    return fail("invalid-token", "an access token is required");
  }

  const mapped: CitationEntry[] = [];
  let marker: string | null = null;
  let truncated = false;

  for (let pageIndex = 0; pageIndex < MENDELEY_MAX_PAGES; pageIndex++) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiToken}`,
      Accept: "application/vnd.mendeley-document.1+json",
    };

    let res: Response;
    try {
      res = await deps.fetch(pageUrl(marker), { headers, redirect: "error" });
    } catch {
      // Constant message: a hostile thrown error must never smuggle the token
      // (or anything else) into our message.
      return fail("network", "network failure contacting Mendeley");
    }

    if (!res.ok) return failForStatus(res.status);

    // Size cap, fast path: a declared length over the cap aborts before reading —
    // and the body stream is cancelled so the connection is not left draining.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MENDELEY_MAX_RESPONSE_CHARS) {
      await cancelBody(res as ResponseLike);
      return fail("too-large", "Mendeley response exceeds the size cap");
    }
    // Capped streaming read: chunked / length-lying bodies are cut off (and the
    // reader cancelled) the moment they exceed the cap — never buffered.
    const read = await readTextCapped(res as ResponseLike, MENDELEY_MAX_RESPONSE_CHARS);
    if (!read.ok) {
      return read.kind === "too-large"
        ? fail("too-large", "Mendeley response exceeds the size cap")
        : fail("bad-response", "Mendeley response body was unreadable");
    }

    // FAIL-CLOSED on garbage: the body MUST parse to a JSON array of documents.
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      return fail("bad-response", "Mendeley response was not valid JSON");
    }
    if (!Array.isArray(parsed)) {
      return fail("bad-response", "Mendeley response was not a JSON array");
    }
    for (const doc of parsed) {
      if (doc && typeof doc === "object") mapped.push(mapDocument(doc as MendeleyDocument));
    }

    // Bounded, fixed-host pagination: rebuild the next URL from a VALIDATED marker.
    const raw = nextMarker(res.headers.get("Link"));
    if (raw === null) break;
    if (!MARKER_RE.test(raw)) {
      return fail("bad-response", "Mendeley pagination marker failed validation");
    }
    marker = raw;
    if (pageIndex === MENDELEY_MAX_PAGES - 1) truncated = true; // more pages pending
  }

  // DEDUPE with the SAME semantics as the .bib/RIS import path (DOI else
  // title+year, first wins) so a Mendeley pull and a pasted .bib collapse
  // identically. Final stable keys are assigned downstream by the web seam.
  const entries = dedupeEntries(mapped);
  return { ok: true, entries, truncated };
}
