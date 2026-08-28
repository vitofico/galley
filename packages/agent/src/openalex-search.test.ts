/**
 * OpenAlex literature-search core — a THIRD search source behind the IDENTICAL
 * injected-fetch seam as literature-search.ts. Tests pin the happy path (works →
 * mapped, keyed, deduped entries ready for toHayagriva), the DISCRIMINATED outcome
 * (real failure vs. honestly-empty), and the URL construction. Offline — a fake
 * fetch supplies every byte.
 */
import { describe, it, expect } from "vitest";
import {
  searchOpenAlex,
  searchOpenAlexDetailed,
  buildOpenAlexSearchUrl,
} from "./openalex-search.js";
import { toHayagriva } from "./citation.js";

/** A fake `fetch` returning an OpenAlex works envelope as 200 JSON. */
function okFetch(results: unknown[]): typeof fetch {
  return (async () =>
    ({ ok: true, status: 200, json: async () => ({ results }) }) as unknown as Response) as typeof fetch;
}

/** A fake `fetch` that returns a non-OK response. */
function notOkFetch(status: number): typeof fetch {
  return (async () =>
    ({ ok: false, status, json: async () => ({}) }) as unknown as Response) as typeof fetch;
}

/** A fake `fetch` that throws (network failure). */
const explodingFetch: typeof fetch = (async () => {
  throw new Error("offline");
}) as unknown as typeof fetch;

const ATTENTION = {
  id: "https://openalex.org/W2741809807",
  doi: "https://doi.org/10.5555/attention",
  title: "Attention Is All You Need",
  display_name: "Attention Is All You Need",
  publication_year: 2017,
  type: "article",
  authorships: [
    { author: { display_name: "Ashish Vaswani" } },
    { author: { display_name: "Noam Shazeer" } },
  ],
  primary_location: { source: { display_name: "NeurIPS", host_organization_name: "Curran" } },
  biblio: { volume: "30", issue: "1", first_page: "5998", last_page: "6008" },
};

describe("buildOpenAlexSearchUrl", () => {
  it("targets the fixed OpenAlex host with an encoded query + per_page", () => {
    const url = buildOpenAlexSearchUrl("quantum gravity", 5);
    expect(url.startsWith("https://api.openalex.org/works?")).toBe(true);
    expect(url).toContain("search=");
    expect(url).toContain("quantum");
    expect(url).toContain("gravity");
    expect(url).toContain("per_page=5");
  });

  it("sends NO credentials / mailto (anonymous common pool)", () => {
    const url = buildOpenAlexSearchUrl("x");
    expect(url.toLowerCase()).not.toContain("mailto");
    expect(url.toLowerCase()).not.toContain("api_key");
  });

  it("clamps per_page to a sane range", () => {
    expect(buildOpenAlexSearchUrl("x", 0)).toContain("per_page=1");
    expect(buildOpenAlexSearchUrl("x", 9999)).toContain("per_page=100");
  });
});

describe("searchOpenAlexDetailed (injected fetch, discriminated outcome)", () => {
  it("maps works to keyed CitationEntry[] ready for toHayagriva", async () => {
    let calledUrl = "";
    const fakeFetch = (async (url: string | URL | Request) => {
      calledUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ results: [ATTENTION] }) } as unknown as Response;
    }) as typeof fetch;

    const outcome = await searchOpenAlexDetailed("attention", { fetch: fakeFetch, rows: 1 });
    expect(calledUrl).toContain("api.openalex.org/works");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entries).toHaveLength(1);
    const e = outcome.entries[0]!;
    expect(e.title).toBe("Attention Is All You Need");
    expect(e.author).toEqual(["Ashish Vaswani", "Noam Shazeer"]);
    expect(e.year).toBe("2017");
    expect(e.doi).toBe("10.5555/attention"); // https://doi.org/ wrapper stripped
    expect(e.journal).toBe("NeurIPS");
    expect(e.publisher).toBe("Curran");
    expect(e.volume).toBe("30");
    expect(e.number).toBe("1");
    expect(e.pages).toBe("5998-6008");
    expect(e.url).toBe("https://openalex.org/W2741809807");
    expect(e.key).toBe("vaswani2017");
    expect(toHayagriva(e).startsWith("vaswani2017:")).toBe(true);
  });

  it("falls back to display_name when title is absent; single page when no last_page", async () => {
    const outcome = await searchOpenAlexDetailed("x", {
      fetch: okFetch([
        {
          display_name: "Only A Display Name",
          publication_year: 2020,
          authorships: [{ author: { display_name: "Jane Doe" } }],
          biblio: { first_page: "7" },
        },
      ]),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entries[0]!.title).toBe("Only A Display Name");
    expect(outcome.entries[0]!.pages).toBe("7");
    expect(outcome.entries[0]!.key).toBe("doe2020");
  });

  it("returns ok+empty for an empty/whitespace query WITHOUT fetching", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return {} as unknown as Response;
    }) as typeof fetch;
    expect(await searchOpenAlexDetailed("", { fetch: fakeFetch })).toEqual({ ok: true, entries: [] });
    expect(await searchOpenAlexDetailed("  ", { fetch: fakeFetch })).toEqual({ ok: true, entries: [] });
    expect(called).toBe(false);
  });

  it("distinguishes failure reasons from an honestly-empty result set", async () => {
    expect(await searchOpenAlexDetailed("x", { fetch: explodingFetch })).toEqual({
      ok: false,
      reason: "network",
    });
    expect(await searchOpenAlexDetailed("x", { fetch: notOkFetch(429) })).toEqual({
      ok: false,
      reason: "server",
    });
    // A 200 body that isn't the expected envelope (no results array) is malformed.
    const noArray = (async () =>
      ({ ok: true, status: 200, json: async () => ({ meta: {} }) }) as unknown as Response) as typeof fetch;
    expect(await searchOpenAlexDetailed("x", { fetch: noArray })).toEqual({
      ok: false,
      reason: "malformed",
    });
    // Non-JSON body is malformed.
    const badJson = (async () =>
      ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } }) as unknown as Response) as typeof fetch;
    expect(await searchOpenAlexDetailed("x", { fetch: badJson })).toEqual({
      ok: false,
      reason: "malformed",
    });
    // An EMPTY results array is a real "no matches", NOT a failure.
    expect(await searchOpenAlexDetailed("x", { fetch: okFetch([]) })).toEqual({
      ok: true,
      entries: [],
    });
  });

  it("skips works with no usable metadata (no title and no authors)", async () => {
    const outcome = await searchOpenAlexDetailed("x", {
      fetch: okFetch([{ publication_year: 2001 }, { title: "Has Title" }]),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entries).toHaveLength(1);
    expect(outcome.entries[0]!.title).toBe("Has Title");
  });

  it("de-duplicates works sharing a DOI (first wins, case-insensitive)", async () => {
    const outcome = await searchOpenAlexDetailed("x", {
      fetch: okFetch([
        { title: "First", doi: "https://doi.org/10.1/SAME" },
        { title: "Dup", doi: "10.1/same" },
        { title: "Other", doi: "10.3/other" },
      ]),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entries.map((e) => e.title)).toEqual(["First", "Other"]);
  });

  it("maps the OpenAlex type vocabulary to internal entry types (and defaults)", async () => {
    const outcome = await searchOpenAlexDetailed("x", {
      fetch: okFetch([
        { title: "Chapter", type: "book-chapter" },
        { title: "Proc", type: "proceedings-article" },
        { title: "Book Upper", type: "BOOK" }, // proves the toLowerCase normalization
        { title: "Diss", type: "dissertation" },
        { title: "Report", type: "report" },
        { title: "Data", type: "dataset" },
        { title: "Mystery", type: "some-unknown-type" }, // → default "article"
        { title: "No Type" }, // missing type → default "article"
      ]),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entries.map((e) => e.type)).toEqual([
      "inbook",
      "inproceedings",
      "book",
      "phdthesis",
      "techreport",
      "misc",
      "article",
      "article",
    ]);
  });

  it("uses raw_author_name when an authorship has no resolved author object", async () => {
    const outcome = await searchOpenAlexDetailed("x", {
      fetch: okFetch([
        {
          title: "Raw Name Fallback",
          publication_year: 2018,
          authorships: [{ raw_author_name: "Margaret Hamilton" }],
        },
      ]),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entries[0]!.author).toEqual(["Margaret Hamilton"]);
    // The fallback name still drives the deterministic cite-key.
    expect(outcome.entries[0]!.key).toBe("hamilton2018");
  });

  it("skips null / non-object elements in the results array without crashing", async () => {
    const outcome = await searchOpenAlexDetailed("x", {
      fetch: okFetch([null, "not an object", 42, { title: "Real Work" }]),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entries).toHaveLength(1);
    expect(outcome.entries[0]!.title).toBe("Real Work");
  });

  it("caps mapped works at MAX_RESULTS (200) even on an oversized body", async () => {
    // 250 DISTINCT works (distinct titles/years so dedupe keeps them all) — the
    // in-body MAX_RESULTS slice must truncate to 200 regardless of per_page.
    const many = Array.from({ length: 250 }, (_v, i) => ({
      title: `Work ${i}`,
      publication_year: 1900 + i,
    }));
    const outcome = await searchOpenAlexDetailed("x", { fetch: okFetch(many) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entries).toHaveLength(200);
  });

  it("only stores an https://openalex.org/… id as the entry url (allowlist)", async () => {
    const outcome = await searchOpenAlexDetailed("x", {
      fetch: okFetch([
        { id: "javascript:alert(1)", title: "Evil Id" },
        { id: "https://openalex.org/W1", title: "Good Id" },
      ]),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entries[0]!.url).toBeUndefined();
    expect(outcome.entries[1]!.url).toBe("https://openalex.org/W1");
  });
});

describe("searchOpenAlex (fail-closed wrapper)", () => {
  it("returns the entries on success", async () => {
    const r = await searchOpenAlex("attention", { fetch: okFetch([ATTENTION]) });
    expect(r).toHaveLength(1);
    expect(r[0]!.key).toBe("vaswani2017");
  });
  it("flattens any failure to []", async () => {
    expect(await searchOpenAlex("x", { fetch: notOkFetch(503) })).toEqual([]);
    expect(await searchOpenAlex("x", { fetch: explodingFetch })).toEqual([]);
  });
  it("returns [] for an empty query without touching the network", async () => {
    expect(await searchOpenAlex("   ", { fetch: explodingFetch })).toEqual([]);
  });
});
