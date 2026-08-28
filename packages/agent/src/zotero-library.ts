/**
 * Roadmap #17.1: Zotero Web API client core — read-only, PURE except a single
 * injected-fetch seam, fail-closed (ADR-0016 posture).
 *
 * Pulls a user's or group's Zotero library as BibTeX (Web API v3,
 * `format=bibtex`) and feeds it through the EXISTING import path
 * (`importReferences` → parseBibtex + dedupeEntries + stable keying), so a
 * Zotero pull and a pasted .bib file produce byte-identical `CitationEntry[]`
 * semantics. No persistent sync state lives here: the caller passes
 * `previousLibraryVersion` in and gets `libraryVersion`
 * (`Last-Modified-Version`) out — that version round-trip is the WHOLE sync
 * contract of this slice.
 *
 * Security posture (mirrors citation.ts / browser-git-http.ts, ADR-0016):
 *   - INJECTED fetch only — `deps.fetch` is required; the global is never used.
 *   - FIXED host: the URL is built from a constant base + a validated
 *     digits-only library id; callers cannot supply any URL part.
 *   - The API key travels ONLY in the `Zotero-API-Key` header — never in the
 *     URL — and no error message ever echoes it (messages are constant strings
 *     plus, at most, an HTTP status code).
 *   - `redirect: "error"`: any redirect rejects the request (no cross-origin
 *     hop, no https→http downgrade) — REC-5 from the git-transport review.
 *   - Per-response size cap: a declared Content-Length over the cap aborts
 *     before reading (cancelling the body stream so the connection is not
 *     left draining), and the body is read through a CAPPED streaming reader:
 *     bytes are counted per chunk and the reader is cancelled THE MOMENT the
 *     cap is exceeded, so a length-lying / chunked hostile body can never be
 *     fully buffered into memory. citation.ts itself reads uncapped; we
 *     follow the STRICTER browser-git-http.ts pattern because library
 *     exports are big. (A post-read length check remains ONLY as the
 *     fallback for Response-likes without a body stream.)
 *   - Bounded pagination: at most {@link ZOTERO_MAX_PAGES} pages of
 *     {@link ZOTERO_PAGE_LIMIT} items; hitting the cap with more pages pending
 *     sets `truncated: true` honestly instead of looping forever.
 *   - No AbortSignal timeout — citation.ts's seam has none and we mirror it;
 *     the injected fetch is where a host would add one.
 *
 * FAIL-CLOSED CHOICE (malformed pages): a non-empty page that parses to ZERO
 * BibTeX entries is treated as a protocol error (`bad-response`) and the whole
 * call fails — we never silently return a partial library that the caller
 * might then "sync" over a good one. (An EMPTY body is a legitimately empty
 * library/page, not an error.)
 *
 * The function never throws: every outcome is a structured
 * {@link FetchZoteroLibraryResult}.
 */
import type { CitationEntry } from "./citation.js";
import { parseBibtex } from "./citation.js";
import { importReferences } from "./reference-import.js";

/** Fixed Zotero Web API host — never derived from caller input. */
export const ZOTERO_API_BASE = "https://api.zotero.org";

/** Items per page; 100 is the Web API v3 maximum for `limit`. */
export const ZOTERO_PAGE_LIMIT = 100;

/** Hard page cap: 20 pages × 100 items = 2000 items before `truncated`. */
export const ZOTERO_MAX_PAGES = 20;

/** Per-response size cap (UTF-16 code units of the read text). */
export const ZOTERO_MAX_RESPONSE_CHARS = 2 * 1024 * 1024; // 2 MiB of text

/** Which Zotero library to read. */
export interface ZoteroLibraryRef {
  kind: "user" | "group";
  /** Numeric Zotero userID / groupID, as a digits-only string. */
  id: string;
}

export interface FetchZoteroLibraryOptions {
  /** Zotero API key — sent ONLY as the `Zotero-API-Key` header. */
  apiKey: string;
  library: ZoteroLibraryRef;
  /**
   * The `libraryVersion` from a previous successful fetch. When given, the
   * first request carries `If-Modified-Since-Version` and an unchanged library
   * short-circuits to `notModified: true` (no entries transferred).
   */
  previousLibraryVersion?: number;
}

/** The single injected capability — no global-fetch fallback exists. */
export interface ZoteroFetchDeps {
  fetch: typeof fetch;
}

/** Typed, message-safe failure kinds (messages NEVER contain the api key). */
export type ZoteroErrorKind =
  | "invalid-library" // bad kind / non-numeric id (rejected before any IO)
  | "invalid-key" // empty key, or HTTP 401
  | "forbidden" // HTTP 403 (key lacks access to this library)
  | "not-found" // HTTP 404
  | "rate-limited" // HTTP 429 — fail now, retry later; we honor nothing else
  | "upstream" // HTTP 5xx
  | "network" // injected fetch threw (includes redirect rejection)
  | "too-large" // a single response exceeded ZOTERO_MAX_RESPONSE_CHARS
  | "bad-response"; // unexpected status / unrequested 304 / unparseable page

export interface ZoteroError {
  kind: ZoteroErrorKind;
  message: string;
}

export type FetchZoteroLibraryResult =
  | {
      ok: true;
      entries: CitationEntry[];
      /** `Last-Modified-Version` of the library (null if absent/malformed). */
      libraryVersion: number | null;
      /** True when the 304 fast path fired; entries is empty, version unchanged. */
      notModified: boolean;
      /** True when the page cap cut off a library with more pages pending. */
      truncated: boolean;
    }
  | { ok: false; error: ZoteroError };

function fail(kind: ZoteroErrorKind, message: string): FetchZoteroLibraryResult {
  return { ok: false, error: { kind, message } };
}

/** Map a non-2xx, non-304 status to its typed failure (constant messages). */
function failForStatus(status: number): FetchZoteroLibraryResult {
  if (status === 401) return fail("invalid-key", "Zotero rejected the API key (HTTP 401)");
  if (status === 403) return fail("forbidden", "API key lacks access to this library (HTTP 403)");
  if (status === 404) return fail("not-found", "Zotero library not found (HTTP 404)");
  if (status === 429) return fail("rate-limited", "Zotero rate limit hit — retry later (HTTP 429)");
  if (status >= 500) return fail("upstream", `Zotero upstream error (HTTP ${status})`);
  return fail("bad-response", `unexpected HTTP ${status} from Zotero`);
}

/** Parse `Last-Modified-Version` strictly: a bare non-negative integer or null. */
function parseLibraryVersion(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) ? n : null;
}

/** Does an RFC-8288 `Link` header advertise a rel="next" page? */
function linkHasNext(link: string | null): boolean {
  return link !== null && /<[^>]*>\s*;[^,]*\brel="next"/.test(link);
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
 * Read a response body WITHOUT ever buffering more than `cap` bytes. When a
 * web stream is available we count bytes per chunk and `reader.cancel()` the
 * instant the running total exceeds the cap — a hostile chunked/length-lying
 * upstream can therefore exhaust at most `cap` memory, not ours. Chunks are
 * only decoded once the whole body is known to be under the cap. For
 * Response-likes WITHOUT a body stream (minimal fakes, exotic polyfills) we
 * fall back to `text()` + a post-read length check.
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

/** Build the fixed-host items URL for one page. Pure. */
function pageUrl(library: ZoteroLibraryRef, start: number): string {
  const segment = library.kind === "user" ? "users" : "groups";
  // The id is already validated digits-only; encode anyway (belt and braces).
  const base = `${ZOTERO_API_BASE}/${segment}/${encodeURIComponent(library.id)}/items`;
  const params = `format=bibtex&limit=${ZOTERO_PAGE_LIMIT}`;
  return start > 0 ? `${base}?${params}&start=${start}` : `${base}?${params}`;
}

/**
 * Fetch a whole Zotero library (read-only) as deduped, stably-keyed
 * `CitationEntry[]`. Uses ONLY the injected `deps.fetch`. Never throws — see
 * the module header for the posture and the fail-closed rules.
 */
export async function fetchZoteroLibrary(
  opts: FetchZoteroLibraryOptions,
  deps: ZoteroFetchDeps,
): Promise<FetchZoteroLibraryResult> {
  const { apiKey, library } = opts;

  // ---- Pre-IO validation (fail closed BEFORE any network capability is used).
  if (library.kind !== "user" && library.kind !== "group") {
    return fail("invalid-library", "library kind must be 'user' or 'group'");
  }
  if (typeof library.id !== "string" || !/^\d+$/.test(library.id)) {
    return fail("invalid-library", "library id must be a digits-only string");
  }
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    return fail("invalid-key", "an API key is required");
  }
  const prev =
    typeof opts.previousLibraryVersion === "number" &&
    Number.isSafeInteger(opts.previousLibraryVersion) &&
    opts.previousLibraryVersion >= 0
      ? opts.previousLibraryVersion
      : null;

  const pageTexts: string[] = [];
  let libraryVersion: number | null = null;
  let truncated = false;

  for (let pageIndex = 0; pageIndex < ZOTERO_MAX_PAGES; pageIndex++) {
    const headers: Record<string, string> = {
      "Zotero-API-Version": "3",
      "Zotero-API-Key": apiKey,
    };
    // Conditional fetch is a library-wide check, so it rides the FIRST request
    // only: if page 0 wasn't a 304, the library changed and later pages must
    // not be allowed to short-circuit.
    if (pageIndex === 0 && prev !== null) {
      headers["If-Modified-Since-Version"] = String(prev);
    }

    let res: Response;
    try {
      res = await deps.fetch(pageUrl(library, pageIndex * ZOTERO_PAGE_LIMIT), {
        headers,
        redirect: "error",
      });
    } catch {
      // Constant message: a hostile thrown error must never smuggle the key
      // (or anything else) into our message.
      return fail("network", "network failure contacting Zotero");
    }

    if (res.status === 304) {
      if (pageIndex === 0 && prev !== null) {
        return {
          ok: true,
          entries: [],
          libraryVersion: prev,
          notModified: true,
          truncated: false,
        };
      }
      return fail("bad-response", "unexpected HTTP 304 from Zotero");
    }
    if (!res.ok) return failForStatus(res.status);

    if (pageIndex === 0) {
      // Take the FIRST page's version: if the library mutates mid-pagination,
      // the lower version makes the next conditional fetch re-pull (fail-safe).
      libraryVersion = parseLibraryVersion(res.headers.get("Last-Modified-Version"));
    }

    // Size cap, fast path: a declared length over the cap aborts before
    // reading — and the body stream is cancelled so the connection is not
    // left draining behind us.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > ZOTERO_MAX_RESPONSE_CHARS) {
      await cancelBody(res as ResponseLike);
      return fail("too-large", "Zotero response exceeds the size cap");
    }
    // Capped streaming read: chunked / length-lying bodies are cut off (and
    // the reader cancelled) the moment they exceed the cap — never buffered.
    const read = await readTextCapped(res as ResponseLike, ZOTERO_MAX_RESPONSE_CHARS);
    if (!read.ok) {
      return read.kind === "too-large"
        ? fail("too-large", "Zotero response exceeds the size cap")
        : fail("bad-response", "Zotero response body was unreadable");
    }
    const text = read.text;
    // Fail closed on garbage: a NON-empty page yielding zero entries means we
    // are not talking the protocol we think we are. (Empty body = empty page.)
    if (text.trim().length > 0 && parseBibtex(text).length === 0) {
      return fail("bad-response", "Zotero page was not parseable BibTeX");
    }
    pageTexts.push(text);

    if (!linkHasNext(res.headers.get("Link"))) break;
    if (pageIndex === ZOTERO_MAX_PAGES - 1) truncated = true; // more pages pending
  }

  // One merged import: parse + dedupe + stable keying are EXACTLY the .bib
  // import path, and running it once keeps keys globally unique across pages.
  const entries = importReferences(pageTexts.join("\n\n"), "bibtex");
  return { ok: true, entries, libraryVersion, notModified: false, truncated };
}
