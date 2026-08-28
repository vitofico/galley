/**
 * Roadmap #6: arXiv literature search core — a SECOND search source alongside
 * Crossref, behind the IDENTICAL injected-fetch seam as literature-search.ts.
 *
 * arXiv's public API (`https://export.arxiv.org/api/query`) returns Atom XML, not
 * JSON, so the crux is a SAFE parser: XXE-proof (a dependency-free, bounded,
 * hand-rolled extractor that never resolves DTDs/external entities) and DoS-safe
 * (single linear pass, no quadratic scans). Tests pin the happy path (Atom feed →
 * mapped, keyed, deduped entries ready for toHayagriva), the FAIL-CLOSED posture
 * (network error / non-OK / malformed body → []), the XXE defense (an injected
 * external entity is NEVER expanded), and a large-input fuzz tripwire (linear,
 * sub-second). Offline — a fake fetch supplies every byte.
 */
import { describe, it, expect } from "vitest";
import { searchArxiv, searchArxivDetailed, buildArxivSearchUrl } from "./arxiv-search.js";
import { toHayagriva } from "./citation.js";

/** A fake `fetch` that returns an Atom XML body as text (200 OK by default). */
function fetchReturningText(
  body: string,
  init?: { ok?: boolean; status?: number; throwText?: boolean },
): typeof fetch {
  return (async () =>
    ({
      ok: init?.ok ?? true,
      status: init?.status ?? 200,
      text: async () => {
        if (init?.throwText) throw new Error("body read failed");
        return body;
      },
    }) as unknown as Response) as unknown as typeof fetch;
}

/** A minimal but realistic two-entry arXiv Atom feed. */
const TWO_ENTRY_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title>ArXiv Query</title>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v5</id>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All You Need</title>
    <summary>The dominant sequence transduction models are based on complex
      recurrent or convolutional neural networks.</summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <arxiv:doi>10.5555/3295222.3295349</arxiv:doi>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/1234.5678v1</id>
    <published>2012-03-04T00:00:00Z</published>
    <title>On the Theory of Notes</title>
    <summary>A study of notes and computing.</summary>
    <author><name>Ada Lovelace</name></author>
    <category term="math.HO" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`;

describe("buildArxivSearchUrl", () => {
  it("targets the fixed arXiv API host with an encoded query + max_results", () => {
    const url = buildArxivSearchUrl("quantum gravity", 5);
    expect(url.startsWith("https://export.arxiv.org/api/query?")).toBe(true);
    expect(url).toContain("search_query=");
    expect(url).toContain("quantum");
    expect(url).toContain("gravity");
    expect(url).toContain("max_results=5");
  });

  it("uses HTTPS (no credentials, fixed host)", () => {
    expect(buildArxivSearchUrl("x").startsWith("https://export.arxiv.org/")).toBe(true);
  });

  it("clamps max_results to a sane range", () => {
    expect(buildArxivSearchUrl("x", 0)).toContain("max_results=1");
    expect(buildArxivSearchUrl("x", 9999)).toContain("max_results=100");
  });
});

describe("searchArxiv (injected fetch, fail-closed)", () => {
  it("maps Atom entries to keyed CitationEntry[]", async () => {
    let calledUrl = "";
    const fakeFetch = (async (url: string | URL | Request) => {
      calledUrl = String(url);
      return { ok: true, status: 200, text: async () => TWO_ENTRY_FEED } as unknown as Response;
    }) as typeof fetch;

    const entries = await searchArxiv("attention", { fetch: fakeFetch, rows: 2 });
    expect(calledUrl).toContain("export.arxiv.org/api/query");
    expect(entries).toHaveLength(2);

    const first = entries[0]!;
    expect(first.title).toBe("Attention Is All You Need");
    // whitespace in <summary> is collapsed
    expect(first.abstract).toBe(
      "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.",
    );
    expect(first.author).toEqual(["Ashish Vaswani", "Noam Shazeer"]);
    expect(first.year).toBe("2017");
    expect(first.doi).toBe("10.5555/3295222.3295349");
    expect(first.url).toBe("http://arxiv.org/abs/1706.03762v5");
    // every entry has a stable, non-empty key, ready for toHayagriva
    expect(entries.every((e) => e.key.length > 0)).toBe(true);
    expect(toHayagriva(first).startsWith(`${first.key}:`)).toBe(true);

    const second = entries[1]!;
    expect(second.title).toBe("On the Theory of Notes");
    expect(second.author).toEqual(["Ada Lovelace"]);
    expect(second.doi).toBeUndefined();
    expect(second.url).toBe("http://arxiv.org/abs/1234.5678v1");
  });

  it("decodes the standard XML entities in text (no numeric/general expansion)", async () => {
    const feed = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <id>http://arxiv.org/abs/1</id>
        <published>2020-01-01T00:00:00Z</published>
        <title>A &amp; B &lt;tag&gt; &quot;q&quot; &apos;a&apos;</title>
        <author><name>X Y</name></author>
      </entry>
    </feed>`;
    const entries = await searchArxiv("x", { fetch: fetchReturningText(feed) });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe(`A & B <tag> "q" 'a'`);
  });

  it("does NOT expand external/general entities (XXE-proof)", async () => {
    // A crafted feed with a DTD declaring an external entity. A safe extractor must
    // NEVER resolve `&xxe;` — it stays literal (or is dropped), never file contents.
    const feed = `<?xml version="1.0"?>
      <!DOCTYPE feed [
        <!ENTITY xxe SYSTEM "file:///etc/passwd">
        <!ENTITY general "SECRET">
      ]>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>http://arxiv.org/abs/9</id>
          <published>2021-01-01T00:00:00Z</published>
          <title>Safe &xxe; &general; Title</title>
          <author><name>A B</name></author>
        </entry>
      </feed>`;
    const entries = await searchArxiv("x", { fetch: fetchReturningText(feed) });
    expect(entries).toHaveLength(1);
    const title = entries[0]!.title ?? "";
    // The entity references were NOT expanded to any resolved value.
    expect(title).not.toContain("SECRET");
    expect(title).not.toContain("root:");
    expect(title).toContain("Safe");
    expect(title).toContain("Title");
  });

  it("returns [] for an empty/whitespace query without fetching", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return {} as unknown as Response;
    }) as typeof fetch;
    expect(await searchArxiv("", { fetch: fakeFetch })).toEqual([]);
    expect(await searchArxiv("   ", { fetch: fakeFetch })).toEqual([]);
    expect(called).toBe(false);
  });

  it("fails closed (→ []) on a non-OK HTTP response", async () => {
    const entries = await searchArxiv("x", {
      fetch: fetchReturningText("<feed/>", { ok: false, status: 503 }),
    });
    expect(entries).toEqual([]);
  });

  it("fails closed (→ []) on a thrown network error", async () => {
    const fakeFetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect(await searchArxiv("x", { fetch: fakeFetch })).toEqual([]);
  });

  it("fails closed (→ []) when reading the body throws", async () => {
    expect(
      await searchArxiv("x", { fetch: fetchReturningText("", { throwText: true }) }),
    ).toEqual([]);
  });

  it("fails closed (→ []) on a non-XML / empty / entry-less body", async () => {
    expect(await searchArxiv("x", { fetch: fetchReturningText("") })).toEqual([]);
    expect(await searchArxiv("x", { fetch: fetchReturningText("not xml at all") })).toEqual([]);
    expect(
      await searchArxiv("x", { fetch: fetchReturningText("<feed></feed>") }),
    ).toEqual([]);
  });

  it("skips entries with no usable metadata (no title and no authors)", async () => {
    const feed = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <id>http://arxiv.org/abs/empty</id>
        <published>2020-01-01T00:00:00Z</published>
      </entry>
      <entry>
        <id>http://arxiv.org/abs/ok</id>
        <published>2020-01-01T00:00:00Z</published>
        <title>Has Title</title>
      </entry>
    </feed>`;
    const entries = await searchArxiv("x", { fetch: fetchReturningText(feed) });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe("Has Title");
  });

  it("de-duplicates entries sharing a DOI (first wins)", async () => {
    const feed = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry><id>http://arxiv.org/abs/a</id><title>First</title>
        <arxiv:doi>10.1/same</arxiv:doi></entry>
      <entry><id>http://arxiv.org/abs/b</id><title>Dup, different case</title>
        <arxiv:doi>10.1/SAME</arxiv:doi></entry>
      <entry><id>http://arxiv.org/abs/c</id><title>Other</title>
        <arxiv:doi>10.3/other</arxiv:doi></entry>
    </feed>`;
    const entries = await searchArxiv("x", { fetch: fetchReturningText(feed) });
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.title)).toEqual(["First", "Other"]);
  });

  it("reads a DOI from a <link title=\"doi\"> when there is no arxiv:doi", async () => {
    const feed = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <id>http://arxiv.org/abs/x1</id>
        <title>Linked DOI</title>
        <author><name>A B</name></author>
        <link title="doi" href="http://dx.doi.org/10.1234/linked" rel="related"/>
      </entry>
    </feed>`;
    const entries = await searchArxiv("x", { fetch: fetchReturningText(feed) });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.doi).toBe("10.1234/linked");
  });

  it("ReDoS regression (GPT Finding 1): nested UNCLOSED <author> in ONE early entry is linear", async () => {
    // The HOSTILE content is inside the FIRST entry (within MAX_ENTRIES), so it is
    // actually parsed. Thousands of repeated UNCLOSED <author> opens used to blow up
    // the 3×`[\s\S]*?` regex; the indexOf walker must finish near-instantly.
    const nested = "<author><name>x</name>".repeat(20000); // 20k unclosed opens
    const feed =
      `<feed xmlns="http://www.w3.org/2005/Atom">` +
      `<entry><id>http://arxiv.org/abs/1</id><title>Has Title</title>${nested}</entry>` +
      `</feed>`;
    const start = Date.now();
    const entries = await searchArxiv("x", { fetch: fetchReturningText(feed) });
    const elapsed = Date.now() - start;
    // At 800 groups the OLD regex took ~104s; 20k here must stay well under a second.
    expect(elapsed).toBeLessThan(1000);
    // The entry still yields its title (and bounded authors) — no hang, no throw.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe("Has Title");
  });

  it("ReDoS regression: huge angle-bracket / entity padding INSIDE an early entry is linear", async () => {
    // Pathological field content (50k '<' and 50k '&') in the FIRST entry. With
    // MAX_FIELD_CHARS clipping + indexOf scans this is bounded and fast.
    const feed =
      `<feed xmlns="http://www.w3.org/2005/Atom">` +
      `<entry><id>http://arxiv.org/abs/1</id><title>${"<".repeat(50000)}T</title>` +
      `<summary>${"&".repeat(50000)}safe</summary><author><name>A B</name></author></entry>` +
      `</feed>`;
    const start = Date.now();
    const entries = await searchArxiv("x", { fetch: fetchReturningText(feed) });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.author).toEqual(["A B"]);
  });

  it("DoS-safe: a large many-entry feed parses in well under a second (linear)", async () => {
    const parts: string[] = [`<feed xmlns="http://www.w3.org/2005/Atom">`];
    for (let i = 0; i < 600; i++) {
      parts.push(
        `<entry><id>http://arxiv.org/abs/${i}</id><published>2000-01-01T00:00:00Z</published>` +
          `<title>Paper ${i} &amp; more</title><author><name>Auth ${i}</name></author>` +
          `<summary>${"abstract text ".repeat(20)}</summary></entry>`,
      );
    }
    parts.push(`</feed>`);
    const big = parts.join("");

    const start = Date.now();
    const entries = await searchArxiv("x", { fetch: fetchReturningText(big), rows: 100 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    // Bounded by MAX_ENTRIES (500) even though 600 entries were supplied.
    expect(entries.length).toBeLessThanOrEqual(500);
    expect(entries.length).toBeGreaterThan(100);
  });

  it("caps the number of authors per entry (bounded list)", async () => {
    const many = "<author><name>X Y</name></author>".repeat(1000);
    const feed =
      `<feed xmlns="http://www.w3.org/2005/Atom">` +
      `<entry><id>http://arxiv.org/abs/1</id><title>Crowded</title>${many}</entry>` +
      `</feed>`;
    const entries = await searchArxiv("x", { fetch: fetchReturningText(feed) });
    expect(entries).toHaveLength(1);
    // MAX_AUTHORS = 200 — never the full 1000.
    expect(entries[0]!.author!.length).toBeLessThanOrEqual(200);
  });

  it("fails closed (→ []) on an over-cap response body (post-read)", async () => {
    // A body larger than MAX_RESPONSE_CHARS (5,000,000) is dropped, not parsed.
    const huge =
      `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/1</id>` +
      `<title>${"a".repeat(5_000_050)}</title></entry></feed>`;
    expect(await searchArxiv("x", { fetch: fetchReturningText(huge) })).toEqual([]);
  });

  it("fails closed (→ []) when a Content-Length header advertises an over-cap body", async () => {
    let bodyRead = false;
    const fakeFetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "6000000" : null) },
        text: async () => {
          bodyRead = true;
          return "<feed/>";
        },
      }) as unknown as Response) as typeof fetch;
    expect(await searchArxiv("x", { fetch: fakeFetch })).toEqual([]);
    // The precheck rejected it BEFORE reading the body.
    expect(bodyRead).toBe(false);
  });

  it("only stores an arxiv.org/abs/… id as the entry url (scheme allowlist)", async () => {
    const feed =
      `<feed xmlns="http://www.w3.org/2005/Atom">` +
      `<entry><id>javascript:alert(1)</id><title>Evil Id</title></entry>` +
      `<entry><id>http://arxiv.org/abs/2001.00001</id><title>Good Id</title></entry>` +
      `</feed>`;
    const entries = await searchArxiv("x", { fetch: fetchReturningText(feed) });
    expect(entries).toHaveLength(2);
    expect(entries[0]!.url).toBeUndefined(); // non-arxiv scheme dropped
    expect(entries[1]!.url).toBe("http://arxiv.org/abs/2001.00001");
  });

  it("stays a BARE ARRAY over the detailed core (back-compat contract)", async () => {
    // The legacy signature must keep returning CitationEntry[] — never an outcome
    // object — so every existing caller/test is byte-for-byte unaffected.
    const hits = await searchArxiv("x", { fetch: fetchReturningText(TWO_ENTRY_FEED) });
    expect(Array.isArray(hits)).toBe(true);
    expect(hits).toHaveLength(2);
    // …and every failure mode still flattens to [], NOT to an { ok: false } object.
    const failed = await searchArxiv("x", {
      fetch: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    expect(Array.isArray(failed)).toBe(true);
    expect(failed).toEqual([]);
  });
});

/**
 * The failure-vs-empty distinction — the WHOLE point of the detailed core. arXiv
 * was the lone search source that flattened every error to `[]`, so a blocked or
 * erroring request rendered as a confident "No results": a lie that tells the
 * author the paper does not exist when the network actually failed. These pin
 * that a real failure is now typed and an honestly-empty feed stays a SUCCESS.
 */
describe("searchArxivDetailed (failure vs empty, discriminated outcome)", () => {
  it("reports success WITH hits for a real feed", async () => {
    const outcome = await searchArxivDetailed("attention", {
      fetch: fetchReturningText(TWO_ENTRY_FEED),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.entries).toHaveLength(2);
    expect(outcome.entries[0]!.title).toBe("Attention Is All You Need");
  });

  it("reports success-but-EMPTY for a well-formed feed with no entries", async () => {
    // THE crux: arXiv answered, understood, nothing matched. This must NOT be a
    // failure — "no results" is the honest, calm answer here.
    const outcome = await searchArxivDetailed("zzzz", {
      fetch: fetchReturningText(`<feed xmlns="http://www.w3.org/2005/Atom"></feed>`),
    });
    expect(outcome).toEqual({ ok: true, entries: [] });
  });

  it("reports success-but-empty for a self-closing feed", async () => {
    const outcome = await searchArxivDetailed("zzzz", { fetch: fetchReturningText("<feed/>") });
    expect(outcome).toEqual({ ok: true, entries: [] });
  });

  it("reports success-but-empty when a feed's entries have no usable metadata", async () => {
    // The feed was understood; its entries simply carried nothing citable. That is
    // an empty result, not a transport failure (mirrors the Crossref item guard).
    const feed = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry><id>http://arxiv.org/abs/empty</id><published>2020-01-01T00:00:00Z</published></entry>
    </feed>`;
    const outcome = await searchArxivDetailed("x", { fetch: fetchReturningText(feed) });
    expect(outcome).toEqual({ ok: true, entries: [] });
  });

  it("reports success-but-empty for an empty/whitespace query without fetching", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return {} as unknown as Response;
    }) as typeof fetch;
    expect(await searchArxivDetailed("", { fetch: fakeFetch })).toEqual({ ok: true, entries: [] });
    expect(await searchArxivDetailed("   ", { fetch: fakeFetch })).toEqual({
      ok: true,
      entries: [],
    });
    expect(called).toBe(false);
  });

  it("reports a NETWORK failure when the fetch throws (offline/DNS/CORS)", async () => {
    const fakeFetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect(await searchArxivDetailed("x", { fetch: fakeFetch })).toEqual({
      ok: false,
      reason: "network",
    });
  });

  it("reports a SERVER failure on a non-2xx response", async () => {
    expect(
      await searchArxivDetailed("x", {
        fetch: fetchReturningText("<feed/>", { ok: false, status: 503 }),
      }),
    ).toEqual({ ok: false, reason: "server" });
  });

  it("reports a MALFORMED failure when reading the body throws", async () => {
    expect(
      await searchArxivDetailed("x", { fetch: fetchReturningText("", { throwText: true }) }),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("reports a MALFORMED failure on a garbage / non-Atom body", async () => {
    // Garbage has no <feed> root, so it is a body we did not understand — NOT an
    // empty result. This is the pair that must never collapse together.
    expect(await searchArxivDetailed("x", { fetch: fetchReturningText("not xml at all") })).toEqual(
      { ok: false, reason: "malformed" },
    );
    expect(
      await searchArxivDetailed("x", { fetch: fetchReturningText('{"json":"not atom"}') }),
    ).toEqual({ ok: false, reason: "malformed" });
    // An HTML error/captive-portal page is the realistic blocked-request body.
    expect(
      await searchArxivDetailed("x", {
        fetch: fetchReturningText("<html><body>Blocked by proxy</body></html>"),
      }),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("reports a MALFORMED failure on an empty body", async () => {
    expect(await searchArxivDetailed("x", { fetch: fetchReturningText("") })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("reports a MALFORMED failure on an over-cap body (post-read, never parsed)", async () => {
    const huge =
      `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/1</id>` +
      `<title>${"a".repeat(5_000_050)}</title></entry></feed>`;
    expect(await searchArxivDetailed("x", { fetch: fetchReturningText(huge) })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("reports a MALFORMED failure when Content-Length advertises an over-cap body", async () => {
    let bodyRead = false;
    const fakeFetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "6000000" : null) },
        text: async () => {
          bodyRead = true;
          return "<feed/>";
        },
      }) as unknown as Response) as typeof fetch;
    expect(await searchArxivDetailed("x", { fetch: fakeFetch })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(bodyRead).toBe(false); // still rejected BEFORE reading the body
  });

  it("keeps the <feed> probe linear on a hostile body (no rescan blowup)", async () => {
    // The probe must be a bounded indexOf walk like every other scan: a body packed
    // with near-miss `<feedfoo` opens and no real feed root stays linear.
    const hostile = "<feedfoo>".repeat(200000);
    const start = Date.now();
    const outcome = await searchArxivDetailed("x", { fetch: fetchReturningText(hostile) });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(outcome).toEqual({ ok: false, reason: "malformed" });
  });
});
