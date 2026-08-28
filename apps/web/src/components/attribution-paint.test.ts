import { describe, expect, it } from "vitest";
import type { AttributedRange } from "@galley/collab";
import type { Author } from "@galley/shared";
import { buildAttributionDecorations } from "./attribution-paint.js";

const alice: Author = { kind: "human", userId: "alice" };
const bob: Author = { kind: "human", userId: "bob" };
const agent: Author = { kind: "agent", runId: "run-7" };

function range(from: number, to: number, author: Author | undefined): AttributedRange {
  return { from, to, clientID: from, author };
}

describe("buildAttributionDecorations", () => {
  it("paints NOTHING for a solo document — one author is no signal", () => {
    const ranges = [range(0, 5, alice), range(5, 12, alice)];
    expect(buildAttributionDecorations(ranges, 12).size).toBe(0);
  });

  it("paints when two distinct humans share the document", () => {
    const ranges = [range(0, 5, alice), range(5, 12, bob)];
    expect(buildAttributionDecorations(ranges, 12).size).toBe(2);
  });

  it("treats the agent as a distinct author (human + agent → painted)", () => {
    const ranges = [range(0, 5, alice), range(5, 12, agent)];
    expect(buildAttributionDecorations(ranges, 12).size).toBe(2);
  });

  it("ignores unregistered spans when counting authors (one real author → no paint)", () => {
    const ranges = [range(0, 5, alice), range(5, 12, undefined)];
    expect(buildAttributionDecorations(ranges, 12).size).toBe(0);
  });

  it("clamps and drops out-of-range spans against docLength", () => {
    const ranges = [range(0, 5, alice), range(5, 99, bob)];
    // Both authors present → painted; the second span clamps to docLength.
    expect(buildAttributionDecorations(ranges, 8).size).toBe(2);
  });
});
