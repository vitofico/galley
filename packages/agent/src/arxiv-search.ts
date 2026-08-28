/**
 * Roadmap #6: arXiv literature search — a SECOND search source alongside Crossref.
 *
 * This mirrors literature-search.ts's posture EXACTLY: a PURE core whose ONLY IO
 * is an INJECTED `fetch` (never the global), a FIXED HTTPS host, NO credentials,
 * read-only metadata, and a DISCRIMINATED outcome (`searchArxivDetailed`) that keeps
 * a real failure (`network`/`server`/`malformed`) distinct from an honestly-empty
 * result set — so a blocked request can never masquerade as a confident "no
 * results". `searchArxiv` is the thin back-compat wrapper that flattens any failure
 * to `[]`. An empty/whitespace query short-circuits to an empty success without
 * touching the network. The mapped entries are deduped + stably keyed via
 * citation.ts's `dedupeEntries` / `makeCiteKey` so a hit is byte-for-byte
 * downstream-identical to a Crossref hit (ready for `toHayagriva`, the same
 * review→insert path).
 *
 * Telling EMPTY from GARBAGE needs one arXiv-specific probe: both yield zero
 * entries, so `hasFeedRoot` checks for a real `<feed>` element — the Atom analogue
 * of Crossref's `Array.isArray(message.items)` envelope check. No `<feed>` root ⇒
 * `malformed`; a `<feed>` with no entries ⇒ an honest empty success.
 *
 * The one real difference from Crossref is the wire format: arXiv's public API
 * (`https://export.arxiv.org/api/query`) returns ATOM XML, not JSON. Parsing XML
 * is a security surface, so we DELIBERATELY do NOT use any XML parser:
 *
 *   - XXE-PROOF: a dependency-free extractor. It NEVER processes a DTD, NEVER
 *     resolves external/general entities, and decodes ONLY the five predefined XML
 *     entities (& < > " ') — there is no numeric or general-entity expansion, so
 *     `<!ENTITY xxe SYSTEM "file:///etc/passwd">` + `&xxe;` can never resolve to
 *     file contents (the `&xxe;` reference is simply left inert / dropped). No new
 *     npm dependency is added.
 *
 *   - DoS-SAFE (wave-4 SEC-22.2 lesson, HARDENED after the GPT security round):
 *     EVERY scan is a bounded `indexOf` walk — there is NO non-greedy regex with
 *     multiple `[\s\S]*?` segments anywhere (those backtrack super-linearly on a
 *     single malformed block full of repeated unclosed tags, and `MAX_ENTRIES`
 *     does NOT help when the abuse is inside ONE entry). Concretely:
 *       * `splitEntries` walks `<entry>…</entry>` with `indexOf`, capped by
 *         `MAX_ENTRIES`, and clips any single block to `MAX_ENTRY_CHARS`.
 *       * `firstTagText` finds the first `<tag …>` open + its matching `</tag>`
 *         with `indexOf` (no regex over the body), clipping to `MAX_FIELD_CHARS`.
 *       * `authorNames` walks `<author>…</author>` groups with `indexOf`, bounded
 *         by `MAX_AUTHORS`, and on a missing close STOPS WITHOUT rescanning the
 *         tail (so N unclosed `<author>` opens is O(N), not O(N²)).
 *       * the whole body is rejected over `MAX_RESPONSE_CHARS` (Content-Length
 *         precheck where present, plus a post-read length check), and the entire
 *         parse/map/dedupe is wrapped so nothing can throw out of `searchArxiv`.
 *     Cost is strictly linear in the (capped) response length regardless of
 *     hostile padding or repeated unclosed tags.
 */
import {
  type CitationEntry,
  dedupeEntries,
  makeCiteKey,
} from "./citation.js";
import type { LiteratureSearchOutcome } from "./literature-search.js";

const ARXIV_API_HOST = "https://export.arxiv.org/api/query";
const DEFAULT_ROWS = 10;
const MIN_ROWS = 1;
const MAX_ROWS = 100;

// --- Defensive caps (all fail-closed; see file header) ----------------------
/** Reject a response body larger than this (≈5 MB of UTF-16 chars). A legitimate
 *  100-result Atom feed is well under this; a hostile/huge body is dropped → []. */
const MAX_RESPONSE_CHARS = 5_000_000;
/** Hard ceiling on `<entry>` blocks walked, independent of `max_results`. */
const MAX_ENTRIES = 500;
/** Clip any SINGLE entry block to this length before field extraction, so one
 *  giant entry cannot make per-field scans walk megabytes. */
const MAX_ENTRY_CHARS = 200_000;
/** Clip any extracted field (title/summary/id/…) to this length. */
const MAX_FIELD_CHARS = 50_000;
/** Cap authors collected per entry (bounds the author walk on hostile input). */
const MAX_AUTHORS = 200;

/** Clamp a requested result count into arXiv's practical [1, 100] window. */
function clampRows(rows: number | undefined): number {
  const n = typeof rows === "number" && Number.isFinite(rows) ? Math.floor(rows) : DEFAULT_ROWS;
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, n));
}

/**
 * Build the fixed-host arXiv API search URL for a query. No credentials. We scope
 * the query to `all:` (search across all metadata fields), which arXiv's API
 * expects in `search_query`. Pure.
 */
export function buildArxivSearchUrl(query: string, rows?: number): string {
  const params = new URLSearchParams({
    search_query: `all:${query.trim()}`,
    start: "0",
    max_results: String(clampRows(rows)),
  });
  return `${ARXIV_API_HOST}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Safe, dependency-free Atom extraction (XXE-proof + DoS-safe). See file header.
// All scans are bounded `indexOf` walks — NO multi-`[\s\S]*?` regexes.
// ---------------------------------------------------------------------------

/** Decode ONLY the five predefined XML entities. No numeric/general expansion —
 *  a `&xxe;`/`&#x41;` reference is left untouched (inert), never resolved. */
function decodeXmlEntities(s: string): string {
  // Single linear pass over a fixed, non-overlapping alternation. Each branch is a
  // literal predefined entity; anything else (including `&xxe;`, `&#65;`) is NOT
  // matched and so passes through verbatim. `&amp;` is handled in the same pass and
  // is NOT re-scanned, so there is no double-decoding and no rescan loop.
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_m, name: string) => {
    switch (name) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return _m;
    }
  });
}

/** Collapse internal whitespace/newlines, decode predefined entities, and clip to
 *  `MAX_FIELD_CHARS` (the clip happens BEFORE decode/collapse so we never process
 *  an unbounded slice). */
function cleanText(raw: string): string {
  const clipped = raw.length > MAX_FIELD_CHARS ? raw.slice(0, MAX_FIELD_CHARS) : raw;
  return decodeXmlEntities(clipped).replace(/\s+/g, " ").trim();
}

/**
 * Find the end (index just past `>`) of an element open tag that starts at
 * `openLt` (the index of `<`). Returns -1 if there is no `>` (malformed). Pure,
 * single `indexOf`.
 */
function openTagEnd(s: string, openLt: number): number {
  const gt = s.indexOf(">", openLt);
  return gt === -1 ? -1 : gt + 1;
}

/**
 * Confirm that the `<` at `lt` opens an element literally named `name` (the next
 * char after the name is `>`, whitespace, or `/`), so `<title>` matches but
 * `<titlefoo>` does not. `name` MUST be lowercase; `s` is matched case-insensitively
 * on the name span. Pure.
 */
function isOpenTagNamed(s: string, lt: number, name: string): boolean {
  if (s.slice(lt + 1, lt + 1 + name.length).toLowerCase() !== name) return false;
  const after = s[lt + 1 + name.length];
  return after === ">" || after === " " || after === "\t" || after === "\n" || after === "\r" || after === "/";
}

/**
 * Pull the inner text of the FIRST `<tag …>…</tag>` (any namespace prefix already
 * baked into `tag`, e.g. `arxiv:doi`) within `block`, via bounded `indexOf` only —
 * NO regex over the body. On a self-closing or unclosed tag, returns undefined
 * WITHOUT rescanning. Returns undefined if absent or empty.
 */
function firstTagText(block: string, tag: string): string | undefined {
  const lowerTag = tag.toLowerCase();
  const lower = block.toLowerCase();
  const needle = `<${lowerTag}`;
  let from = 0;
  // Walk candidate `<tag` occurrences until one is a real element open tag (guards
  // against `<titlefoo>`). Each step advances `from` past the candidate — linear.
  for (;;) {
    const lt = lower.indexOf(needle, from);
    if (lt === -1) return undefined;
    if (!isOpenTagNamed(block, lt, lowerTag)) {
      from = lt + needle.length;
      continue;
    }
    const bodyStart = openTagEnd(block, lt);
    if (bodyStart === -1) return undefined; // malformed open tag — no rescan
    // Self-closing `<tag …/>` has no inner text.
    if (block[bodyStart - 2] === "/") return undefined;
    const close = lower.indexOf(`</${lowerTag}>`, bodyStart);
    if (close === -1) return undefined; // unclosed — no inner text, no rescan
    const text = cleanText(block.slice(bodyStart, close));
    return text.length > 0 ? text : undefined;
  }
}

/**
 * Pull up to `MAX_AUTHORS` `<author>…<name>…</name>…</author>` names within an
 * entry block, in order, via bounded `indexOf` only — NO multi-`[\s\S]*?` regex.
 *
 * SECURITY (GPT round, Finding 1): on a `<author>` with no matching `</author>`,
 * we STOP (there is no further closeable group), never rescanning the tail — so N
 * repeated unclosed `<author>` opens cost O(N), not O(N²). Each closed group is
 * scanned exactly once and the per-group `<name>` lookup is bounded to that slice.
 */
function authorNames(block: string): string[] {
  const out: string[] = [];
  const lower = block.toLowerCase();
  let from = 0;
  while (out.length < MAX_AUTHORS) {
    const open = lower.indexOf("<author", from);
    if (open === -1) break;
    if (!isOpenTagNamed(block, open, "author")) {
      from = open + "<author".length;
      continue;
    }
    const openEnd = openTagEnd(block, open);
    if (openEnd === -1) break; // malformed open tag — stop, no rescan
    const close = lower.indexOf("</author>", openEnd);
    if (close === -1) {
      // Unclosed author: no closeable group remains. Stop WITHOUT rescanning.
      break;
    }
    // Extract the first <name>…</name> WITHIN this bounded [openEnd, close) slice.
    const inner = block.slice(openEnd, close);
    const name = firstTagText(inner, "name");
    if (name && name.length > 0) out.push(name);
    from = close + "</author>".length;
  }
  return out;
}

const DOI_PREFIX_RE = /^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)/i;

/** Strip a `doi:`/`https://doi.org/` wrapper to the bare DOI core (lowercased
 *  comparison happens downstream via citation.ts's `normDoi`). */
function bareDoi(input: string): string {
  return input.trim().replace(DOI_PREFIX_RE, "");
}

/**
 * Find a DOI for an entry: prefer the explicit `<arxiv:doi>` element, else a
 * `<link title="doi" href="…"/>` (arXiv emits the published DOI as a related
 * link). Returns the bare DOI core, or undefined. Bounded `indexOf` over `<link`
 * opens + single attribute regexes over ONE short open tag (no body scan); linear.
 */
function entryDoi(block: string): string | undefined {
  const explicit = firstTagText(block, "arxiv:doi");
  if (explicit) return bareDoi(explicit);
  const lower = block.toLowerCase();
  let from = 0;
  while (from < block.length) {
    const open = lower.indexOf("<link", from);
    if (open === -1) break;
    if (!isOpenTagNamed(block, open, "link")) {
      from = open + "<link".length;
      continue;
    }
    const openEnd = openTagEnd(block, open);
    if (openEnd === -1) break;
    const tag = block.slice(open, openEnd); // one bounded open tag only
    if (/\btitle=["']doi["']/i.test(tag)) {
      const hm = /\bhref=["']([^"']*)["']/i.exec(tag);
      if (hm && hm[1]) {
        const href = decodeXmlEntities(hm[1]).trim();
        if (href.length > 0) return bareDoi(href);
      }
    }
    from = openEnd;
  }
  return undefined;
}

/** Accept only an `http(s)://arxiv.org/abs/…` id as the entry URL (defense in
 *  depth — downstream already escapes, but we don't store arbitrary schemes). */
const ARXIV_ABS_RE = /^https?:\/\/(?:[a-z0-9-]+\.)*arxiv\.org\/abs\/\S+$/i;

/** Map ONE `<entry>` block's inner XML to a CitationEntry (key left for the caller
 *  to assign). Returns null when the block has no usable metadata. Pure. */
function entryToCitation(block: string): CitationEntry | null {
  const title = firstTagText(block, "title");
  const authors = authorNames(block);
  // Mirror literature-search.ts's "no usable metadata" guard: need a title OR
  // authors, else drop.
  if (!title && authors.length === 0) return null;

  const entry: CitationEntry = { key: "", type: "article" };
  if (title) entry.title = title;
  if (authors.length > 0) entry.author = authors;

  const summary = firstTagText(block, "summary");
  if (summary) entry.abstract = summary;

  const published = firstTagText(block, "published");
  if (published) {
    const ym = published.match(/\d{4}/);
    if (ym) entry.year = ym[0];
  }

  const doi = entryDoi(block);
  if (doi) entry.doi = doi;

  // The arXiv abstract page URL is the entry <id>. Keep it as the entry URL ONLY
  // when it is a well-formed arxiv.org/abs/… http(s) URL (scheme allowlist).
  const id = firstTagText(block, "id");
  if (id && ARXIV_ABS_RE.test(id)) entry.url = id;

  return entry;
}

/**
 * Is this body actually an Atom feed — i.e. does it contain a real `<feed …>`
 * element open tag? This is arXiv's ANALOGUE of Crossref's `Array.isArray(items)`
 * envelope check, and it is what lets `searchArxivDetailed` tell an honestly-EMPTY
 * feed (`<feed></feed>` — arXiv answered, nothing matched) apart from a body we
 * never understood (garbage, an HTML proxy/captive-portal error page, JSON). Both
 * yield zero entries, so without this probe the two collapse together and a failed
 * request lies as "No results".
 *
 * A bounded `indexOf` walk reusing `isOpenTagNamed` — NO regex over the body, and
 * each near-miss (`<feedfoo`) advances `from`, so a hostile body packed with them
 * is O(n), never a rescan blowup. Pure.
 */
function hasFeedRoot(xml: string): boolean {
  const lower = xml.toLowerCase();
  let from = 0;
  for (;;) {
    const lt = lower.indexOf("<feed", from);
    if (lt === -1) return false;
    if (isOpenTagNamed(xml, lt, "feed")) return true;
    from = lt + "<feed".length;
  }
}

/**
 * Walk the `<entry>…</entry>` blocks of an Atom feed with a SINGLE linear
 * `indexOf` scan (no regex over the whole document, no backtracking). Bounded by
 * `MAX_ENTRIES`; any single block is clipped to `MAX_ENTRY_CHARS` so one giant
 * entry cannot make downstream per-field scans walk megabytes. Returns the raw
 * inner-XML of each entry, in order. Pure.
 */
function splitEntries(xml: string): string[] {
  const out: string[] = [];
  const lower = xml.toLowerCase();
  let from = 0;
  while (out.length < MAX_ENTRIES) {
    const open = lower.indexOf("<entry", from);
    if (open === -1) break;
    if (!isOpenTagNamed(xml, open, "entry")) {
      from = open + "<entry".length;
      continue;
    }
    const openEnd = openTagEnd(xml, open);
    if (openEnd === -1) break;
    const close = lower.indexOf("</entry>", openEnd);
    if (close === -1) break; // unclosed final entry — stop, no rescan
    let inner = xml.slice(openEnd, close);
    if (inner.length > MAX_ENTRY_CHARS) inner = inner.slice(0, MAX_ENTRY_CHARS);
    out.push(inner);
    from = close + "</entry>".length;
  }
  return out;
}

/**
 * Search arXiv for works matching `query`, returning a {@link LiteratureSearchOutcome}
 * — the SAME discriminated shape Crossref/OpenAlex/Semantic-Scholar use — that keeps
 * a real failure distinct from an honestly-empty result set. Uses ONLY the injected
 * `opts.fetch` (auditable + offline-testable). Never throws. An empty/whitespace
 * query short-circuits to an empty success without touching the network.
 *
 * The failure taxonomy maps arXiv's OWN error paths onto the shared reasons:
 *   - `network`   — the fetch threw (offline, DNS, CORS/CSP block, aborted).
 *   - `server`    — arXiv answered non-2xx (rate-limited, 5xx, …).
 *   - `malformed` — the body was unreadable, empty, over-cap (Content-Length
 *     precheck or post-read), not an Atom feed at all (no `<feed>` root — garbage,
 *     an HTML proxy error page, JSON), or the parser threw unexpectedly.
 * A well-formed feed with zero entries — or whose entries carry no usable metadata
 * — is `{ ok: true, entries: [] }`: arXiv answered and nothing matched.
 *
 * Every security property of the parse is preserved verbatim: fixed HTTPS host, no
 * credentials, injected fetch, the response/entry/field/author caps, the
 * `arxiv.org/abs` URL allowlist, XXE-proof + backtracking-free `indexOf` scans, and
 * a catch-all around the whole parse so nothing can throw out of the seam.
 */
export async function searchArxivDetailed(
  query: string,
  opts: { fetch: typeof fetch; rows?: number },
): Promise<LiteratureSearchOutcome> {
  if (typeof query !== "string" || query.trim().length === 0) {
    return { ok: true, entries: [] };
  }

  let res: Response;
  try {
    res = await opts.fetch(buildArxivSearchUrl(query, opts.rows), {
      headers: { accept: "application/atom+xml" },
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  if (!res.ok) return { ok: false, reason: "server" };

  // Content-Length precheck (when present + honest): reject an oversized body
  // before reading it. A lying/absent header is still caught by the post-read cap.
  try {
    const cl = res.headers?.get?.("content-length");
    if (cl) {
      const n = Number(cl);
      if (Number.isFinite(n) && n > MAX_RESPONSE_CHARS) return { ok: false, reason: "malformed" };
    }
  } catch {
    // A header accessor that throws is non-fatal — fall through to the post cap.
  }

  let xml: string;
  try {
    xml = await res.text();
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof xml !== "string" || xml.length === 0) return { ok: false, reason: "malformed" };
  // Post-read cap: drop an oversized body rather than parse it.
  if (xml.length > MAX_RESPONSE_CHARS) return { ok: false, reason: "malformed" };

  // Wrap the entire parse/map/dedupe so NOTHING can throw out of the seam — any
  // unexpected parser error degrades to a typed failure (defense in depth).
  try {
    // A body with no `<feed>` root is one we never understood — a failure, NOT an
    // empty result (Crossref's `Array.isArray(items)` check, in Atom terms).
    if (!hasFeedRoot(xml)) return { ok: false, reason: "malformed" };

    // Past here the feed IS understood, so zero usable entries is an honest empty.
    const blocks = splitEntries(xml);
    const mapped: CitationEntry[] = [];
    for (const block of blocks) {
      const entry = entryToCitation(block);
      if (entry) mapped.push(entry);
    }

    const deduped = dedupeEntries(mapped);
    const used = new Set<string>();
    const result: CitationEntry[] = [];
    for (const entry of deduped) {
      const key = makeCiteKey(entry, used);
      used.add(key);
      result.push({ ...entry, key });
    }
    return { ok: true, entries: result };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

/**
 * Back-compat FAIL-CLOSED wrapper over {@link searchArxivDetailed}: returns ordered,
 * de-duplicated, stably-keyed `CitationEntry[]` ready for `toHayagriva` — the SAME
 * output shape as `searchLiterature` (Crossref) — flattening ANY failure to `[]`.
 * Prefer the detailed form when a failed request must read differently from an
 * empty result set (otherwise a blocked request lies to the reader as "no results").
 */
export async function searchArxiv(
  query: string,
  opts: { fetch: typeof fetch; rows?: number },
): Promise<CitationEntry[]> {
  const outcome = await searchArxivDetailed(query, opts);
  return outcome.ok ? outcome.entries : [];
}
