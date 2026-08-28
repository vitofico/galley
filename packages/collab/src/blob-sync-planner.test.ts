import { describe, it, expect } from "vitest";
import {
  planBlobDemand,
  planBlobServe,
  decodeWantList,
  BLOB_WANT_BATCH_MAX,
  BLOB_WANTS_FIELD,
  type BlobPointer,
  type PeerBlobWant,
} from "./blob-sync-planner.js";

const H = (c: string) => c.repeat(64);
const ptr = (hash: string, size = 3): BlobPointer => ({ hash, size });
/** A predicate over a set of hashes (present bytes / servable grants / …). */
const inSet = (...members: string[]) => {
  const set = new Set(members);
  return (h: string) => set.has(h);
};
const peer = (clientId: number, requestId: string, hashes: string[]): PeerBlobWant => ({
  clientId,
  wants: { v: 1, requestId, hashes },
});
/** A serveAttempts ledger from an explicit (clientId,hash)->count map. */
const attempts = (counts: Record<string, number>) => (clientId: number, hash: string) =>
  counts[`${clientId} ${hash}`] ?? 0;
const noAttempts = () => 0;

describe("decodeWantList", () => {
  it("accepts a well-formed want-list", () => {
    expect(decodeWantList({ v: 1, requestId: "r1", hashes: [H("a")] })).toEqual({
      v: 1,
      requestId: "r1",
      hashes: [H("a")],
    });
  });

  it("rejects malformed shapes (wrong version, missing requestId, non-array hashes)", () => {
    expect(decodeWantList(undefined)).toBeUndefined();
    expect(decodeWantList(null)).toBeUndefined();
    expect(decodeWantList({ v: 2, requestId: "r", hashes: [] })).toBeUndefined();
    expect(decodeWantList({ v: 1, hashes: [] })).toBeUndefined();
    expect(decodeWantList({ v: 1, requestId: "", hashes: [] })).toBeUndefined();
    expect(decodeWantList({ v: 1, requestId: "r", hashes: "nope" })).toBeUndefined();
  });

  it("drops non-64-hex entries and CAPS the list at the batch max (anti-flood decode)", () => {
    const many = Array.from({ length: BLOB_WANT_BATCH_MAX + 20 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );
    const decoded = decodeWantList({
      v: 1,
      requestId: "r",
      hashes: [...many, "not-a-hash", "AB".repeat(32) /* uppercase → invalid */, 42],
    });
    expect(decoded!.hashes).toHaveLength(BLOB_WANT_BATCH_MAX);
    expect(decoded!.hashes.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
  });
});

describe("planBlobDemand — requester (expect + advertise)", () => {
  it("expects + wants ONLY the referenced-and-MISSING hashes", () => {
    const plan = planBlobDemand({
      local: [ptr(H("a")), ptr(H("b")), ptr(H("c"))],
      has: inSet(H("b")), // b present; a + c missing
      requestId: "req-1",
    });
    expect(plan.toExpect.map((e) => e.hash).sort()).toEqual([H("a"), H("c")].sort());
    expect(plan.toExpect.find((e) => e.hash === H("a"))!.size).toBe(3); // size carried
    expect(plan.wantBatch).toHaveLength(1);
    expect(plan.wantBatch[0]).toEqual({ requestId: "req-1", hashes: [H("a"), H("c")] });
  });

  it("still demands a TOMBSTONED pointer's bytes (retained for restore)", () => {
    // A tombstoned pointer is still a {hash,size} in `local`; if its bytes are
    // missing the requester must still expect + want them.
    const tomb = H("d");
    const plan = planBlobDemand({
      local: [ptr(tomb)], // caller includes tombstoned pointers in the demand set
      has: inSet(), // bytes absent
      requestId: "req-1",
    });
    expect(plan.toExpect.map((e) => e.hash)).toEqual([tomb]);
    expect(plan.wantBatch[0]!.hashes).toEqual([tomb]);
  });

  it("produces NO want batch when nothing is missing (all present)", () => {
    const plan = planBlobDemand({
      local: [ptr(H("a")), ptr(H("b"))],
      has: inSet(H("a"), H("b")),
      requestId: "req-1",
    });
    expect(plan.toExpect).toEqual([]);
    expect(plan.wantBatch).toEqual([]);
  });

  it("dedupes local pointers by hash keeping the first-seen size", () => {
    const plan = planBlobDemand({
      local: [ptr(H("a"), 10), ptr(H("a"), 999)], // same hash twice
      has: inSet(),
      requestId: "req-1",
    });
    expect(plan.toExpect).toEqual([{ hash: H("a"), size: 10 }]);
  });

  it("drops non-64-hex local pointers (never demands a malformed hash)", () => {
    const plan = planBlobDemand({
      local: [ptr("not-a-hash"), ptr(H("a"))],
      has: inSet(),
      requestId: "req-1",
    });
    expect(plan.toExpect.map((e) => e.hash)).toEqual([H("a")]);
  });

  it("is DETERMINISTIC: missing hashes sorted + capped at 64 per batch, requestId suffixed", () => {
    const local = Array.from({ length: 70 }, (_, i) => ptr(i.toString(16).padStart(64, "0")));
    // Shuffle input order to prove the output is sorted regardless.
    const shuffled = [...local].reverse();
    const plan = planBlobDemand({ local: shuffled, has: inSet(), requestId: "base" });
    expect(plan.wantBatch).toHaveLength(2);
    expect(plan.wantBatch[0]!.hashes).toHaveLength(BLOB_WANT_BATCH_MAX);
    expect(plan.wantBatch[0]!.requestId).toBe("base");
    expect(plan.wantBatch[1]!.hashes).toHaveLength(70 - BLOB_WANT_BATCH_MAX);
    expect(plan.wantBatch[1]!.requestId).toBe("base-1"); // suffixed
    // The first batch is the sorted prefix.
    const sortedHashes = local.map((p) => p.hash).sort();
    expect(plan.wantBatch[0]!.hashes).toEqual(sortedHashes.slice(0, BLOB_WANT_BATCH_MAX));
    // The two batches partition the full missing set with no overlap.
    const all = [...plan.wantBatch[0]!.hashes, ...plan.wantBatch[1]!.hashes];
    expect(new Set(all).size).toBe(70);
  });
});

describe("planBlobServe — holder (servable-provenance authority ONLY)", () => {
  it("SECURITY: an injected snapshot/local/has field has ZERO serve authority (holder ignores demand state)", () => {
    // The holder shape has no snapshot/local/referenced/has input — authorization
    // is servableHeld ONLY. Even if a caller (or a regression toward the parked
    // snapshot-based holder rule) smuggles those fields in, they are inert: the
    // bytes here are held + referenced but were never GRANTED, so nothing is sent.
    // A regression that served "referenced (local) AND has" would send `secret`
    // and FAIL this test.
    const secret = H("5");
    const arg = {
      servableHeld: inSet(), // NO durable grant
      peerWants: [peer(7, "r7", [secret])],
      serveAttempts: noAttempts,
      // Hostile extras a snapshot-based holder rule would have consulted:
      local: [ptr(secret)],
      referenced: (_h: string) => true,
      has: (_h: string) => true,
    } as unknown as Parameters<typeof planBlobServe>[0];
    expect(planBlobServe(arg).toSend).toEqual([]);
  });

  it("SECURITY: a wanted + HELD but NOT-servable hash is NEVER sent (malicious-snapshot exfil closed)", () => {
    // The victim HOLDS the bytes for `secret` (e.g. a pending, pre-Accept import)
    // and a hostile peer wants it — but it was never granted a durable servable
    // marker, so it must not be disclosed. `servableHeld` is the ONLY authority.
    const secret = H("5");
    const held = inSet(secret); // bytes present locally…
    const servable = inSet(); // …but NO servable grant
    const plan = planBlobServe({
      // A regression to the old holder rule would consult "held"/"referenced";
      // servableHeld deliberately ignores mere possession.
      servableHeld: (h) => servable(h) && held(h),
      peerWants: [peer(7, "r7", [secret])],
      serveAttempts: noAttempts,
    });
    expect(plan.toSend).toEqual([]);
  });

  it("serves a hash iff servableHeld; carries (clientId, hash) with NO requestId", () => {
    const plan = planBlobServe({
      servableHeld: inSet(H("a")),
      peerWants: [peer(7, "r7", [H("a")])],
      serveAttempts: noAttempts,
    });
    expect(plan.toSend).toEqual([{ clientId: 7, hash: H("a") }]);
    // Structural: the send tuple has exactly clientId + hash (no requestId leaks in).
    expect(Object.keys(plan.toSend[0]!).sort()).toEqual(["clientId", "hash"]);
  });

  it("does NOT re-send once serveAttempts has reached the cap of 2", () => {
    const plan = planBlobServe({
      servableHeld: inSet(H("a")),
      peerWants: [peer(7, "r7", [H("a")])],
      serveAttempts: attempts({ [`7 ${H("a")}`]: 2 }), // already at cap
    });
    expect(plan.toSend).toEqual([]);
  });

  it("SECURITY: requestId ROTATION buys nothing — two wants with DIFFERENT requestIds still cap at 2 total", () => {
    const a = H("a");
    // A single planning call: the same (clientId,hash) under two different
    // requestIds collapses to ONE send (requestId is not a dedup key).
    const oneCall = planBlobServe({
      servableHeld: inSet(a),
      peerWants: [peer(7, "rA", [a]), peer(7, "rB", [a])], // rotated requestId
      serveAttempts: noAttempts,
    });
    expect(oneCall.toSend).toEqual([{ clientId: 7, hash: a }]);

    // Across calls: once the session records 2 attempts for (7,a), any further
    // want — no matter how many fresh requestIds — is refused. Total sends stay 2.
    const afterTwo = planBlobServe({
      servableHeld: inSet(a),
      peerWants: [peer(7, "rC", [a]), peer(7, "rD", [a]), peer(7, "rE", [a])],
      serveAttempts: attempts({ [`7 ${a}`]: 2 }),
    });
    expect(afterTwo.toSend).toEqual([]);
  });

  it("dedupes the SAME (clientId,hash) within one plan regardless of requestId", () => {
    const plan = planBlobServe({
      servableHeld: inSet(H("a")),
      peerWants: [peer(7, "r7", [H("a")]), peer(7, "r7", [H("a")])],
      serveAttempts: noAttempts,
    });
    expect(plan.toSend).toHaveLength(1);
  });

  it("ignores a structurally-invalid want-list WHOLESALE (malformed peer entry dropped)", () => {
    const plan = planBlobServe({
      servableHeld: inSet(H("a")),
      peerWants: [
        { clientId: 1, wants: { v: 2, requestId: "bad", hashes: [H("a")] } as never },
        peer(2, "ok", [H("a")]),
      ],
      serveAttempts: noAttempts,
    });
    expect(plan.toSend).toEqual([{ clientId: 2, hash: H("a") }]);
  });

  it("drops a non-64-hex wanted hash before serve authorization (decode gate)", () => {
    // A malformed hash inside an otherwise-valid want-list is filtered by decode,
    // so it can never be served even if some predicate mistakenly returned true.
    const plan = planBlobServe({
      servableHeld: () => true, // permissive on purpose
      peerWants: [{ clientId: 3, wants: { v: 1, requestId: "r", hashes: ["not-a-hash"] } }],
      serveAttempts: noAttempts,
    });
    expect(plan.toSend).toEqual([]);
  });

  it("serves DIFFERENT requesters of the same servable hash independently", () => {
    const plan = planBlobServe({
      servableHeld: inSet(H("a")),
      peerWants: [peer(1, "r1", [H("a")]), peer(2, "r2", [H("a")])],
      serveAttempts: noAttempts,
    });
    expect(plan.toSend).toEqual([
      { clientId: 1, hash: H("a") },
      { clientId: 2, hash: H("a") },
    ]);
  });

  it("per-(clientId,hash) cap is INDEPENDENT across clients and hashes", () => {
    // (7,a) is capped; (7,b) and (8,a) are fresh — only the capped pair is withheld.
    const plan = planBlobServe({
      servableHeld: inSet(H("a"), H("b")),
      peerWants: [peer(7, "r", [H("a"), H("b")]), peer(8, "r", [H("a")])],
      serveAttempts: attempts({ [`7 ${H("a")}`]: 2 }),
    });
    expect(plan.toSend).toEqual([
      { clientId: 7, hash: H("b") },
      { clientId: 8, hash: H("a") },
    ]);
  });
});

describe("constants", () => {
  it("exposes the awareness field name + batch cap", () => {
    expect(BLOB_WANTS_FIELD).toBe("galleyBlobWants");
    expect(BLOB_WANT_BATCH_MAX).toBe(64);
  });
});
