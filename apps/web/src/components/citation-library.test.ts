import { describe, it, expect } from "vitest";
import {
  importLibrary,
  searchCitations,
  searchCitationsDetailed,
  entryToResolved,
  bibEntryText,
  filterCitationRows,
} from "./citation-library.js";
import { parseBibtex } from "@galley/agent";
import type { CrossrefMessage } from "@galley/agent";

/**
 * Lane B (#17.1 library import + #17.4 literature search) — the pure helpers the
 * CitationPanel mounts. Per the repo's Node-env house pattern (CitationPanel.test
 * / ImportPanel.test) we test the exported helpers directly; the rendered overlay
 * + click flow is covered by the Playwright e2e.
 *
 * The fetch seam stays INJECTED + fail-closed — these tests never touch the
 * network: a fake fetch returns a Crossref search envelope (success) or a non-OK
 * response / rejection (failure), the exact shape `searchLiterature` consumes.
 */

const BIBTEX_LIBRARY = `@article{vaswani2017,
  title = {Attention Is All You Need},
  author = {Vaswani, Ashish and Shazeer, Noam},
  year = {2017},
  journal = {NeurIPS}
}
@book{knuth1984,
  title = {The TeXbook},
  author = {Knuth, Donald E.},
  year = {1984},
  publisher = {Addison-Wesley}
}`;

const RIS_LIBRARY = `TY  - JOUR
TI  - A Study of Things
AU  - Lovelace, Ada
PY  - 1843
JO  - Journal of Notes
ER  -
TY  - BOOK
TI  - On Computing
AU  - Babbage, Charles
PY  - 1837
ER  -
`;

/** A fake `fetch` returning a Crossref works-search envelope as 200 JSON. */
function okSearchFetch(items: CrossrefMessage[]): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ message: { items } }),
    }) as unknown as Response) as unknown as typeof fetch;
}

/** A fake `fetch` that returns a non-OK response (search fails closed → []). */
function notOkFetch(status: number): typeof fetch {
  return (async () =>
    ({
      ok: false,
      status,
      json: async () => ({}),
    }) as unknown as Response) as unknown as typeof fetch;
}

/** A fake `fetch` that throws (search fails closed → [], never re-throws). */
const explodingFetch: typeof fetch = (async () => {
  throw new Error("network down");
}) as unknown as typeof fetch;

describe("citation-library.importLibrary (#17.1)", () => {
  it("parses a BibTeX library into a reviewable, keyed list", () => {
    const r = importLibrary({ text: BIBTEX_LIBRARY });
    expect(r.parsedCount).toBe(2);
    expect(r.entries).toHaveLength(2);
    expect(r.duplicateCount).toBe(0);
    expect(r.entries[0]!.key).toBe("vaswani2017");
    expect(r.entries[0]!.entry.title).toBe("Attention Is All You Need");
    expect(r.entries[1]!.key).toBe("knuth1984");
    // Each row carries its rendered Hayagriva for the bibliography write.
    expect(r.entries[0]!.hayagriva).toContain("vaswani2017:");
  });

  it("parses an RIS library (format auto-detected)", () => {
    const r = importLibrary({ text: RIS_LIBRARY });
    expect(r.parsedCount).toBe(2);
    expect(r.entries.map((e) => e.entry.title)).toEqual([
      "A Study of Things",
      "On Computing",
    ]);
    expect(r.entries[0]!.key).toBe("lovelace1843");
  });

  it("dedupes parsed entries against the existing bibliography keys", () => {
    // vaswani2017 already exists → its imported twin is flagged duplicate and the
    // new key is collision-suffixed so an Add never clobbers the existing entry.
    const r = importLibrary({
      text: BIBTEX_LIBRARY,
      existingKeys: ["vaswani2017"],
    });
    expect(r.parsedCount).toBe(2);
    const vaswani = r.entries.find((e) => e.entry.title === "Attention Is All You Need")!;
    expect(vaswani.duplicate).toBe(true);
    expect(vaswani.key).not.toBe("vaswani2017");
    expect(vaswani.key).toContain("vaswani2017");
    // knuth1984 is new → not flagged.
    const knuth = r.entries.find((e) => e.entry.title === "The TeXbook")!;
    expect(knuth.duplicate).toBe(false);
    expect(r.duplicateCount).toBe(1);
  });

  it("returns an empty, non-throwing result for junk / empty text", () => {
    expect(importLibrary({ text: "" }).entries).toHaveLength(0);
    expect(importLibrary({ text: "   " }).parsedCount).toBe(0);
    const junk = importLibrary({ text: "not a citation library at all" });
    expect(junk.entries).toHaveLength(0);
    expect(junk.formatNote).toBeUndefined();
  });

  it("surfaces the auto-detect format fallback on the summary channel", () => {
    // A malformed BibTeX opener ahead of a valid RIS block: detection picks
    // bibtex (zero entries) -> the import falls back to RIS and SAYS so.
    const r = importLibrary({
      text: "@article{broken, title={Unclosed\nTY  - JOUR\nTI  - Rescued Work\nER  -\n",
    });
    expect(r.parsedCount).toBe(1);
    expect(r.entries[0]!.entry.title).toBe("Rescued Work");
    expect(r.formatNote).toContain("imported as ris");
    // ...and a clean parse carries no note.
    expect(importLibrary({ text: BIBTEX_LIBRARY }).formatNote).toBeUndefined();
  });

  it("surfaces the honest parsed-of-seen count when an entry is malformed (G4)", () => {
    // #2 is unbalanced; the parser resyncs past it so #1 and #3 still import, and
    // the summary reports "parsed 2 of 3 — 1 malformed entry skipped".
    const r = importLibrary({
      text: [
        "@article{first2000, title={Alpha}, year={2000}}",
        "@article{broken, title={Unclosed",
        "@article{last2001, title={Omega}, year={2001}}",
      ].join("\n"),
    });
    expect(r.entries.map((e) => e.entry.title)).toEqual(["Alpha", "Omega"]);
    expect(r.seenCount).toBe(3);
    expect(r.malformedCount).toBe(1);
  });

  it("a clean library reports zero malformed (the skipped-note is hidden)", () => {
    const r = importLibrary({ text: BIBTEX_LIBRARY });
    expect(r.malformedCount).toBe(0);
    expect(r.seenCount).toBe(2);
  });

  it("each imported row is a ResolvedCitation ready for onAddToBibliography", () => {
    const r = importLibrary({ text: BIBTEX_LIBRARY });
    const row = r.entries[0]!;
    expect(row.kind).toBe("bibtex");
    expect(row.entry.key).toBe(row.key); // entry carries the assigned key
    expect(row.hayagriva).toContain(`${row.key}:`);
  });
});

describe("citation-library.searchCitations (#17.4)", () => {
  const ITEMS: CrossrefMessage[] = [
    {
      DOI: "10.1145/3292500",
      type: "journal-article",
      title: ["A Study of Things"],
      author: [{ family: "Lovelace", given: "Ada" }],
      issued: { "date-parts": [[1843]] },
      "container-title": ["Journal of Notes"],
    },
    {
      DOI: "10.1145/9999999",
      type: "journal-article",
      title: ["On Computing"],
      author: [{ family: "Babbage", given: "Charles" }],
      issued: { "date-parts": [[1837]] },
    },
  ];

  it("lists keyed, reviewable results from a successful search", async () => {
    const r = await searchCitations({ query: "computing", fetch: okSearchFetch(ITEMS) });
    expect(r).toHaveLength(2);
    expect(r[0]!.entry.title).toBe("A Study of Things");
    expect(r[0]!.key).toBe("lovelace1843");
    expect(r[0]!.kind).toBe("doi");
    // Each result is a full ResolvedCitation → same insert/add path as a paste.
    expect(r[0]!.hayagriva).toContain("lovelace1843:");
  });

  it("keys search results clear of the existing bibliography", async () => {
    const r = await searchCitations({
      query: "computing",
      fetch: okSearchFetch(ITEMS),
      existingKeys: ["lovelace1843"],
    });
    expect(r[0]!.key).not.toBe("lovelace1843");
    expect(r[0]!.key).toContain("lovelace1843");
  });

  it("fails closed to [] on a non-OK response (never throws)", async () => {
    await expect(
      searchCitations({ query: "computing", fetch: notOkFetch(503) }),
    ).resolves.toEqual([]);
  });

  it("fails closed to [] on a thrown network error", async () => {
    await expect(
      searchCitations({ query: "computing", fetch: explodingFetch }),
    ).resolves.toEqual([]);
  });

  it("returns [] for an empty query without touching the network", async () => {
    await expect(
      searchCitations({ query: "   ", fetch: explodingFetch }),
    ).resolves.toEqual([]);
  });
});

describe("citation-library.searchCitations — arXiv source (#6)", () => {
  /** A fake `fetch` returning an arXiv Atom feed as a 200 text body. */
  function okArxivFetch(body: string): typeof fetch {
    return (async () =>
      ({
        ok: true,
        status: 200,
        text: async () => body,
      }) as unknown as Response) as unknown as typeof fetch;
  }

  const ARXIV_FEED = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
    <entry>
      <id>http://arxiv.org/abs/1706.03762v5</id>
      <published>2017-06-12T17:57:34Z</published>
      <title>Attention Is All You Need</title>
      <summary>A study of attention.</summary>
      <author><name>Ashish Vaswani</name></author>
      <arxiv:doi>10.5555/3295222.3295349</arxiv:doi>
    </entry>
  </feed>`;

  it("routes to the arXiv backend and lists keyed, reviewable results", async () => {
    let calledUrl = "";
    const fakeFetch = (async (url: string | URL | Request) => {
      calledUrl = String(url);
      return { ok: true, status: 200, text: async () => ARXIV_FEED } as unknown as Response;
    }) as typeof fetch;

    const r = await searchCitations({ query: "attention", fetch: fakeFetch, source: "arxiv" });
    expect(calledUrl).toContain("export.arxiv.org/api/query");
    expect(r).toHaveLength(1);
    expect(r[0]!.entry.title).toBe("Attention Is All You Need");
    expect(r[0]!.key).toBe("vaswani2017");
    expect(r[0]!.kind).toBe("doi");
    expect(r[0]!.entry.doi).toBe("10.5555/3295222.3295349");
    expect(r[0]!.hayagriva).toContain("vaswani2017:");
  });

  it("defaults to Crossref when no source is given (existing behavior unchanged)", async () => {
    let calledUrl = "";
    const fakeFetch = (async (url: string | URL | Request) => {
      calledUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          message: {
            items: [
              {
                DOI: "10.1/x",
                type: "journal-article",
                title: ["A Crossref Work"],
                author: [{ family: "Curie", given: "Marie" }],
                issued: { "date-parts": [[2008]] },
              },
            ],
          },
        }),
      } as unknown as Response;
    }) as typeof fetch;
    const r = await searchCitations({ query: "computing", fetch: fakeFetch });
    expect(calledUrl).toContain("api.crossref.org/works");
    expect(r).toHaveLength(1);
    expect(r[0]!.entry.title).toBe("A Crossref Work");
  });

  it("fails closed to [] on a non-OK arXiv response (never throws)", async () => {
    await expect(
      searchCitations({
        query: "x",
        source: "arxiv",
        fetch: (async () =>
          ({ ok: false, status: 503, text: async () => "" }) as unknown as Response) as typeof fetch,
      }),
    ).resolves.toEqual([]);
  });

  it("returns [] for an empty arXiv query without touching the network", async () => {
    await expect(
      searchCitations({ query: "   ", source: "arxiv", fetch: explodingFetch }),
    ).resolves.toEqual([]);
  });

  it("labels a DOI-less arXiv hit with `url` provenance, not `doi` (CA-P3)", async () => {
    const feed = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <id>http://arxiv.org/abs/2001.00001</id>
        <published>2020-01-01T00:00:00Z</published>
        <title>A Preprint With No DOI</title>
        <author><name>Ada Lovelace</name></author>
      </entry>
    </feed>`;
    const r = await searchCitations({ query: "x", source: "arxiv", fetch: okArxivFetch(feed) });
    expect(r).toHaveLength(1);
    expect(r[0]!.entry.doi).toBeUndefined();
    expect(r[0]!.kind).toBe("url"); // an unpublished preprint is identified by its URL
  });
});

/**
 * arXiv's failure-vs-empty distinction, at the CONSUMER seam the panel reads.
 * arXiv used to be the lone source that always answered `{ ok: true }`, so a
 * blocked request surfaced as a confident "No results" — the panel could not tell
 * the two apart. These pin that it now reports like the other three sources.
 */
describe("citation-library.searchCitationsDetailed — arXiv failure vs empty", () => {
  const ARXIV_FEED_ONE = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
    <entry>
      <id>http://arxiv.org/abs/1706.03762v5</id>
      <published>2017-06-12T17:57:34Z</published>
      <title>Attention Is All You Need</title>
      <author><name>Ashish Vaswani</name></author>
      <arxiv:doi>10.5555/3295222.3295349</arxiv:doi>
    </entry>
  </feed>`;

  /** A fake `fetch` returning an arXiv Atom feed as a 200 text body. */
  function okArxivFetch(body: string): typeof fetch {
    return (async () =>
      ({ ok: true, status: 200, text: async () => body }) as unknown as Response) as typeof fetch;
  }

  it("surfaces a hit as a success with results", async () => {
    const outcome = await searchCitationsDetailed({
      query: "attention",
      source: "arxiv",
      fetch: okArxivFetch(ARXIV_FEED_ONE),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]!.entry.title).toBe("Attention Is All You Need");
  });

  it("surfaces an EMPTY arXiv feed as an honest empty success (not a failure)", async () => {
    const outcome = await searchCitationsDetailed({
      query: "zzzz",
      source: "arxiv",
      fetch: okArxivFetch(`<feed xmlns="http://www.w3.org/2005/Atom"></feed>`),
    });
    expect(outcome).toEqual({ ok: true, results: [] });
  });

  it("surfaces an arXiv NETWORK failure as a failure (was a silent 'No results')", async () => {
    const outcome = await searchCitationsDetailed({
      query: "attention",
      source: "arxiv",
      fetch: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    expect(outcome).toEqual({ ok: false, reason: "network" });
  });

  it("surfaces an arXiv SERVER failure as a failure", async () => {
    const outcome = await searchCitationsDetailed({
      query: "attention",
      source: "arxiv",
      fetch: (async () =>
        ({ ok: false, status: 503, text: async () => "" }) as unknown as Response) as typeof fetch,
    });
    expect(outcome).toEqual({ ok: false, reason: "server" });
  });

  it("surfaces an arXiv MALFORMED body as a failure", async () => {
    const outcome = await searchCitationsDetailed({
      query: "attention",
      source: "arxiv",
      fetch: okArxivFetch("<html><body>Blocked by proxy</body></html>"),
    });
    expect(outcome).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("citation-library.searchCitations — OpenAlex + Semantic Scholar sources", () => {
  /** A fake `fetch` returning an OpenAlex works envelope as 200 JSON. */
  function okOpenAlexFetch(results: unknown[]): typeof fetch {
    return (async () =>
      ({ ok: true, status: 200, json: async () => ({ results }) }) as unknown as Response) as typeof fetch;
  }
  /** A fake `fetch` returning a Semantic Scholar search envelope as 200 JSON. */
  function okS2Fetch(data: unknown[]): typeof fetch {
    return (async () =>
      ({ ok: true, status: 200, json: async () => ({ data }) }) as unknown as Response) as typeof fetch;
  }

  it("routes to OpenAlex and returns keyed, reviewable results", async () => {
    let calledUrl = "";
    const fakeFetch = (async (url: string | URL | Request) => {
      calledUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              title: "An OpenAlex Work",
              doi: "https://doi.org/10.1/oa",
              publication_year: 2019,
              authorships: [{ author: { display_name: "Grace Hopper" } }],
            },
          ],
        }),
      } as unknown as Response;
    }) as typeof fetch;
    const r = await searchCitations({ query: "x", fetch: fakeFetch, source: "openalex" });
    expect(calledUrl).toContain("api.openalex.org/works");
    expect(r).toHaveLength(1);
    expect(r[0]!.entry.title).toBe("An OpenAlex Work");
    expect(r[0]!.key).toBe("hopper2019");
    expect(r[0]!.kind).toBe("doi");
    expect(r[0]!.entry.doi).toBe("10.1/oa");
  });

  it("routes to Semantic Scholar and returns keyed, reviewable results", async () => {
    let calledUrl = "";
    const fakeFetch = (async (url: string | URL | Request) => {
      calledUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              title: "An S2 Paper",
              externalIds: { DOI: "10.2/s2" },
              year: 2020,
              authors: [{ name: "Katherine Johnson" }],
            },
          ],
        }),
      } as unknown as Response;
    }) as typeof fetch;
    const r = await searchCitations({ query: "x", fetch: fakeFetch, source: "semanticscholar" });
    expect(calledUrl).toContain("api.semanticscholar.org/graph/v1/paper/search");
    expect(r).toHaveLength(1);
    expect(r[0]!.entry.title).toBe("An S2 Paper");
    expect(r[0]!.key).toBe("johnson2020");
    expect(r[0]!.kind).toBe("doi");
  });

  it("keys results from the new sources clear of the existing bibliography", async () => {
    const r = await searchCitations({
      query: "x",
      source: "openalex",
      fetch: okOpenAlexFetch([
        { title: "Dup", authorships: [{ author: { display_name: "Grace Hopper" } }], publication_year: 2019 },
      ]),
      existingKeys: ["hopper2019"],
    });
    expect(r[0]!.key).not.toBe("hopper2019");
    expect(r[0]!.key).toContain("hopper2019");
  });

  it("surfaces a failure reason (not an empty list) for the JSON sources", async () => {
    const fail429 = (async () =>
      ({ ok: false, status: 429, json: async () => ({}) }) as unknown as Response) as typeof fetch;
    expect(await searchCitationsDetailed({ query: "x", source: "openalex", fetch: fail429 })).toEqual({
      ok: false,
      reason: "server",
    });
    expect(
      await searchCitationsDetailed({ query: "x", source: "semanticscholar", fetch: fail429 }),
    ).toEqual({ ok: false, reason: "server" });
  });

  it("an empty result set from a JSON source is ok+[], not a failure", async () => {
    expect(await searchCitationsDetailed({ query: "x", source: "openalex", fetch: okOpenAlexFetch([]) })).toEqual({
      ok: true,
      results: [],
    });
    expect(await searchCitationsDetailed({ query: "x", source: "semanticscholar", fetch: okS2Fetch([]) })).toEqual({
      ok: true,
      results: [],
    });
  });
});

describe("citation-library.searchCitationsDetailed (failure vs. empty)", () => {
  const ITEMS: CrossrefMessage[] = [
    {
      DOI: "10.1145/3292500",
      type: "journal-article",
      title: ["A Study of Things"],
      author: [{ family: "Lovelace", given: "Ada" }],
      issued: { "date-parts": [[1843]] },
    },
  ];

  it("ok+results on success", async () => {
    const outcome = await searchCitationsDetailed({ query: "x", fetch: okSearchFetch(ITEMS) });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.results).toHaveLength(1);
      expect(outcome.results[0]!.entry.title).toBe("A Study of Things");
    }
  });

  it("surfaces the failure reason instead of an empty list", async () => {
    expect(await searchCitationsDetailed({ query: "x", fetch: notOkFetch(429) })).toEqual({
      ok: false,
      reason: "server",
    });
    expect(await searchCitationsDetailed({ query: "x", fetch: explodingFetch })).toEqual({
      ok: false,
      reason: "network",
    });
  });
});

describe("citation-library.entryToResolved", () => {
  it("wraps an already-keyed entry into a ResolvedCitation with its kind", () => {
    const resolved = entryToResolved(
      { key: "doe2020", type: "article", title: "X", year: "2020" },
      "bibtex",
    );
    expect(resolved.key).toBe("doe2020");
    expect(resolved.kind).toBe("bibtex");
    expect(resolved.entry.key).toBe("doe2020");
    expect(resolved.hayagriva).toContain("doe2020:");
  });
});

describe("citation-library.bibEntryText", () => {
  // A `.bib` is compiled AS BibTeX and read back by `parseBibtex`; the
  // "Add to bibliography" path MUST emit BibTeX, not the review-only Hayagriva.
  const resolved = entryToResolved(
    {
      key: "doe2020",
      type: "article",
      title: "A Study of Things",
      author: ["Doe, Jane"],
      year: "2020",
      journal: "Journal of Things",
    },
    "bibtex",
  );

  it("emits BibTeX, not Hayagriva YAML", () => {
    const text = bibEntryText(resolved);
    expect(text.trimStart().startsWith("@")).toBe(true);
    expect(text).toContain("@article{doe2020,");
    // The Hayagriva renderer would start with a bare `doe2020:` YAML key — the
    // exact shape that is INVISIBLE to every `.bib` reader and can break compile.
    expect(text).not.toMatch(/^\s*doe2020:/);
    expect(text).not.toBe(resolved.hayagriva);
  });

  it("round-trips through parseBibtex (the reader Galley uses on a .bib)", () => {
    const entries = parseBibtex(bibEntryText(resolved));
    expect(entries).toHaveLength(1);
    const got = entries[0]!;
    expect(got.key).toBe("doe2020");
    expect(got.title).toBe("A Study of Things");
    expect(got.year).toBe("2020");
  });
});

describe("citation-library.filterCitationRows", () => {
  const rows = [
    entryToResolved({ key: "vaswani2017", type: "article", title: "Attention Is All You Need", author: ["Vaswani, Ashish"], year: "2017" }, "bibtex"),
    entryToResolved({ key: "doe2020", type: "article", title: "A Study of Things", author: ["Doe, Jane"], year: "2020" }, "bibtex"),
  ];

  it("returns all rows for an empty/whitespace query", () => {
    expect(filterCitationRows(rows, "")).toHaveLength(2);
    expect(filterCitationRows(rows, "   ")).toHaveLength(2);
  });
  it("matches the title, author, or key, case-insensitively", () => {
    expect(filterCitationRows(rows, "attention").map((r) => r.key)).toEqual(["vaswani2017"]);
    expect(filterCitationRows(rows, "doe, jane").map((r) => r.key)).toEqual(["doe2020"]);
    expect(filterCitationRows(rows, "VASWANI2017").map((r) => r.key)).toEqual(["vaswani2017"]);
  });
  it("returns nothing when no row matches", () => {
    expect(filterCitationRows(rows, "nonexistent-term")).toEqual([]);
  });
});
