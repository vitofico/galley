/**
 * fetchMendeleyLibrary (roadmap #17.1, Mendeley core) — offline tests with a
 * fake fetch, mirroring zotero-library.test.ts style. Pins: the happy path
 * (JSON documents → mapped entries with full field coverage), cross-page marker
 * pagination + dedupe, truncation at the page cap, and EVERY ADR-0016 posture
 * rule (fixed host, header-only bearer token that no error echoes,
 * redirect: "error", byte cap, validated marker, typed fail-closed status +
 * non-JSON / non-array mapping).
 */
import { describe, it, expect } from "vitest";
import {
  fetchMendeleyLibrary,
  MENDELEY_MAX_PAGES,
  MENDELEY_MAX_RESPONSE_CHARS,
  MENDELEY_PAGE_LIMIT,
  type FetchMendeleyLibraryResult,
} from "./mendeley-library.js";

const TOKEN = "SUPER-SECRET-MENDELEY-BEARER-TOKEN";

/** One well-formed Mendeley document object; `name` makes it unique. */
function doc(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: `Title ${name}`,
    type: "journal",
    year: 2020,
    authors: [{ first_name: name, last_name: "Doe" }],
    ...extra,
  };
}

interface RecordedCall {
  url: string;
  init: { headers: Record<string, string>; redirect?: string };
}

/** Build a fake Response: JSON body (already serialized) + real Headers. */
function page(
  body: string,
  headers: Record<string, string> = {},
  status = 200,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => body,
  } as unknown as Response;
}

/** Build a fake JSON-array Response from document objects. */
function jsonPage(
  docs: unknown[],
  headers: Record<string, string> = {},
  status = 200,
): Response {
  return page(JSON.stringify(docs), headers, status);
}

/** Fake fetch returning `responses` in order (last one repeats), recording calls. */
function fetchSequence(responses: Response[], calls: RecordedCall[]): typeof fetch {
  let i = 0;
  return (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RecordedCall["init"] });
    const res = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return res;
  }) as unknown as typeof fetch;
}

/** Narrow to the failure arm (and assert it is one). */
function failure(r: FetchMendeleyLibraryResult): { kind: string; message: string } {
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("expected failure");
  return r.error;
}

describe("fetchMendeleyLibrary — happy paths", () => {
  it("fetches a single page of documents into mapped entries", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = fetchSequence([jsonPage([doc("alpha"), doc("beta")])], calls);
    const r = await fetchMendeleyLibrary({ apiToken: TOKEN }, { fetch: fakeFetch });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries).toEqual([
      expect.objectContaining({ key: "", type: "article", title: "Title alpha", year: "2020" }),
      expect.objectContaining({ key: "", type: "article", title: "Title beta", year: "2020" }),
    ]);
    expect(r.truncated).toBe(false);
    // Fixed host, fixed path shape, limit pinned at 100, no marker on page 0.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.mendeley.com/documents?view=all&limit=100");
  });

  it("sends the bearer token + accept headers and redirect: 'error'", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = fetchSequence([jsonPage([doc("a")])], calls);
    await fetchMendeleyLibrary({ apiToken: TOKEN }, { fetch: fakeFetch });
    const init = calls[0]!.init;
    expect(init.redirect).toBe("error");
    expect(init.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(init.headers["Accept"]).toBe("application/vnd.mendeley-document.1+json");
  });

  it("maps every supported field (journal/issue/source/doi/websites/year/type)", async () => {
    const fakeFetch = fetchSequence(
      [
        jsonPage([
          {
            title: "Mapped",
            type: "conference_proceedings",
            year: 2019,
            source: "Proc. of X",
            volume: "12",
            issue: "3",
            pages: "10-20",
            publisher: "ACME Press",
            abstract: "An abstract.",
            authors: [
              { first_name: "Ada", last_name: "Lovelace" },
              { last_name: "Babbage" }, // no first_name -> bare last name
              { first_name: "skip" }, // no last_name -> dropped
            ],
            editors: [{ first_name: "Ed", last_name: "Itor" }],
            identifiers: { doi: "10.1/abc", isbn: "X" },
            websites: ["https://example.org/a", "https://example.org/b"],
          },
        ]),
      ],
      [],
    );
    const r = await fetchMendeleyLibrary({ apiToken: TOKEN }, { fetch: fakeFetch });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries[0]).toEqual({
      key: "",
      type: "inproceedings", // conference_proceedings -> inproceedings
      title: "Mapped",
      abstract: "An abstract.",
      publisher: "ACME Press",
      volume: "12",
      number: "3", // issue -> number
      pages: "10-20",
      journal: "Proc. of X", // source -> journal
      doi: "10.1/abc",
      url: "https://example.org/a", // websites[0] -> url
      year: "2019",
      author: ["Lovelace, Ada", "Babbage"],
      editor: ["Itor, Ed"],
    });
  });

  it("defaults an unknown/missing type to article and omits a non-4-digit year", async () => {
    const fakeFetch = fetchSequence(
      [jsonPage([{ title: "T1", type: "podcast", year: 42 }, { title: "T2" }])],
      [],
    );
    const r = await fetchMendeleyLibrary({ apiToken: TOKEN }, { fetch: fakeFetch });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries[0]).toEqual({ key: "", type: "article", title: "T1" }); // year 42 omitted
    expect(r.entries[1]).toEqual({ key: "", type: "article", title: "T2" });
  });

  it("treats an empty JSON array as an empty library", async () => {
    const fakeFetch = fetchSequence([jsonPage([])], []);
    const r = await fetchMendeleyLibrary({ apiToken: TOKEN }, { fetch: fakeFetch });
    expect(r).toEqual({ ok: true, entries: [], truncated: false });
  });

  it("dedupes a repeated DOI (first wins), like the .bib import path", async () => {
    const fakeFetch = fetchSequence(
      [
        jsonPage([
          { title: "First", type: "journal", identifiers: { doi: "10.5/dup" } },
          { title: "Second copy", type: "journal", identifiers: { doi: "10.5/dup" } },
          { title: "Unique", type: "journal", identifiers: { doi: "10.5/other" } },
        ]),
      ],
      [],
    );
    const r = await fetchMendeleyLibrary({ apiToken: TOKEN }, { fetch: fakeFetch });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => e.title)).toEqual(["First", "Unique"]);
  });
});

describe("fetchMendeleyLibrary — pagination", () => {
  it("follows Link rel=next via a rebuilt, fixed-host marker URL and dedupes across pages", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = fetchSequence(
      [
        jsonPage([doc("alpha", { identifiers: { doi: "10.1/a" } }), doc("beta", { identifiers: { doi: "10.1/b" } })], {
          // The advertised next URL carries an opaque marker on a (possibly) other host.
          Link: '<https://api.mendeley.com/documents?view=all&limit=100&marker=NEXT_pg.2~>; rel="next"',
        }),
        // beta's DOI repeats on page 2 — dedupe must collapse it.
        jsonPage([doc("beta", { identifiers: { doi: "10.1/b" } }), doc("gamma", { identifiers: { doi: "10.1/g" } })]),
      ],
      calls,
    );
    const r = await fetchMendeleyLibrary({ apiToken: TOKEN }, { fetch: fakeFetch });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => e.title)).toEqual(["Title alpha", "Title beta", "Title gamma"]);
    expect(r.truncated).toBe(false);
    expect(calls).toHaveLength(2);
    // The next URL is REBUILT from the fixed base + validated marker — not echoed.
    expect(calls[1]!.url).toBe(
      "https://api.mendeley.com/documents?view=all&limit=100&marker=NEXT_pg.2~",
    );
  });

  it("fails closed on a marker that fails the charset validation", async () => {
    const fakeFetch = fetchSequence(
      [
        jsonPage([doc("a")], {
          Link: '<https://api.mendeley.com/documents?marker=bad%20marker%2Fslash>; rel="next"',
        }),
      ],
      [],
    );
    const r = await fetchMendeleyLibrary({ apiToken: TOKEN }, { fetch: fakeFetch });
    expect(failure(r).kind).toBe("bad-response");
  });

  it("stops at the page cap and reports truncated honestly", async () => {
    const calls: RecordedCall[] = [];
    let n = 0;
    const fakeFetch = (async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: init as RecordedCall["init"] });
      n++;
      // EVERY page advertises another page — the cap must cut this off.
      return jsonPage([doc(`entry${n}`, { identifiers: { doi: `10.1/${n}` } })], {
        Link: '<https://api.mendeley.com/documents?view=all&limit=100&marker=more>; rel="next"',
      });
    }) as unknown as typeof fetch;
    const r = await fetchMendeleyLibrary({ apiToken: TOKEN }, { fetch: fakeFetch });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls).toHaveLength(MENDELEY_MAX_PAGES);
    expect(r.truncated).toBe(true);
    expect(r.entries).toHaveLength(MENDELEY_MAX_PAGES);
  });
});

describe("fetchMendeleyLibrary — security posture (ADR-0016)", () => {
  it("rejects an empty token without touching the network", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = fetchSequence([jsonPage([doc("a")])], calls);
    for (const apiToken of ["", "   "]) {
      const r = await fetchMendeleyLibrary({ apiToken }, { fetch: fakeFetch });
      expect(failure(r).kind).toBe("invalid-token");
    }
    expect(calls).toHaveLength(0);
  });

  it("never puts the token in the URL", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = fetchSequence(
      [
        jsonPage([doc("a")], {
          Link: '<https://api.mendeley.com/documents?marker=m1>; rel="next"',
        }),
        jsonPage([doc("b")]),
      ],
      calls,
    );
    await fetchMendeleyLibrary({ apiToken: TOKEN }, { fetch: fakeFetch });
    for (const c of calls) {
      expect(c.url).not.toContain(TOKEN);
      expect(c.url).not.toContain("token=");
    }
  });

  it("maps non-2xx statuses to typed fail-closed errors that never echo the token", async () => {
    const cases: Array<[number, string]> = [
      [401, "invalid-token"],
      [403, "forbidden"],
      [404, "not-found"],
      [429, "rate-limited"],
      [500, "upstream"],
      [503, "upstream"],
      [418, "bad-response"],
    ];
    for (const [status, kind] of cases) {
      const fakeFetch = fetchSequence([page("", {}, status)], []);
      const r = await fetchMendeleyLibrary({ apiToken: TOKEN }, { fetch: fakeFetch });
      const err = failure(r);
      expect(err.kind).toBe(kind);
      expect(err.message).not.toContain(TOKEN);
    }
  });

  it("maps a thrown fetch (incl. redirect rejection) to a typed error without the token", async () => {
    const fakeFetch = (async () => {
      // A hostile error message embedding the token must NOT leak through.
      throw new Error(`redirect blocked for ${TOKEN}`);
    }) as unknown as typeof fetch;
    const r = await fetchMendeleyLibrary({ apiToken: TOKEN }, { fetch: fakeFetch });
    const err = failure(r);
    expect(err.kind).toBe("network");
    expect(err.message).not.toContain(TOKEN);
  });

  it("rejects a declared Content-Length over the cap before reading AND cancels the body", async () => {
    let read = false;
    let cancelled = false;
    const res = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(MENDELEY_MAX_RESPONSE_CHARS + 1) }),
      body: new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      text: async () => {
        read = true;
        return "";
      },
    } as unknown as Response;
    const fakeFetch = fetchSequence([res], []);
    const r = await fetchMendeleyLibrary({ apiToken: TOKEN }, { fetch: fakeFetch });
    expect(failure(r).kind).toBe("too-large");
    expect(read).toBe(false);
    expect(cancelled).toBe(true); // the connection is not left draining
  });

  it("cancels a chunked stream the moment it exceeds the cap — never buffers the whole body", async () => {
    const CHUNK = 1024 * 1024; // 1 MiB per chunk; cap is 2 MiB → 3rd chunk crosses it
    const TOTAL_CHUNKS = 64; // 64 MiB if (wrongly) drained to completion
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls > TOTAL_CHUNKS) controller.close();
        else controller.enqueue(new Uint8Array(CHUNK).fill(120 /* 'x' */));
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = {
      ok: true,
      status: 200,
      headers: new Headers({}), // NO Content-Length — the fast path cannot help
      body: stream,
      text: async () => {
        throw new Error("must never buffer the whole body via text()");
      },
    } as unknown as Response;
    const fakeFetch = fetchSequence([res], []);
    const r = await fetchMendeleyLibrary({ apiToken: TOKEN }, { fetch: fakeFetch });
    expect(failure(r).kind).toBe("too-large");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(5);
  });

  it("rejects an over-cap body even without a stream (text() fallback path)", async () => {
    const huge = "x".repeat(MENDELEY_MAX_RESPONSE_CHARS + 1);
    const fakeFetch = fetchSequence([page(huge)], []);
    const r = await fetchMendeleyLibrary({ apiToken: TOKEN }, { fetch: fakeFetch });
    expect(failure(r).kind).toBe("too-large");
  });

  it("decodes an under-cap streamed JSON body whole (chunk-split array)", async () => {
    const text = JSON.stringify([doc("alpha"), doc("beta")]);
    const bytes = new TextEncoder().encode(text);
    const mid = Math.floor(bytes.length / 2); // split mid-array on purpose
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, mid));
        controller.enqueue(bytes.slice(mid));
        controller.close();
      },
    });
    const res = {
      ok: true,
      status: 200,
      headers: new Headers({}),
      body: stream,
      text: async () => {
        throw new Error("streaming path must not fall back to text()");
      },
    } as unknown as Response;
    const fakeFetch = fetchSequence([res], []);
    const r = await fetchMendeleyLibrary({ apiToken: TOKEN }, { fetch: fakeFetch });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => e.title)).toEqual(["Title alpha", "Title beta"]);
  });

  it("fails closed on a non-JSON body", async () => {
    const fakeFetch = fetchSequence([page("<html>definitely not json</html>")], []);
    const err = failure(await fetchMendeleyLibrary({ apiToken: TOKEN }, { fetch: fakeFetch }));
    expect(err.kind).toBe("bad-response");
    expect(err.message).not.toContain(TOKEN);
  });

  it("fails closed on JSON that is not an array (object body)", async () => {
    const fakeFetch = fetchSequence([page(JSON.stringify({ documents: [] }))], []);
    expect(failure(await fetchMendeleyLibrary({ apiToken: TOKEN }, { fetch: fakeFetch })).kind).toBe(
      "bad-response",
    );
  });
});
