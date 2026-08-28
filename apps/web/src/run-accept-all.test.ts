import { describe, it, expect } from "vitest";
import {
  applyRunAccepts,
  isRecordSigned,
  isGroupVerified,
  type AcceptableRecord,
} from "./run-accept-all.js";

/**
 * Unit pins for the Accept-all ordering helper (ADR-0025 §5, Task 5). The helper
 * is pure over an injected per-record accept callback so it can be tested in the
 * node gate (no DOM): it applies a run's pending records in publish `seq` order
 * and STOPS on the first failure/conflict, leaving the remainder pending — a
 * partial apply is allowed and REPORTED, never a silent skip.
 */

/** A minimal record stub — the helper only needs `id` + `seq` for ordering/report. */
function rec(id: string, seq: number): AcceptableRecord {
  return { id, seq } as AcceptableRecord;
}

describe("applyRunAccepts", () => {
  it("applies every record in seq order on the all-success path", async () => {
    const order: string[] = [];
    const result = await applyRunAccepts(
      // Deliberately out of order on input — the helper must sort by seq.
      [rec("c", 3), rec("a", 1), rec("b", 2)],
      async (r) => {
        order.push(r.id);
        return true;
      },
    );
    expect(order).toEqual(["a", "b", "c"]);
    expect(result.applied).toEqual(["a", "b", "c"]);
    expect(result.remaining).toEqual([]);
    expect(result.stoppedAt).toBeNull();
  });

  it("stops on the FIRST false and leaves the remainder pending (partial apply, reported)", async () => {
    const tried: string[] = [];
    const result = await applyRunAccepts(
      [rec("a", 1), rec("b", 2), rec("c", 3)],
      async (r) => {
        tried.push(r.id);
        return r.id !== "b"; // b conflicts
      },
    );
    // Only a + the failing b were attempted; c was never tried (stop-on-first).
    expect(tried).toEqual(["a", "b"]);
    expect(result.applied).toEqual(["a"]);
    expect(result.stoppedAt).toBe("b");
    // The failed record AND everything after it remain pending.
    expect(result.remaining).toEqual(["b", "c"]);
  });

  it("stops immediately when the very first record fails", async () => {
    const result = await applyRunAccepts(
      [rec("a", 1), rec("b", 2)],
      async () => false,
    );
    expect(result.applied).toEqual([]);
    expect(result.stoppedAt).toBe("a");
    expect(result.remaining).toEqual(["a", "b"]);
  });

  it("treats an empty run as a clean no-op", async () => {
    const result = await applyRunAccepts([], async () => true);
    expect(result.applied).toEqual([]);
    expect(result.remaining).toEqual([]);
    expect(result.stoppedAt).toBeNull();
  });
});

describe("provenance derivation", () => {
  const signed = { id: "a", seq: 1, sig: "abc" } as AcceptableRecord;
  const unsigned = { id: "b", seq: 2 } as AcceptableRecord;
  const emptySig = { id: "c", seq: 3, sig: "" } as AcceptableRecord;

  it("treats a non-empty sig as signed and a missing/empty sig as unsigned", () => {
    expect(isRecordSigned(signed)).toBe(true);
    expect(isRecordSigned(unsigned)).toBe(false);
    expect(isRecordSigned(emptySig)).toBe(false);
  });

  it("verifies a group only when EVERY record is signed (non-empty)", () => {
    expect(isGroupVerified([signed])).toBe(true);
    expect(isGroupVerified([signed, signed])).toBe(true);
    // A single unsigned record taints the whole group → unverified.
    expect(isGroupVerified([signed, unsigned])).toBe(false);
    // An empty group is not verified (nothing to bulk-accept).
    expect(isGroupVerified([])).toBe(false);
  });
});
