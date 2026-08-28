/**
 * fetchZoteroLibrary (roadmap #17.1, Zotero core) — offline tests with a fake
 * fetch, mirroring literature-search.test.ts / citation.test.ts style. Pins:
 * the happy path (BibTeX pages → keyed entries), pagination + cross-page
 * dedupe, the 304 not-modified path, truncation at the page cap, and EVERY
 * ADR-0016 posture rule (fixed host, header-only key that no error echoes,
 * redirect: "error", byte cap, typed fail-closed status mapping).
 */
import { describe, it, expect } from "vitest";
import {
  fetchZoteroLibrary,
  ZOTERO_MAX_PAGES,
  ZOTERO_MAX_RESPONSE_CHARS,
  ZOTERO_PAGE_LIMIT,
  type FetchZoteroLibraryResult,
} from "./zotero-library.js";

const KEY = "SUPER-SECRET-ZOTERO-KEY";
const USER_LIB = { kind: "user" as const, id: "12345" };

/** One well-formed BibTeX entry; `name` keys it and titles it uniquely. */
function bib(name: string): string {
  return `@article{${name}, title={Title ${name}}, author={Doe, ${name}}, year={2020}}`;
}

interface RecordedCall {
  url: string;
  init: { headers: Record<string, string>; redirect?: string };
}

/** Build a fake Response: BibTeX text body + real Headers. */
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
function failure(r: FetchZoteroLibraryResult): { kind: string; message: string } {
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("expected failure");
  return r.error;
}

describe("fetchZoteroLibrary — happy paths", () => {
  it("fetches a single user-library page into keyed entries", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = fetchSequence(
      [page(`${bib("alpha")}\n${bib("beta")}`, { "Last-Modified-Version": "123" })],
      calls,
    );
    const r = await fetchZoteroLibrary(
      { apiKey: KEY, library: USER_LIB },
      { fetch: fakeFetch },
    );
    expect(r).toEqual({
      ok: true,
      entries: [
        expect.objectContaining({ key: "alpha", title: "Title alpha" }),
        expect.objectContaining({ key: "beta", title: "Title beta" }),
      ],
      libraryVersion: 123,
      notModified: false,
      truncated: false,
    });
    // Fixed host, fixed path shape, limit pinned at 100, no start on page 0.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://api.zotero.org/users/12345/items?format=bibtex&limit=100",
    );
  });

  it("sends the v3 + key headers and redirect: 'error' on every request", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = fetchSequence([page(bib("a"))], calls);
    await fetchZoteroLibrary({ apiKey: KEY, library: USER_LIB }, { fetch: fakeFetch });
    const init = calls[0]!.init;
    expect(init.redirect).toBe("error");
    expect(init.headers["Zotero-API-Version"]).toBe("3");
    expect(init.headers["Zotero-API-Key"]).toBe(KEY);
    // No conditional header unless previousLibraryVersion is given.
    expect(init.headers["If-Modified-Since-Version"]).toBeUndefined();
  });

  it("uses the /groups path for group libraries", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = fetchSequence([page(bib("a"))], calls);
    const r = await fetchZoteroLibrary(
      { apiKey: KEY, library: { kind: "group", id: "987" } },
      { fetch: fakeFetch },
    );
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toBe(
      "https://api.zotero.org/groups/987/items?format=bibtex&limit=100",
    );
  });

  it("treats an empty body as an empty library", async () => {
    const fakeFetch = fetchSequence([page("", { "Last-Modified-Version": "7" })], []);
    const r = await fetchZoteroLibrary(
      { apiKey: KEY, library: USER_LIB },
      { fetch: fakeFetch },
    );
    expect(r).toEqual({
      ok: true,
      entries: [],
      libraryVersion: 7,
      notModified: false,
      truncated: false,
    });
  });

  it("returns libraryVersion null when Last-Modified-Version is absent or malformed", async () => {
    for (const headers of [{}, { "Last-Modified-Version": "abc" }, { "Last-Modified-Version": "-3" }]) {
      const fakeFetch = fetchSequence([page(bib("a"), headers)], []);
      const r = await fetchZoteroLibrary(
        { apiKey: KEY, library: USER_LIB },
        { fetch: fakeFetch },
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.libraryVersion).toBeNull();
    }
  });
});

describe("fetchZoteroLibrary — pagination", () => {
  it("follows Link rel=next with start offsets and dedupes across pages", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = fetchSequence(
      [
        page(`${bib("alpha")}\n${bib("beta")}`, {
          "Last-Modified-Version": "55",
          Link: '<https://api.zotero.org/users/12345/items?format=bibtex&limit=100&start=100>; rel="next"',
        }),
        // beta repeats on page 2 — the merged import must collapse it.
        page(`${bib("beta")}\n${bib("gamma")}`),
      ],
      calls,
    );
    const r = await fetchZoteroLibrary(
      { apiKey: KEY, library: USER_LIB },
      { fetch: fakeFetch },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => e.key)).toEqual(["alpha", "beta", "gamma"]);
    expect(r.truncated).toBe(false);
    expect(r.libraryVersion).toBe(55);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe(
      `https://api.zotero.org/users/12345/items?format=bibtex&limit=100&start=${ZOTERO_PAGE_LIMIT}`,
    );
  });

  it("sends If-Modified-Since-Version only on the first page", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = fetchSequence(
      [
        page(bib("a"), { Link: '<https://api.zotero.org/x?start=100>; rel="next"' }),
        page(bib("b")),
      ],
      calls,
    );
    await fetchZoteroLibrary(
      { apiKey: KEY, library: USER_LIB, previousLibraryVersion: 42 },
      { fetch: fakeFetch },
    );
    expect(calls[0]!.init.headers["If-Modified-Since-Version"]).toBe("42");
    expect(calls[1]!.init.headers["If-Modified-Since-Version"]).toBeUndefined();
  });

  it("stops at the page cap and reports truncated honestly", async () => {
    const calls: RecordedCall[] = [];
    let n = 0;
    const fakeFetch = (async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: init as RecordedCall["init"] });
      n++;
      // EVERY page claims another page exists — the cap must cut this off.
      return page(bib(`entry${n}`), {
        Link: '<https://api.zotero.org/x?start=999>; rel="next"',
      });
    }) as unknown as typeof fetch;
    const r = await fetchZoteroLibrary(
      { apiKey: KEY, library: USER_LIB },
      { fetch: fakeFetch },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls).toHaveLength(ZOTERO_MAX_PAGES);
    expect(r.truncated).toBe(true);
    expect(r.entries).toHaveLength(ZOTERO_MAX_PAGES);
  });
});

describe("fetchZoteroLibrary — 304 not-modified", () => {
  it("surfaces notModified with the version unchanged and no entries", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = fetchSequence([page("", {}, 304)], calls);
    const r = await fetchZoteroLibrary(
      { apiKey: KEY, library: USER_LIB, previousLibraryVersion: 42 },
      { fetch: fakeFetch },
    );
    expect(r).toEqual({
      ok: true,
      entries: [],
      libraryVersion: 42,
      notModified: true,
      truncated: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("fails closed on a 304 we never asked for", async () => {
    const fakeFetch = fetchSequence([page("", {}, 304)], []);
    const r = await fetchZoteroLibrary(
      { apiKey: KEY, library: USER_LIB }, // no previousLibraryVersion
      { fetch: fakeFetch },
    );
    expect(failure(r).kind).toBe("bad-response");
  });
});

describe("fetchZoteroLibrary — security posture (ADR-0016)", () => {
  it("rejects a non-numeric library id without touching the network", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = fetchSequence([page(bib("a"))], calls);
    for (const id of ["abc", "12/../34", "12345?x=1", "", " 1", "1e3"]) {
      const r = await fetchZoteroLibrary(
        { apiKey: KEY, library: { kind: "user", id } },
        { fetch: fakeFetch },
      );
      expect(failure(r).kind).toBe("invalid-library");
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects an unknown library kind without touching the network", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = fetchSequence([page(bib("a"))], calls);
    const r = await fetchZoteroLibrary(
      { apiKey: KEY, library: { kind: "evil" as "user", id: "1" } },
      { fetch: fakeFetch },
    );
    expect(failure(r).kind).toBe("invalid-library");
    expect(calls).toHaveLength(0);
  });

  it("rejects an empty api key without touching the network", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = fetchSequence([page(bib("a"))], calls);
    for (const apiKey of ["", "   "]) {
      const r = await fetchZoteroLibrary(
        { apiKey, library: USER_LIB },
        { fetch: fakeFetch },
      );
      expect(failure(r).kind).toBe("invalid-key");
    }
    expect(calls).toHaveLength(0);
  });

  it("never puts the api key in the URL", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = fetchSequence(
      [page(bib("a"), { Link: '<https://api.zotero.org/x>; rel="next"' }), page(bib("b"))],
      calls,
    );
    await fetchZoteroLibrary({ apiKey: KEY, library: USER_LIB }, { fetch: fakeFetch });
    for (const c of calls) {
      expect(c.url).not.toContain(KEY);
      expect(c.url).not.toContain("key=");
    }
  });

  it("maps non-2xx statuses to typed fail-closed errors that never echo the key", async () => {
    const cases: Array<[number, string]> = [
      [401, "invalid-key"],
      [403, "forbidden"],
      [404, "not-found"],
      [429, "rate-limited"],
      [500, "upstream"],
      [503, "upstream"],
      [418, "bad-response"],
    ];
    for (const [status, kind] of cases) {
      const fakeFetch = fetchSequence([page("", {}, status)], []);
      const r = await fetchZoteroLibrary(
        { apiKey: KEY, library: USER_LIB },
        { fetch: fakeFetch },
      );
      const err = failure(r);
      expect(err.kind).toBe(kind);
      expect(err.message).not.toContain(KEY);
    }
  });

  it("maps a thrown fetch (incl. redirect rejection) to a typed error without the key", async () => {
    const fakeFetch = (async () => {
      // A hostile error message embedding the key must NOT leak through.
      throw new Error(`redirect blocked for ${KEY}`);
    }) as unknown as typeof fetch;
    const r = await fetchZoteroLibrary(
      { apiKey: KEY, library: USER_LIB },
      { fetch: fakeFetch },
    );
    const err = failure(r);
    expect(err.kind).toBe("network");
    expect(err.message).not.toContain(KEY);
  });

  it("rejects a declared Content-Length over the cap before reading AND cancels the body", async () => {
    let read = false;
    let cancelled = false;
    const res = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(ZOTERO_MAX_RESPONSE_CHARS + 1) }),
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
    const r = await fetchZoteroLibrary(
      { apiKey: KEY, library: USER_LIB },
      { fetch: fakeFetch },
    );
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
    const r = await fetchZoteroLibrary(
      { apiKey: KEY, library: USER_LIB },
      { fetch: fakeFetch },
    );
    expect(failure(r).kind).toBe("too-large");
    expect(cancelled).toBe(true);
    // The reader was cancelled as soon as the cap was crossed (small slack for
    // the stream's internal read-ahead) — nowhere near the 64-chunk total.
    expect(pulls).toBeLessThanOrEqual(5);
  });

  it("rejects an over-cap body even without a stream (text() fallback path)", async () => {
    const huge = "x".repeat(ZOTERO_MAX_RESPONSE_CHARS + 1);
    const fakeFetch = fetchSequence([page(huge)], []);
    const r = await fetchZoteroLibrary(
      { apiKey: KEY, library: USER_LIB },
      { fetch: fakeFetch },
    );
    expect(failure(r).kind).toBe("too-large");
  });

  it("decodes an under-cap streamed body whole (chunk-split BibTeX, no text() fallback)", async () => {
    const text = `${bib("alpha")}\n${bib("beta")}`;
    const bytes = new TextEncoder().encode(text);
    const mid = Math.floor(bytes.length / 2); // split mid-entry on purpose
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
      headers: new Headers({ "Last-Modified-Version": "9" }),
      body: stream,
      text: async () => {
        throw new Error("streaming path must not fall back to text()");
      },
    } as unknown as Response;
    const fakeFetch = fetchSequence([res], []);
    const r = await fetchZoteroLibrary(
      { apiKey: KEY, library: USER_LIB },
      { fetch: fakeFetch },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => e.key)).toEqual(["alpha", "beta"]);
    expect(r.libraryVersion).toBe(9);
  });

  it("fails closed on a non-empty page that parses to zero BibTeX entries", async () => {
    const fakeFetch = fetchSequence([page("<html>definitely not bibtex</html>")], []);
    const r = await fetchZoteroLibrary(
      { apiKey: KEY, library: USER_LIB },
      { fetch: fakeFetch },
    );
    const err = failure(r);
    expect(err.kind).toBe("bad-response");
    expect(err.message).not.toContain(KEY);
  });
});
