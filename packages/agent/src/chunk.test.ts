/**
 * Roadmap #9 slice 1: the Typst document chunker — the pure, offline core of
 * context economics. As a document grows, the agent should receive SELECTED
 * context, not the whole doc; chunking is the first step. Splits a Typst source
 * into structural chunks (by headings), each carrying its heading path + exact
 * char offsets, and splits oversized sections at paragraph boundaries.
 */
import { describe, it, expect } from "vitest";
import { chunkDocument } from "./chunk.js";

const doc = `Intro preamble line.

= Introduction
Background on the topic.

== Motivation
Why it matters.

= Methods
The approach we took.
`;

describe("chunkDocument", () => {
  it("splits by headings and records each chunk's heading path", () => {
    const chunks = chunkDocument(doc);
    const summary = chunks.map((c) => c.headingPath.join(" / "));
    // Preamble (no heading) + the three sections.
    expect(summary).toEqual(["", "Introduction", "Introduction / Motivation", "Methods"]);
    expect(chunks[1]!.text).toContain("Background on the topic");
    expect(chunks[2]!.headingPath).toEqual(["Introduction", "Motivation"]);
  });

  it("offsets are exact and round-trip to the source slice", () => {
    const chunks = chunkDocument(doc);
    for (const c of chunks) {
      expect(doc.slice(c.start, c.end)).toBe(c.text);
    }
    // Chunks are non-overlapping and in document order.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.start).toBeGreaterThanOrEqual(chunks[i - 1]!.end);
    }
  });

  it("assigns stable, unique ids", () => {
    const chunks = chunkDocument(doc);
    const ids = chunks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Stable across runs.
    expect(chunkDocument(doc).map((c) => c.id)).toEqual(ids);
  });

  it("a no-heading document yields a single chunk (empty heading path)", () => {
    const chunks = chunkDocument("Just a paragraph.\n\nAnd another.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.headingPath).toEqual([]);
  });

  it("splits an oversized section at paragraph (blank-line) boundaries", () => {
    const para = "x".repeat(80);
    const big = `= Big\n${para}\n\n${para}\n\n${para}\n`;
    const chunks = chunkDocument(big, { maxChars: 120 });
    // The one section is broken into multiple chunks, none far over the cap...
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(200);
    // ...all still under the same heading.
    for (const c of chunks) expect(c.headingPath).toEqual(["Big"]);
    // And the concatenation preserves every paragraph.
    expect(chunks.map((c) => c.text).join("")).toContain(para);
  });

  it("pops the heading stack correctly when a higher-level heading follows a deeper one", () => {
    const nested = `= A\n== A1\ndeep\n= B\nshallow\n`;
    const paths = chunkDocument(nested).map((c) => c.headingPath.join("/"));
    expect(paths).toEqual(["A", "A/A1", "B"]); // B resets to level 1
  });

  it("ignores '=' that is not a heading (no space, or mid-line)", () => {
    const tricky = `= Real\nlet x = 1\n=notheading\n`;
    const chunks = chunkDocument(tricky);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.headingPath).toEqual(["Real"]);
    expect(chunks[0]!.text).toContain("=notheading"); // body, not a heading
  });

  it("handles an empty document", () => {
    expect(chunkDocument("")).toEqual([]);
  });
});
