/**
 * Roadmap #17.4: literature search core. Crossref works-search behind the SAME
 * injected-fetch seam as citation.ts. Tests pin the happy path (results → mapped,
 * keyed, deduped entries) and the FAIL-CLOSED posture (network error / non-OK /
 * malformed JSON → []). Offline — a fake fetch supplies every byte.
 */
import { describe, it, expect } from "vitest";
import { searchLiterature, searchLiteratureDetailed, buildSearchUrl } from "./literature-search.js";
import { toHayagriva } from "./citation.js";

function fetchReturning(body: unknown, init?: { ok?: boolean; status?: number }): typeof fetch {
  return (async () => ({
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  })) as unknown as typeof fetch;
}

const TWO_ITEMS = {
  message: {
    items: [
      {
        DOI: "10.1/alpha",
        title: ["Alpha Paper"],
        author: [{ family: "Curie", given: "Marie" }],
        issued: { "date-parts": [[2008]] },
        type: "journal-article",
        "container-title": ["Nature"],
      },
      {
        DOI: "10.2/beta",
        title: ["Beta Paper"],
        author: [{ family: "Lovelace", given: "Ada" }],
        issued: { "date-parts": [[1843]] },
        type: "proceedings-article",
      },
    ],
  },
};

describe("buildSearchUrl", () => {
  it("targets the fixed Crossref works host with an encoded query + rows", () => {
    const url = buildSearchUrl("quantum gravity", 5);
    expect(url.startsWith("https://api.crossref.org/works?")).toBe(true);
    expect(url).toContain("query=quantum+gravity");
    expect(url).toContain("rows=5");
  });

  it("clamps rows to a sane range", () => {
    expect(buildSearchUrl("x", 0)).toContain("rows=1");
    expect(buildSearchUrl("x", 9999)).toContain("rows=100");
  });
});

describe("searchLiterature (injected fetch, fail-closed)", () => {
  it("maps Crossref search items to keyed CitationEntry[]", async () => {
    let calledUrl = "";
    const fakeFetch = (async (url: string | URL | Request) => {
      calledUrl = String(url);
      return { ok: true, status: 200, json: async () => TWO_ITEMS } as unknown as Response;
    }) as typeof fetch;

    const entries = await searchLiterature("nature", { fetch: fakeFetch, rows: 2 });
    expect(calledUrl).toContain("api.crossref.org/works?");
    expect(entries).toHaveLength(2);
    expect(entries[0]!.title).toBe("Alpha Paper");
    expect(entries[0]!.doi).toBe("10.1/alpha");
    expect(entries[1]!.title).toBe("Beta Paper");
    // every entry has a stable, non-empty key
    expect(entries.every((e) => e.key.length > 0)).toBe(true);
    // and is ready for toHayagriva (no throw, key is the top-level mapping key)
    expect(toHayagriva(entries[0]!).startsWith(`${entries[0]!.key}:`)).toBe(true);
  });

  it("de-duplicates results sharing a DOI (first wins)", async () => {
    const dup = {
      message: {
        items: [
          { DOI: "10.1/same", title: ["First"], type: "journal-article" },
          { DOI: "10.1/SAME", title: ["Dup, different case"], type: "journal-article" },
          { DOI: "10.3/other", title: ["Other"], type: "journal-article" },
        ],
      },
    };
    const entries = await searchLiterature("x", { fetch: fetchReturning(dup) });
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.title)).toEqual(["First", "Other"]);
  });

  it("returns [] for an empty/whitespace query without fetching", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return {} as unknown as Response;
    }) as typeof fetch;
    expect(await searchLiterature("", { fetch: fakeFetch })).toEqual([]);
    expect(await searchLiterature("   ", { fetch: fakeFetch })).toEqual([]);
    expect(called).toBe(false);
  });

  it("fails closed (→ []) on a non-OK HTTP response", async () => {
    const entries = await searchLiterature("x", {
      fetch: fetchReturning({}, { ok: false, status: 503 }),
    });
    expect(entries).toEqual([]);
  });

  it("fails closed (→ []) on a thrown network error", async () => {
    const fakeFetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect(await searchLiterature("x", { fetch: fakeFetch })).toEqual([]);
  });

  it("fails closed (→ []) on malformed JSON", async () => {
    const fakeFetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("bad json");
        },
      }) as unknown as Response) as typeof fetch;
    expect(await searchLiterature("x", { fetch: fakeFetch })).toEqual([]);
  });

  it("fails closed (→ []) on a non-object / missing-items body", async () => {
    expect(await searchLiterature("x", { fetch: fetchReturning(null) })).toEqual([]);
    expect(await searchLiterature("x", { fetch: fetchReturning("nope") })).toEqual([]);
    expect(await searchLiterature("x", { fetch: fetchReturning({ message: {} }) })).toEqual([]);
  });

  it("skips items with no usable metadata (no title and no authors)", async () => {
    const mixed = {
      message: {
        items: [
          { DOI: "10.1/empty", type: "journal-article" }, // nothing usable
          { DOI: "10.2/ok", title: ["Has Title"], type: "journal-article" },
        ],
      },
    };
    const entries = await searchLiterature("x", { fetch: fetchReturning(mixed) });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe("Has Title");
  });
});

describe("searchLiteratureDetailed (failure vs. empty)", () => {
  it("returns ok+entries on a populated response", async () => {
    const outcome = await searchLiteratureDetailed("nature", {
      fetch: fetchReturning(TWO_ITEMS),
      rows: 2,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.entries).toHaveLength(2);
  });

  it("treats a genuinely empty items array as ok (no matches), NOT a failure", async () => {
    const outcome = await searchLiteratureDetailed("zxqw", {
      fetch: fetchReturning({ message: { items: [] } }),
    });
    expect(outcome).toEqual({ ok: true, entries: [] });
  });

  it("an empty/whitespace query is ok+empty without fetching", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return {} as unknown as Response;
    }) as typeof fetch;
    expect(await searchLiteratureDetailed("  ", { fetch: fakeFetch })).toEqual({
      ok: true,
      entries: [],
    });
    expect(called).toBe(false);
  });

  it("reports `network` when the fetch throws (offline / blocked / CORS)", async () => {
    const fakeFetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect(await searchLiteratureDetailed("x", { fetch: fakeFetch })).toEqual({
      ok: false,
      reason: "network",
    });
  });

  it("reports `server` on a non-OK HTTP status (rate-limit / 5xx)", async () => {
    expect(
      await searchLiteratureDetailed("x", { fetch: fetchReturning({}, { ok: false, status: 429 }) }),
    ).toEqual({ ok: false, reason: "server" });
  });

  it("reports `malformed` on bad JSON or a body missing message.items", async () => {
    const badJson = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("bad json");
        },
      }) as unknown as Response) as typeof fetch;
    expect(await searchLiteratureDetailed("x", { fetch: badJson })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await searchLiteratureDetailed("x", { fetch: fetchReturning(null) })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await searchLiteratureDetailed("x", { fetch: fetchReturning({ message: {} }) })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});
