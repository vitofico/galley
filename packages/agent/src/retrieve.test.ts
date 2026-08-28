/**
 * Roadmap #9 slice 2: retrieval + selection over chunks. BM25 ranks the relevant
 * section first; selection respects a budget and returns document order; the
 * semantic helpers (cosine / similarity ranking) are pure and tested with fixed
 * vectors (no model).
 */
import { describe, it, expect } from "vitest";
import { chunkDocument } from "./chunk.js";
import { rankChunks, selectContext, cosineSimilarity, rankBySimilarity } from "./retrieve.js";

const doc = `= Introduction
This paper studies relativity and the speed of light.

= Methods
We used a Michelson interferometer to measure interference fringes.

= Results
The photoelectric effect confirmed the quantum hypothesis.

= Discussion
Implications for spacetime and gravity are profound.
`;
const chunks = chunkDocument(doc);

describe("rankChunks (BM25)", () => {
  it("ranks the most relevant section first", () => {
    const ranked = rankChunks(chunks, "interferometer interference measurement");
    expect(ranked[0]!.chunk.headingPath).toEqual(["Methods"]);
    expect(ranked[0]!.score).toBeGreaterThan(0);
  });

  it("matches heading terms too (heading path is searchable)", () => {
    const ranked = rankChunks(chunks, "discussion");
    expect(ranked[0]!.chunk.headingPath).toEqual(["Discussion"]);
  });

  it("gives every chunk score 0 for a query that matches nothing", () => {
    for (const r of rankChunks(chunks, "zzzq nonexistentterm")) expect(r.score).toBe(0);
  });

  // A heading-only stub whose HEADING TEXT matches a query term ("frequency").
  // BM25 length-normalization inflates the tiny 2-token stub so it outranks the
  // long Analysis chunk that actually contains the queried terms — the F3 bug.
  const headingHeavy = `= Frequency

= Background

= Analysis
The bearing defect produces a vibration at a frequency given by the formula
relating the outer race and inner race geometry to the shaft speed of the rotor.

= Summary

= Appendix
`;
  const contentQuery = "bearing defect vibration frequency formula outer inner race";

  it("ranks a content-bearing chunk above a bare heading-only stub for a content query", () => {
    const hChunks = chunkDocument(headingHeavy);
    const ranked = rankChunks(hChunks, contentQuery);
    expect(ranked[0]!.chunk.headingPath).toEqual(["Analysis"]);
  });

  it("under a tight budget, selects the content chunk, not heading-only stubs", () => {
    const hChunks = chunkDocument(headingHeavy);
    const selected = selectContext(hChunks, contentQuery, { maxChars: 120 });
    expect(selected.some((c) => c.headingPath[0] === "Analysis")).toBe(true);
  });

  it("still returns heading-only chunks for a structure/outline query (fallback)", () => {
    // An all-headings document: there are NO content-bearing chunks, so the
    // matching heading chunk must still be returned (no regression to empty).
    const outline = `= Introduction

= Methodology

= Conclusion
`;
    const oChunks = chunkDocument(outline);
    const ranked = rankChunks(oChunks, "methodology");
    expect(ranked[0]!.chunk.headingPath).toEqual(["Methodology"]);
    expect(ranked[0]!.score).toBeGreaterThan(0);
    // Tight budget that fits only ONE heading stub: the matching one must win.
    const selected = selectContext(oChunks, "methodology", { maxChars: 15 });
    expect(selected).toHaveLength(1);
    expect(selected[0]!.headingPath).toEqual(["Methodology"]);
  });
});

describe("selectContext", () => {
  it("selects the relevant chunk and returns document order", () => {
    const selected = selectContext(chunks, "photoelectric quantum effect", { maxChars: 200 });
    expect(selected.some((c) => c.headingPath[0] === "Results")).toBe(true);
    // Document order (ascending start) preserved for coherent context.
    for (let i = 1; i < selected.length; i++) {
      expect(selected[i]!.start).toBeGreaterThan(selected[i - 1]!.start);
    }
  });

  it("respects the char budget", () => {
    const budget = 120;
    const selected = selectContext(chunks, "relativity spacetime gravity", { maxChars: budget });
    const total = selected.reduce((s, c) => s + c.text.length, 0);
    // Either within budget, or a single over-budget best chunk (the guarantee).
    expect(selected.length === 1 || total <= budget).toBe(true);
    expect(selected.length).toBeGreaterThanOrEqual(1);
  });

  it("with a generous budget, includes multiple relevant chunks", () => {
    const selected = selectContext(chunks, "relativity light spacetime", { maxChars: 10_000 });
    expect(selected.length).toBeGreaterThan(1);
  });

  it("falls back to the single best chunk when nothing fits the budget", () => {
    const selected = selectContext(chunks, "interferometer", { maxChars: 1 });
    expect(selected).toHaveLength(1);
  });
});

describe("semantic helpers (pure, injected embeddings)", () => {
  it("cosineSimilarity: identical → 1, orthogonal → 0, zero-vector → 0", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("rankBySimilarity orders chunks by cosine to the query vector", () => {
    const three = chunkDocument("= A\naaa\n\n= B\nbbb\n\n= C\nccc\n");
    const queryVec = [1, 0];
    const chunkVecs = [
      [0, 1], // A — orthogonal
      [1, 0], // B — identical
      [0.7, 0.1], // C — close-ish
    ];
    const ranked = rankBySimilarity(three, queryVec, chunkVecs);
    expect(ranked[0]!.chunk.headingPath).toEqual(["B"]);
    expect(ranked[ranked.length - 1]!.chunk.headingPath).toEqual(["A"]);
  });
});
