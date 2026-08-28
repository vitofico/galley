/**
 * Semantic Scholar literature-search core — a FOURTH search source behind the
 * IDENTICAL injected-fetch seam as literature-search.ts. Tests pin the happy path
 * (papers → mapped, keyed, deduped entries ready for toHayagriva), the
 * DISCRIMINATED outcome (real failure — notably the un-keyed 429 rate limit — vs.
 * honestly-empty), and the URL construction. Offline — a fake fetch supplies every
 * byte.
 */
import { describe, it, expect } from "vitest";
import {
  searchSemanticScholar,
  searchSemanticScholarDetailed,
  buildSemanticScholarSearchUrl,
} from "./semantic-scholar-search.js";
import { toHayagriva } from "./citation.js";

/** A fake `fetch` returning a Semantic Scholar search envelope as 200 JSON. */
function okFetch(data: unknown[]): typeof fetch {
  return (async () =>
    ({ ok: true, status: 200, json: async () => ({ total: data.length, offset: 0, data }) }) as unknown as Response) as typeof fetch;
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
  paperId: "204e3073870fae3d05bcbc2f6a8e263d9b72e776",
  externalIds: { DOI: "10.5555/attention" },
  title: "Attention Is All You Need",
  venue: "NeurIPS",
  year: 2017,
  authors: [{ name: "Ashish Vaswani" }, { name: "Noam Shazeer" }],
  journal: { name: "NeurIPS", volume: "30", pages: "5998-6008" },
  url: "https://www.semanticscholar.org/paper/204e3073870fae3d05bcbc2f6a8e263d9b72e776",
};

describe("buildSemanticScholarSearchUrl", () => {
  it("targets the fixed Graph API host with an encoded query + limit + fields", () => {
    const url = buildSemanticScholarSearchUrl("quantum gravity", 5);
    expect(url.startsWith("https://api.semanticscholar.org/graph/v1/paper/search?")).toBe(true);
    expect(url).toContain("query=");
    expect(url).toContain("quantum");
    expect(url).toContain("limit=5");
    expect(url).toContain("fields=");
  });

  it("sends NO credentials (the optional api key is never put on the URL)", () => {
    expect(buildSemanticScholarSearchUrl("x").toLowerCase()).not.toContain("api-key");
    expect(buildSemanticScholarSearchUrl("x").toLowerCase()).not.toContain("api_key");
  });

  it("clamps limit to a sane range", () => {
    expect(buildSemanticScholarSearchUrl("x", 0)).toContain("limit=1");
    expect(buildSemanticScholarSearchUrl("x", 9999)).toContain("limit=100");
  });
});

describe("searchSemanticScholarDetailed (injected fetch, discriminated outcome)", () => {
  it("maps papers to keyed CitationEntry[] ready for toHayagriva", async () => {
    let calledUrl = "";
    const fakeFetch = (async (url: string | URL | Request) => {
      calledUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ data: [ATTENTION] }) } as unknown as Response;
    }) as typeof fetch;

    const outcome = await searchSemanticScholarDetailed("attention", { fetch: fakeFetch, rows: 1 });
    expect(calledUrl).toContain("api.semanticscholar.org/graph/v1/paper/search");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entries).toHaveLength(1);
    const e = outcome.entries[0]!;
    expect(e.title).toBe("Attention Is All You Need");
    expect(e.author).toEqual(["Ashish Vaswani", "Noam Shazeer"]);
    expect(e.year).toBe("2017");
    expect(e.doi).toBe("10.5555/attention");
    expect(e.journal).toBe("NeurIPS");
    expect(e.volume).toBe("30");
    expect(e.pages).toBe("5998-6008");
    expect(e.url).toBe("https://www.semanticscholar.org/paper/204e3073870fae3d05bcbc2f6a8e263d9b72e776");
    expect(e.key).toBe("vaswani2017");
    expect(toHayagriva(e).startsWith("vaswani2017:")).toBe(true);
  });

  it("falls back to venue for the journal when no journal.name is present", async () => {
    const outcome = await searchSemanticScholarDetailed("x", {
      fetch: okFetch([{ title: "Venue Only", venue: "ICLR", year: 2021, authors: [{ name: "Jane Doe" }] }]),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entries[0]!.journal).toBe("ICLR");
    expect(outcome.entries[0]!.key).toBe("doe2021");
  });

  it("returns ok+empty for an empty/whitespace query WITHOUT fetching", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return {} as unknown as Response;
    }) as typeof fetch;
    expect(await searchSemanticScholarDetailed("", { fetch: fakeFetch })).toEqual({ ok: true, entries: [] });
    expect(await searchSemanticScholarDetailed("  ", { fetch: fakeFetch })).toEqual({ ok: true, entries: [] });
    expect(called).toBe(false);
  });

  it("distinguishes failure reasons from an honestly-empty result set", async () => {
    expect(await searchSemanticScholarDetailed("x", { fetch: explodingFetch })).toEqual({
      ok: false,
      reason: "network",
    });
    // The keyless rate limit (429) is a SERVER failure, not an empty result set.
    expect(await searchSemanticScholarDetailed("x", { fetch: notOkFetch(429) })).toEqual({
      ok: false,
      reason: "server",
    });
    const noArray = (async () =>
      ({ ok: true, status: 200, json: async () => ({ total: 0 }) }) as unknown as Response) as typeof fetch;
    expect(await searchSemanticScholarDetailed("x", { fetch: noArray })).toEqual({
      ok: false,
      reason: "malformed",
    });
    const badJson = (async () =>
      ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } }) as unknown as Response) as typeof fetch;
    expect(await searchSemanticScholarDetailed("x", { fetch: badJson })).toEqual({
      ok: false,
      reason: "malformed",
    });
    // An EMPTY data array is a real "no matches", NOT a failure.
    expect(await searchSemanticScholarDetailed("x", { fetch: okFetch([]) })).toEqual({
      ok: true,
      entries: [],
    });
  });

  it("skips papers with no usable metadata (no title and no authors)", async () => {
    const outcome = await searchSemanticScholarDetailed("x", {
      fetch: okFetch([{ year: 2001 }, { title: "Has Title" }]),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entries).toHaveLength(1);
    expect(outcome.entries[0]!.title).toBe("Has Title");
  });

  it("de-duplicates papers sharing a DOI (first wins, case-insensitive)", async () => {
    const outcome = await searchSemanticScholarDetailed("x", {
      fetch: okFetch([
        { title: "First", externalIds: { DOI: "10.1/SAME" } },
        { title: "Dup", externalIds: { DOI: "10.1/same" } },
        { title: "Other", externalIds: { DOI: "10.3/other" } },
      ]),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entries.map((e) => e.title)).toEqual(["First", "Other"]);
  });

  it("only stores an https://…semanticscholar.org/… url (host + scheme allowlist)", async () => {
    const outcome = await searchSemanticScholarDetailed("x", {
      fetch: okFetch([
        { title: "Insecure scheme", url: "http://www.semanticscholar.org/paper/x" },
        { title: "Wrong host", url: "https://evil.example.com/phish" },
        { title: "Secure", url: "https://www.semanticscholar.org/paper/abc" },
      ]),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entries[0]!.url).toBeUndefined(); // http rejected
    expect(outcome.entries[1]!.url).toBeUndefined(); // off-host https rejected
    expect(outcome.entries[2]!.url).toBe("https://www.semanticscholar.org/paper/abc");
  });

  it("strips a doi:/https://doi.org/ wrapper from externalIds.DOI", async () => {
    const outcome = await searchSemanticScholarDetailed("x", {
      fetch: okFetch([{ title: "Wrapped DOI", externalIds: { DOI: "https://doi.org/10.2/wrapped" } }]),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entries[0]!.doi).toBe("10.2/wrapped");
  });

  it("defaults every paper's type to article and skips null/non-object elements", async () => {
    const outcome = await searchSemanticScholarDetailed("x", {
      fetch: okFetch([null, "nope", { title: "Real Paper" }]),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entries).toHaveLength(1);
    expect(outcome.entries[0]!.title).toBe("Real Paper");
    expect(outcome.entries[0]!.type).toBe("article");
  });

  it("caps mapped papers at MAX_RESULTS (200) even on an oversized body", async () => {
    const many = Array.from({ length: 250 }, (_v, i) => ({ title: `Paper ${i}`, year: 1900 + i }));
    const outcome = await searchSemanticScholarDetailed("x", { fetch: okFetch(many) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entries).toHaveLength(200);
  });
});

describe("searchSemanticScholar (fail-closed wrapper)", () => {
  it("returns the entries on success", async () => {
    const r = await searchSemanticScholar("attention", { fetch: okFetch([ATTENTION]) });
    expect(r).toHaveLength(1);
    expect(r[0]!.key).toBe("vaswani2017");
  });
  it("flattens any failure to []", async () => {
    expect(await searchSemanticScholar("x", { fetch: notOkFetch(503) })).toEqual([]);
    expect(await searchSemanticScholar("x", { fetch: explodingFetch })).toEqual([]);
  });
  it("returns [] for an empty query without touching the network", async () => {
    expect(await searchSemanticScholar("   ", { fetch: explodingFetch })).toEqual([]);
  });
});
