import { describe, it, expect } from "vitest";
import { connectZoteroLibrary, type ZoteroImportResult } from "./zotero-import.js";

/**
 * #17.1 Zotero library UI seam — the pure helper the CitationPanel's "Zotero" tab
 * mounts. Per the repo's Node-env house pattern (CitationPanel.test /
 * citation-library.test) we exercise the exported helper directly; the rendered
 * tab + Connect click flow is covered by the Playwright e2e.
 *
 * The fetch seam stays INJECTED + fail-closed — these tests never touch the
 * network: a fake `fetch` returns a BibTeX library page (success), a non-OK
 * response (typed error), or a 304 (notModified). The API key must never appear
 * in any error message.
 */

const BIBTEX_PAGE = `@article{vaswani2017,
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

const SECRET_KEY = "SUPERSECRETKEY1234567890";

/** A fake `fetch` returning one BibTeX page as 200, no rel="next" (single page). */
function okLibraryFetch(body: string, headers: Record<string, string> = {}): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      headers: new Headers({ "Last-Modified-Version": "42", ...headers }),
      body: null,
      text: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

/** A fake `fetch` returning a non-OK response (typed upstream error). */
function statusFetch(status: number): typeof fetch {
  return (async () =>
    ({
      ok: false,
      status,
      headers: new Headers(),
      body: null,
      text: async () => "",
    }) as unknown as Response) as unknown as typeof fetch;
}

/** A fake `fetch` returning 304 Not Modified for a conditional request. */
function notModifiedFetch(): typeof fetch {
  return (async () =>
    ({
      ok: false,
      status: 304,
      headers: new Headers({ "Last-Modified-Version": "42" }),
      body: null,
      text: async () => "",
    }) as unknown as Response) as unknown as typeof fetch;
}

describe("zotero-import.connectZoteroLibrary (#17.1)", () => {
  it("shapes a fetched library into reviewable, keyed rows", async () => {
    const r = await connectZoteroLibrary({
      library: { kind: "user", id: "12345" },
      apiKey: SECRET_KEY,
      fetch: okLibraryFetch(BIBTEX_PAGE),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.parsedCount).toBe(2);
    expect(r.result.entries).toHaveLength(2);
    expect(r.result.duplicateCount).toBe(0);
    expect(r.result.entries[0]!.key).toBe("vaswani2017");
    expect(r.result.entries[0]!.entry.title).toBe("Attention Is All You Need");
    // Each row is a full ResolvedCitation → same add-to-bibliography path.
    expect(r.result.entries[0]!.kind).toBe("bibtex");
    expect(r.result.entries[0]!.hayagriva).toContain("vaswani2017:");
    expect(r.libraryVersion).toBe(42);
    expect(r.truncated).toBe(false);
    expect(r.notModified).toBe(false);
  });

  it("re-keys against existing bibliography keys (duplicates flagged)", async () => {
    const r = await connectZoteroLibrary({
      library: { kind: "group", id: "999" },
      apiKey: SECRET_KEY,
      fetch: okLibraryFetch(BIBTEX_PAGE),
      existingKeys: ["vaswani2017"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const vaswani = r.result.entries.find(
      (e) => e.entry.title === "Attention Is All You Need",
    )!;
    expect(vaswani.duplicate).toBe(true);
    expect(vaswani.key).not.toBe("vaswani2017");
    expect(vaswani.key).toContain("vaswani2017");
    const knuth = r.result.entries.find((e) => e.entry.title === "The TeXbook")!;
    expect(knuth.duplicate).toBe(false);
    expect(r.result.duplicateCount).toBe(1);
  });

  it("returns a typed error on an upstream failure (never throws)", async () => {
    const r = await connectZoteroLibrary({
      library: { kind: "user", id: "12345" },
      apiKey: SECRET_KEY,
      fetch: statusFetch(401),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("invalid-key");
    expect(typeof r.error.message).toBe("string");
  });

  it("NEVER echoes the API key in an error message", async () => {
    const r = await connectZoteroLibrary({
      library: { kind: "user", id: "12345" },
      apiKey: SECRET_KEY,
      fetch: statusFetch(403),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).not.toContain(SECRET_KEY);
  });

  it("rejects an invalid library id before any IO, with no key in the message", async () => {
    let called = false;
    const spyFetch = (async () => {
      called = true;
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    const r = await connectZoteroLibrary({
      library: { kind: "user", id: "not-numeric" },
      apiKey: SECRET_KEY,
      fetch: spyFetch,
    });
    expect(called).toBe(false);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("invalid-library");
    expect(r.error.message).not.toContain(SECRET_KEY);
  });

  it("surfaces notModified honestly (empty rows, version preserved)", async () => {
    const r = await connectZoteroLibrary({
      library: { kind: "user", id: "12345" },
      apiKey: SECRET_KEY,
      fetch: notModifiedFetch(),
      previousLibraryVersion: 42,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.notModified).toBe(true);
    expect(r.result.entries).toHaveLength(0);
    expect(r.libraryVersion).toBe(42);
  });

  it("surfaces truncation honestly when the library overflows the page cap", async () => {
    // 20 full pages, each advertising a next page → truncated:true at the cap.
    const fetchManyPages = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({
          "Last-Modified-Version": "7",
          Link: '<https://api.zotero.org/next>; rel="next"',
        }),
        body: null,
        text: async () => BIBTEX_PAGE,
      }) as unknown as Response) as unknown as typeof fetch;
    const r = await connectZoteroLibrary({
      library: { kind: "user", id: "12345" },
      apiKey: SECRET_KEY,
      fetch: fetchManyPages,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(true);
  });
});

// Type-only assertion the result discriminant is usable by the UI without casts.
const _shape: ZoteroImportResult = { ok: false, error: { kind: "network", message: "x" } };
void _shape;
