import { describe, it, expect } from "vitest";
import type { CheckResult } from "@galley/shared";
import {
  DEFAULT_THRESHOLD_CHARS,
  RETRIEVAL_SYSTEM_PROMPT,
  RETRIEVAL_TOOLS,
  renderRetrievalRead,
  retrievalActive,
  selectChunks,
  type ChunkRanker,
  type ContextRenderCtx,
} from "./context-view.js";
import { rankBySimilarity, type Embedder } from "./retrieve.js";
import { AGENT_TOOLS, SYSTEM_PROMPT, lineNumbered } from "./tools.js";

const DOC = [
  "= Introduction",
  "This document introduces apples and oranges as a friendly opening.",
  "",
  "= Methods",
  "We measured banana ripeness over several days using a calibrated sensor.",
  "",
  "= Results",
  "The penguins migrated south as the winter season set in across the ice.",
  "",
  "= Conclusion",
  "Final remarks concerning umbrellas, raincoats, and the persistent drizzle.",
  "",
].join("\n");

function ctx(over: Partial<ContextRenderCtx> = {}): ContextRenderCtx {
  return {
    scratch: DOC,
    userRequest: "improve the methods",
    lastCheck: null,
    maxChars: 6000,
    chunkMaxChars: 2000,
    ...over,
  };
}

function checkWithErrorAt(scratch: string, needle: string): CheckResult {
  const offset = scratch.indexOf(needle);
  return {
    ok: false,
    diagnostics: [
      {
        severity: "error",
        message: "unexpected token",
        span: {
          offset,
          endOffset: offset + needle.length,
          start: { line: 1, column: 1 },
          end: { line: 1, column: 1 },
        },
      },
    ],
    pageCount: null,
    durationMs: 0,
  };
}

describe("retrievalActive — the once-per-run activation decision", () => {
  const big = "x".repeat(DEFAULT_THRESHOLD_CHARS + 1);
  const small = "x".repeat(10);

  it("is OFF in full mode regardless of size", () => {
    expect(retrievalActive({ mode: "full" }, big)).toBe(false);
    expect(retrievalActive(undefined, big)).toBe(false);
  });

  it("is OFF in retrieval mode below the threshold", () => {
    expect(retrievalActive({ mode: "retrieval" }, small)).toBe(false);
  });

  it("is ON in retrieval mode above the threshold", () => {
    expect(retrievalActive({ mode: "retrieval" }, big)).toBe(true);
  });

  it("honours a custom thresholdChars", () => {
    expect(retrievalActive({ mode: "retrieval", thresholdChars: 5 }, small)).toBe(true);
    expect(retrievalActive({ mode: "retrieval", thresholdChars: 100 }, small)).toBe(false);
  });
});

describe("renderRetrievalRead — selected scope", () => {
  it("renders only the relevant section within a tight budget, with true line numbers + omitted markers", async () => {
    // chunkMaxChars keeps each section a single chunk; a tight budget forces one pick.
    const out = await renderRetrievalRead(
      {},
      ctx({ userRequest: "tune the banana ripeness measurement", maxChars: 90 }),
    );
    // The Methods section is the BM25 winner and is shown…
    expect(out.text).toContain("| = Methods");
    expect(out.text).toContain("banana ripeness");
    // …with a TRUE line number (Methods heading is line 4 in the full doc).
    expect(out.text).toContain("4| = Methods");
    // …and unrelated sections are hidden behind an omitted marker.
    expect(out.text).not.toContain("penguins migrated");
    expect(out.text).toMatch(/… omitted lines \d+–\d+ …/);
    expect(out.summary).toMatch(/^selected \d+ section\(s\); \d+\/\d+ lines$/);
  });

  it("shows everything when the budget fits the whole doc (no omitted markers)", async () => {
    const out = await renderRetrievalRead({}, ctx({ maxChars: 100_000 }));
    expect(out.text).toContain("apples and oranges");
    expect(out.text).toContain("banana ripeness");
    expect(out.text).toContain("penguins migrated");
    expect(out.text).toContain("umbrellas");
    expect(out.text).not.toContain("omitted lines");
  });

  it("pins chunks overlapping the latest error span FIRST, even when the query points elsewhere", async () => {
    // Query is about Methods, but the compile error lands in the Conclusion section.
    const out = await renderRetrievalRead(
      { query: "banana ripeness sensor" },
      ctx({
        userRequest: "tune the banana ripeness measurement",
        maxChars: 90,
        lastCheck: checkWithErrorAt(DOC, "umbrellas"),
      }),
    );
    // The erroring region is pinned and visible so self-correction can see it.
    expect(out.text).toContain("umbrellas");
    expect(out.text).toContain("| = Conclusion");
  });
});

describe("renderRetrievalRead — range scope", () => {
  it("renders a specific line window with true numbers + surrounding omitted markers", async () => {
    const out = await renderRetrievalRead(
      { scope: "range", range: { startLine: 4, endLine: 5 } },
      ctx(),
    );
    expect(out.text).toContain("4| = Methods");
    expect(out.text).toContain("banana ripeness");
    expect(out.text).not.toContain("apples and oranges");
    expect(out.text).not.toContain("penguins migrated");
    expect(out.summary).toBe(`lines 4–5 of ${realLines(DOC)}`);
  });

  it("clamps an out-of-bounds range to the document", async () => {
    const out = await renderRetrievalRead(
      { scope: "range", range: { startLine: -5, endLine: 9999 } },
      ctx(),
    );
    expect(out.summary).toBe(`lines 1–${realLines(DOC)} of ${realLines(DOC)}`);
  });

  it("falls back to selected on an invalid range", async () => {
    const out = await renderRetrievalRead({ scope: "range" }, ctx({ maxChars: 90 }));
    expect(out.summary).toMatch(/^selected /);
  });
});

describe("renderRetrievalRead — full scope (escape hatch)", () => {
  it("returns the whole doc identical to the base line-numbered render", async () => {
    const out = await renderRetrievalRead({ scope: "full" }, ctx());
    expect(out.text).toBe(lineNumbered(DOC));
    expect(out.summary).toContain("(full)");
  });

  it("treats an unknown scope as selected", async () => {
    const out = await renderRetrievalRead({ scope: "nonsense" }, ctx({ maxChars: 90 }));
    expect(out.summary).toMatch(/^selected /);
  });
});

describe("renderRetrievalRead — outline scope", () => {
  it("returns a compact heading map with true line numbers, no bodies", async () => {
    const out = await renderRetrievalRead({ scope: "outline" }, ctx());
    expect(out.text).toContain("Document outline");
    expect(out.text).toContain("L1: = Introduction");
    expect(out.text).toContain("L4: = Methods");
    expect(out.text).toContain("L7: = Results");
    expect(out.text).toContain("L10: = Conclusion");
    // bodies are NOT included
    expect(out.text).not.toContain("banana ripeness");
    expect(out.summary).toBe("outline: 4 section(s)");
  });

  it("labels a leading preamble before the first heading", async () => {
    const withPreamble = `Some front matter before any heading here.\n\n= Body\nThe body text.\n`;
    const out = await renderRetrievalRead({ scope: "outline" }, ctx({ scratch: withPreamble }));
    expect(out.text).toContain("L1: (preamble)");
    expect(out.text).toContain("= Body");
  });
});

describe("renderRetrievalRead — section scope", () => {
  it("renders one whole section by heading title", async () => {
    const out = await renderRetrievalRead({ scope: "section", heading: "Methods" }, ctx());
    expect(out.text).toContain("4| = Methods");
    expect(out.text).toContain("banana ripeness");
    expect(out.text).not.toContain("apples and oranges");
    expect(out.text).not.toContain("penguins migrated");
    expect(out.summary).toContain('section "Methods"');
  });

  it("matches case-insensitively and by substring", async () => {
    expect(
      (await renderRetrievalRead({ scope: "section", heading: "methods" }, ctx())).text,
    ).toContain("banana ripeness");
    expect(
      (await renderRetrievalRead({ scope: "section", heading: "Concl" }, ctx())).text,
    ).toContain("umbrellas");
  });

  it("falls back to selected when the heading is missing or unknown", async () => {
    expect(
      (await renderRetrievalRead({ scope: "section" }, ctx({ maxChars: 90 }))).summary,
    ).toMatch(/^selected /);
    expect(
      (await renderRetrievalRead({ scope: "section", heading: "Nonexistent" }, ctx({ maxChars: 90 })))
        .summary,
    ).toMatch(/^selected /);
  });
});

describe("selectChunks — budget + guarantees", () => {
  it("always returns at least the single best chunk under a tiny budget", async () => {
    const picked = await selectChunks(ctx({ maxChars: 1 }), "banana ripeness");
    expect(picked.length).toBe(1);
    expect(picked[0]!.text).toContain("banana ripeness");
  });

  it("includes a pinned (erroring) chunk even when over budget", async () => {
    const picked = await selectChunks(
      ctx({ maxChars: 1, lastCheck: checkWithErrorAt(DOC, "umbrellas") }),
      "banana ripeness",
    );
    expect(picked.some((c) => c.text.includes("umbrellas"))).toBe(true);
  });
});

describe("injected semantic ranker (slice 3c)", () => {
  // A ranker that ignores the query and forces the "penguins" (Results) chunk first.
  const penguinsFirst: ChunkRanker = (chunks) =>
    chunks
      .map((chunk) => ({ chunk, score: chunk.text.includes("penguins") ? 100 : 0 }))
      .sort((a, b) => b.score - a.score || a.chunk.start - b.chunk.start);

  it("honours an injected (sync) ranker for the selected excerpt", async () => {
    const picked = await selectChunks(
      ctx({ maxChars: 90 }),
      "banana ripeness", // BM25 would pick Methods…
      penguinsFirst, // …but the injected ranker wins.
    );
    expect(picked.some((c) => c.text.includes("penguins"))).toBe(true);
    expect(picked.some((c) => c.text.includes("banana ripeness"))).toBe(false);
  });

  it("supports an async ranker", async () => {
    const asyncRanker: ChunkRanker = async (chunks, query) => penguinsFirst(chunks, query);
    const out = await renderRetrievalRead({}, ctx({ maxChars: 90 }), asyncRanker);
    expect(out.text).toContain("penguins");
    expect(out.text).not.toContain("banana ripeness");
  });

  it("composes with the embedding seam (Embedder + rankBySimilarity)", async () => {
    // A fake embedder: the query + any chunk mentioning "umbrellas" share a direction;
    // everything else is orthogonal. No model — pure injected vectors.
    const fakeEmbedder: Embedder = {
      async embed(texts) {
        return texts.map((t) => (t.includes("umbrellas") || t === "weather" ? [1, 0] : [0, 1]));
      },
    };
    const semanticRanker: ChunkRanker = async (chunks, query) => {
      const vecs = await fakeEmbedder.embed([query, ...chunks.map((c) => c.text)]);
      const [qv, ...cvs] = vecs;
      return rankBySimilarity(chunks, qv!, cvs);
    };
    const out = await renderRetrievalRead({}, ctx({ maxChars: 90 }), semanticRanker);
    // The query "weather" is embedding-closest to the Conclusion (umbrellas) chunk.
    const picked = await selectChunks(
      { ...ctx({ maxChars: 90 }), userRequest: "weather" },
      undefined,
      semanticRanker,
    );
    expect(out).toBeTruthy();
    expect(picked.some((c) => c.text.includes("umbrellas"))).toBe(true);
  });
});

describe("Code-Reviewer regression fixes", () => {
  // Two distinct sections that share a heading title must NOT be collapsed.
  const DUP = [
    "= Notes",
    "First notes body about alpha.",
    "",
    "= Other",
    "An unrelated middle section.",
    "",
    "= Notes",
    "Second notes body about omega.",
    "",
  ].join("\n");

  it("keeps repeated identical headings as separate sections (outline + section)", async () => {
    const outline = await renderRetrievalRead({ scope: "outline" }, ctx({ scratch: DUP }));
    expect(outline.summary).toBe("outline: 3 section(s)");
    expect(outline.text).toContain("L1: = Notes");
    expect(outline.text).toContain("L7: = Notes");
    // section by a duplicated title resolves to the FIRST occurrence, not a merge.
    const sec = await renderRetrievalRead({ scope: "section", heading: "Notes" }, ctx({ scratch: DUP }));
    expect(sec.text).toContain("First notes body about alpha.");
    expect(sec.text).not.toContain("Second notes body about omega.");
  });

  it("pins the erroring tail for a zero-length end-of-file diagnostic", async () => {
    const eof: CheckResult = {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          message: "unexpected end of input",
          span: {
            offset: DOC.length,
            endOffset: DOC.length,
            start: { line: 1, column: 1 },
            end: { line: 1, column: 1 },
          },
        },
      ],
      pageCount: null,
      durationMs: 0,
    };
    // Query points at the Introduction; the EOF error must still pin the last section.
    const picked = await selectChunks(ctx({ maxChars: 90, lastCheck: eof }), "apples and oranges");
    expect(picked.some((c) => c.text.includes("umbrellas"))).toBe(true);
  });

  it("falls back to the first chunk when an injected ranker returns nothing", async () => {
    const emptyRanker: ChunkRanker = () => [];
    const picked = await selectChunks(ctx({ maxChars: 90 }), "anything", emptyRanker);
    expect(picked.length).toBe(1);
    expect(picked[0]!.start).toBe(0); // the leading chunk, never an all-omitted view
  });

  it("keeps offset→line mapping correct across astral (multi-code-unit) characters", async () => {
    const astral = ["= Title", "Body with an emoji 😀😀 inside.", "", "= Next", "Second body.", ""].join(
      "\n",
    );
    // The emoji bumps UTF-16 offsets on line 2; the section heading is still line 4.
    const out = await renderRetrievalRead({ scope: "section", heading: "Next" }, ctx({ scratch: astral }));
    expect(out.text).toContain("4| = Next");
    expect(out.text).toContain("Second body.");
    expect(out.text).not.toContain("emoji");
  });
});

describe("retrieval tool + prompt surface", () => {
  it("keeps the read_document name but adds scope/range/heading/query params", () => {
    const read = RETRIEVAL_TOOLS.find((t) => t.name === "read_document")!;
    const props = read.parameters.properties as Record<string, unknown>;
    expect(props).toHaveProperty("scope");
    expect(props).toHaveProperty("range");
    expect(props).toHaveProperty("heading");
    expect(props).toHaveProperty("query");
    // compile + propose_edit are untouched (same references as the base tools).
    expect(RETRIEVAL_TOOLS[1]).toBe(AGENT_TOOLS[1]);
    expect(RETRIEVAL_TOOLS[2]).toBe(AGENT_TOOLS[2]);
  });

  it("extends (does not replace) the base system prompt", () => {
    expect(RETRIEVAL_SYSTEM_PROMPT.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(RETRIEVAL_SYSTEM_PROMPT.length).toBeGreaterThan(SYSTEM_PROMPT.length);
  });
});

function realLines(s: string): number {
  const parts = s.split("\n");
  return s.endsWith("\n") ? parts.length - 1 : parts.length;
}
