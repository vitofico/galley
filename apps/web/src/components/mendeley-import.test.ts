import { describe, it, expect } from "vitest";
import { connectMendeleyLibrary, type MendeleyImportResult } from "./mendeley-import.js";

/**
 * #17.1 Mendeley library UI seam (sibling of `zotero-import.test.ts`) — the pure
 * helper the CitationPanel's "Mendeley" tab mounts. Per the repo's Node-env house
 * pattern (CitationPanel.test / citation-library.test) we exercise the exported
 * helper directly; the rendered tab + Connect click flow is covered by the
 * Playwright e2e.
 *
 * The fetch seam stays INJECTED + fail-closed — these tests never touch the
 * network: a fake `fetch` returns a Mendeley JSON-array page (success), a non-OK
 * response (typed error), or empty/garbage. The access token must never appear in
 * any error message.
 */

/** A canned Mendeley library: a JSON ARRAY of document objects (null fields omitted). */
const MENDELEY_PAGE = JSON.stringify([
  {
    title: "Attention Is All You Need",
    type: "journal",
    year: 2017,
    source: "NeurIPS",
    authors: [
      { first_name: "Ashish", last_name: "Vaswani" },
      { first_name: "Noam", last_name: "Shazeer" },
    ],
  },
  {
    title: "The TeXbook",
    type: "book",
    year: 1984,
    publisher: "Addison-Wesley",
    authors: [{ first_name: "Donald E.", last_name: "Knuth" }],
  },
]);

const SECRET_TOKEN = "SUPERSECRETBEARERTOKEN1234567890";

/** A fake `fetch` returning one JSON-array page as 200, no rel="next" (single page). */
function okLibraryFetch(body: string, headers: Record<string, string> = {}): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      headers: new Headers(headers),
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

describe("mendeley-import.connectMendeleyLibrary (#17.1)", () => {
  it("shapes a fetched library into reviewable, keyed rows", async () => {
    const r = await connectMendeleyLibrary({
      apiToken: SECRET_TOKEN,
      fetch: okLibraryFetch(MENDELEY_PAGE),
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
    expect(r.truncated).toBe(false);
  });

  it("re-keys against existing bibliography keys (duplicates flagged)", async () => {
    const r = await connectMendeleyLibrary({
      apiToken: SECRET_TOKEN,
      fetch: okLibraryFetch(MENDELEY_PAGE),
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
    const r = await connectMendeleyLibrary({
      apiToken: SECRET_TOKEN,
      fetch: statusFetch(401),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("invalid-token");
    expect(typeof r.error.message).toBe("string");
  });

  it("NEVER echoes the access token in an error message", async () => {
    const r = await connectMendeleyLibrary({
      apiToken: SECRET_TOKEN,
      fetch: statusFetch(403),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).not.toContain(SECRET_TOKEN);
  });

  it("rejects an empty token before any IO, with no token in the message", async () => {
    let called = false;
    const spyFetch = (async () => {
      called = true;
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    const r = await connectMendeleyLibrary({
      apiToken: "   ",
      fetch: spyFetch,
    });
    expect(called).toBe(false);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("invalid-token");
    expect(r.error.message).not.toContain(SECRET_TOKEN);
  });

  it("fails closed on a non-array JSON body (bad-response)", async () => {
    const r = await connectMendeleyLibrary({
      apiToken: SECRET_TOKEN,
      fetch: okLibraryFetch('{"documents": []}'),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("bad-response");
    expect(r.error.message).not.toContain(SECRET_TOKEN);
  });

  it("surfaces truncation honestly when the library overflows the page cap", async () => {
    // Every page advertises a next marker → truncated:true at the cap.
    const fetchManyPages = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({
          Link: '<https://api.mendeley.com/documents?view=all&limit=100&marker=abc123>; rel="next"',
        }),
        body: null,
        text: async () => MENDELEY_PAGE,
      }) as unknown as Response) as unknown as typeof fetch;
    const r = await connectMendeleyLibrary({
      apiToken: SECRET_TOKEN,
      fetch: fetchManyPages,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(true);
  });
});

// Type-only assertion the result discriminant is usable by the UI without casts.
const _shape: MendeleyImportResult = { ok: false, error: { kind: "network", message: "x" } };
void _shape;
