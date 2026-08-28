import { describe, it, expect } from "vitest";
import {
  resolveCitation,
  buildCitationSnippet,
  previewDedup,
  citationInBibliography,
  SEARCH_SOURCES,
  searchSourceLabel,
} from "./CitationPanel.js";
import type { CitationSearchSource } from "./citation-library.js";
import type { CrossrefEnvelope } from "@galley/agent";

/**
 * The component is a thin shell over (a) the pure `resolveCitation` resolver
 * (BibTeX offline / DOI via an INJECTED fetch) and (b) the pure snippet builder,
 * with insertion going through the host's Accept flow. Per the repo's Node-env
 * house pattern (ImportPanel.test.ts) we test the exported helpers directly; the
 * rendered overlay + Accept click is covered by the Playwright e2e (Lane S).
 *
 * The fetch seam is fail-closed and INJECTED — these tests never touch the
 * network: a fake fetch returns a Crossref envelope (success) or a non-OK
 * response / rejection (failure), exactly the shape the core consumes.
 */

/** A fake `fetch` that returns a Crossref envelope as a 200 JSON response. */
function okFetch(envelope: CrossrefEnvelope): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => envelope,
    }) as unknown as Response) as unknown as typeof fetch;
}

/** A fake `fetch` that returns a non-OK response (the core fails closed). */
function notOkFetch(status: number): typeof fetch {
  return (async () =>
    ({
      ok: false,
      status,
      json: async () => ({}),
    }) as unknown as Response) as unknown as typeof fetch;
}

/** A fake `fetch` that should never be called (BibTeX is offline). */
const explodingFetch: typeof fetch = (async () => {
  throw new Error("network must not be used for BibTeX");
}) as unknown as typeof fetch;

const BIBTEX = `@article{ignoredKey,
  title = {Attention Is All You Need},
  author = {Vaswani, Ashish and Shazeer, Noam},
  year = {2017},
  journal = {NeurIPS}
}`;

describe("CitationPanel.resolveCitation (#6)", () => {
  it("resolves a pasted BibTeX entry offline into a keyed Hayagriva block", async () => {
    const r = await resolveCitation({ input: BIBTEX, fetch: explodingFetch });
    expect(r.kind).toBe("bibtex");
    // Deterministic key: <family><year>, accent-folded + lowercased.
    expect(r.key).toBe("vaswani2017");
    expect(r.entry.title).toBe("Attention Is All You Need");
    // The user-controlled BibTeX key is replaced by the deterministic one.
    expect(r.entry.key).toBe("vaswani2017");
    // Hayagriva renders the assigned key as the top-level mapping key.
    expect(r.hayagriva).toContain("vaswani2017:");
    expect(r.hayagriva).toContain("title: ");
  });

  it("avoids a cite-key collision against the existing bibliography", async () => {
    const r = await resolveCitation({
      input: BIBTEX,
      existingKeys: ["vaswani2017"],
      fetch: explodingFetch,
    });
    // Base key is the implicit "a"; the first collision is suffixed "b".
    expect(r.key).toBe("vaswani2017b");
    expect(r.hayagriva).toContain("vaswani2017b:");
  });

  it("resolves a DOI through the injected fetch (Crossref envelope)", async () => {
    const envelope: CrossrefEnvelope = {
      message: {
        DOI: "10.1145/3292500",
        type: "journal-article",
        title: ["A Study of Things"],
        author: [{ family: "Lovelace", given: "Ada" }],
        issued: { "date-parts": [[1843]] },
        "container-title": ["Journal of Notes"],
      },
    };
    const r = await resolveCitation({
      input: "10.1145/3292500",
      fetch: okFetch(envelope),
    });
    expect(r.kind).toBe("doi");
    expect(r.key).toBe("lovelace1843");
    expect(r.entry.title).toBe("A Study of Things");
    expect(r.hayagriva).toContain("lovelace1843:");
    expect(r.hayagriva).toContain("title: ");
  });

  it("fails closed on a non-OK fetch (and surfaces a typed error)", async () => {
    await expect(
      resolveCitation({ input: "10.1145/3292500", fetch: notOkFetch(404) }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("rejects an unrecognised input without touching the network", async () => {
    await expect(
      resolveCitation({ input: "just some prose, not a citation", fetch: explodingFetch }),
    ).rejects.toThrow(/recognise|recognize|DOI|BibTeX/i);
  });

  it("rejects a plain web URL (no metadata source in this seam)", async () => {
    await expect(
      resolveCitation({ input: "https://example.com/some/page", fetch: notOkFetch(404) }),
    ).rejects.toThrow();
  });
});

describe("CitationPanel.previewDedup (#6)", () => {
  const DUP_LIBRARY = `@article{a,
  title = {Literate Programming},
  author = {Knuth, Donald E.},
  year = {1984},
  doi = {10.1093/comjnl/27.2.97},
}
@article{b,
  title = {Literate Programming},
  author = {Knuth, Donald E.},
  year = {1984},
  doi = {10.1093/comjnl/27.2.97},
  volume = {27},
}
@book{c, title={Solo Work}, author={Doe, J.}, year={2001}}`;

  it("previews a duplicate cluster and a SURGICAL, still-BibTeX rewrite", () => {
    const p = previewDedup(DUP_LIBRARY);
    expect(p.groups).toHaveLength(1);
    expect(p.removed).toBe(1);
    expect(p.duplicateMembers).toBe(2);
    expect(p.mergedCount).toBe(1);
    expect(p.safe).toBe(true);
    // Merged PREVIEW keeps the first member's key and shows the coalesced volume.
    expect(p.groups[0]!.merged.key).toBe("a");
    expect(p.groups[0]!.merged.volume).toBe("27");
    // The rewrite drops the duplicate but stays BibTeX (compile + readers intact):
    // the kept entry's original text survives, the unrelated entry survives.
    expect(p.text).toContain("@article{a,");
    expect(p.text).not.toContain("@article{b,");
    expect(p.text).toContain("@book{c, title={Solo Work}");
  });

  it("reports no groups on a clean library", () => {
    const p = previewDedup(`@book{c, title={Only One}, author={Doe, J.}, year={2001}}`);
    expect(p.groups).toEqual([]);
    expect(p.removed).toBe(0);
    expect(p.duplicateMembers).toBe(0);
  });

  it("is robust to empty/junk input", () => {
    expect(previewDedup("").groups).toEqual([]);
    expect(previewDedup("not a bibliography").removed).toBe(0);
  });
});

describe("CitationPanel.citationInBibliography (#6 search-insert)", () => {
  const added = new Set(["already-added2020"]);
  it("is true when the key is in this session's added set", () => {
    expect(citationInBibliography("already-added2020", ["other2019"], added)).toBe(true);
  });
  it("is true when the key is already in the existing bibliography keys", () => {
    expect(citationInBibliography("vaswani2017", ["vaswani2017"], new Set())).toBe(true);
  });
  it("is false when the key is in neither", () => {
    expect(citationInBibliography("fresh2024", ["vaswani2017"], added)).toBe(false);
  });
  it("treats undefined existingKeys as no existing keys", () => {
    expect(citationInBibliography("fresh2024", undefined, new Set())).toBe(false);
    expect(citationInBibliography("already-added2020", undefined, added)).toBe(true);
  });
  it("is false against an empty set and empty keys", () => {
    expect(citationInBibliography("anything", [], new Set())).toBe(false);
  });
});

describe("CitationPanel.buildCitationSnippet (#6)", () => {
  it("inserts the in-text Typst cite sigil `@<key>` (NOT the Hayagriva YAML)", async () => {
    const r = await resolveCitation({ input: BIBTEX, fetch: explodingFetch });
    const snippet = buildCitationSnippet(r);
    // Only the in-text cite goes into the .typ body; the YAML entry belongs in
    // the bibliography file and is routed via onAddToBibliography, not here.
    expect(snippet).toBe("@vaswani2017");
    expect(snippet).not.toContain("vaswani2017:"); // no raw YAML in the doc body
    expect(snippet).not.toContain("type:");
  });
});

describe("CitationPanel search-source labels (SEARCH_SOURCES + searchSourceLabel)", () => {
  // An EXHAUSTIVE record over the CitationSearchSource union: adding a new source
  // to the type forces a new entry here (TS compile error otherwise), and the
  // tests below prove every one of those sources has a label AND a selector pill.
  const EXPECTED: Record<CitationSearchSource, string> = {
    crossref: "Crossref",
    arxiv: "arXiv",
    openalex: "OpenAlex",
    semanticscholar: "Semantic Scholar",
  };

  it("labels every source with its human name", () => {
    for (const id of Object.keys(EXPECTED) as CitationSearchSource[]) {
      expect(searchSourceLabel(id)).toBe(EXPECTED[id]);
    }
  });

  it("falls back to the id for an unknown source", () => {
    expect(searchSourceLabel("mystery" as CitationSearchSource)).toBe("mystery");
  });

  it("offers every CitationSearchSource in the selector strip (no source missing a pill)", () => {
    const ids = SEARCH_SOURCES.map((s) => s.id).slice().sort();
    expect(ids).toEqual((Object.keys(EXPECTED) as CitationSearchSource[]).slice().sort());
    // Crossref stays first so the default search behaviour is unchanged.
    expect(SEARCH_SOURCES[0]!.id).toBe("crossref");
  });
});
