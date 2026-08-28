import { describe, it, expect } from "vitest";
import { selectionTooltipPos } from "./comment-create-tooltip.js";
import {
  sortOverviewThreads,
  partitionOverviewThreads,
  type OverviewThread,
} from "./CommentsOverview.js";

/**
 * Pure-logic unit tests for the Comments Phase A web-app UI (Layers 3 + 5): the
 * selection→bubble decision and the cross-file overview's document-ordering +
 * orphan partition. The React/CodeMirror wiring around them is exercised by the
 * Layer 7 e2e; these pin the data transforms that feed it.
 */

describe("selectionTooltipPos", () => {
  it("anchors the bubble at a non-empty selection's head", () => {
    expect(selectionTooltipPos({ from: 6, to: 11 })).toBe(11);
  });
  it("returns null for an empty (collapsed) selection — no bubble", () => {
    expect(selectionTooltipPos({ from: 4, to: 4 })).toBeNull();
  });
  it("returns null for a reversed/degenerate range", () => {
    expect(selectionTooltipPos({ from: 9, to: 3 })).toBeNull();
  });
});

function row(over: Partial<OverviewThread> & { id: string; order: [number, number] }): OverviewThread {
  return {
    fileId: "f",
    filePath: "main.typ",
    anchorText: "x",
    status: "open",
    messageCount: 1,
    orphaned: false,
    ...over,
  };
}

describe("sortOverviewThreads (document order)", () => {
  it("orders by file index, then within-file offset, then id", () => {
    const out = sortOverviewThreads([
      row({ id: "b", order: [1, 0] }),
      row({ id: "a", order: [0, 50] }),
      row({ id: "c", order: [0, 10] }),
    ]);
    expect(out.map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("is a copy — does not mutate the input array", () => {
    const input = [row({ id: "b", order: [1, 0] }), row({ id: "a", order: [0, 0] })];
    const before = input.map((t) => t.id);
    sortOverviewThreads(input);
    expect(input.map((t) => t.id)).toEqual(before);
  });
});

describe("partitionOverviewThreads", () => {
  const threads = [
    row({ id: "open1", order: [0, 0], status: "open" }),
    row({ id: "done1", order: [0, 10], status: "resolved" }),
    row({ id: "orphan1", order: [0, 20], status: "open", orphaned: true }),
  ];

  it("the open filter keeps only non-orphaned open threads", () => {
    const { live, orphans } = partitionOverviewThreads(threads, "open");
    expect(live.map((t) => t.id)).toEqual(["open1"]);
    expect(orphans.map((t) => t.id)).toEqual(["orphan1"]);
  });

  it("the resolved filter keeps only non-orphaned resolved threads", () => {
    const { live, orphans } = partitionOverviewThreads(threads, "resolved");
    expect(live.map((t) => t.id)).toEqual(["done1"]);
    // Orphans are ALWAYS surfaced regardless of the status filter.
    expect(orphans.map((t) => t.id)).toEqual(["orphan1"]);
  });
});
