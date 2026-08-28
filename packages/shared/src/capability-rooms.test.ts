/**
 * Capability-room namespace + active-record predicates (#1 slice 2). These two
 * functions are the load-bearing security primitives of the whole feature: the
 * namespace validator doubles as the registry-filename traversal gate, and the
 * active predicate is the relay's admit/deny decision — so both are pinned
 * adversarially here.
 */
import { describe, it, expect } from "vitest";
import {
  isCapabilityRoomId,
  isActiveCapabilityRoom,
  CAPABILITY_ROOM_PREFIX,
  type CapabilityRoomRecord,
} from "./capability-rooms.js";

const NOW = 1_000_000;

function record(
  over: Partial<CapabilityRoomRecord> = {},
): CapabilityRoomRecord {
  return {
    version: 1,
    roomId: "share-0123456789abcdef0123456789abcdef",
    kind: "share",
    createdBy: "user-1",
    createdAtMs: NOW - 10,
    ...over,
  };
}

describe("isCapabilityRoomId — the namespace / filename gate", () => {
  it("accepts both shapes mintShareRoom produces (uuid and 32-hex bodies)", () => {
    expect(
      isCapabilityRoomId("share-1c0e8b9a-3f63-4b9e-8a59-1f2d3c4b5a69"),
    ).toBe(true);
    expect(isCapabilityRoomId("share-0123456789abcdef0123456789abcdef")).toBe(
      true,
    );
    expect(
      isCapabilityRoomId(`${CAPABILITY_ROOM_PREFIX}A_b-C0123456789xyz`),
    ).toBe(true);
  });

  it("rejects non-strings and the empty/prefix-only cases", () => {
    for (const v of [null, undefined, 42, {}, [], "", "share-", "share"]) {
      expect(isCapabilityRoomId(v)).toBe(false);
    }
  });

  it("rejects ids outside the reserved namespace (ordinary project rooms)", () => {
    expect(isCapabilityRoomId("default")).toBe(false);
    expect(isCapabilityRoomId("proj-0123456789abcdef")).toBe(false);
    expect(isCapabilityRoomId("SHARE-0123456789abcdef")).toBe(false); // case-sensitive
    expect(isCapabilityRoomId(" share-0123456789abcdef")).toBe(false);
  });

  it("rejects every path-traversal ingredient (the id becomes a filename)", () => {
    for (const hostile of [
      "share-../../etc/passwd00",
      "share-..%2f..%2fetc%2fpasswd",
      "share-aaaa/../../bbbbbbbbbb",
      "share-aaaaaaaaaaaaaaaa/..",
      "share-aaaaaaaa\\..\\bbbbbb",
      "share-aaaaaaaaaaaaaaaa\u0000",
      "share-aaaaaaaaaaaaaaaa.json",
      "share-aaaaaaaaaaaaaaaa.",
      "share-aaaa%2e%2e%2fbbbbbb",
    ]) {
      expect(isCapabilityRoomId(hostile)).toBe(false);
    }
  });

  it("bounds the body length (16–64) so a filename can never be unbounded", () => {
    expect(isCapabilityRoomId(`share-${"a".repeat(15)}`)).toBe(false);
    expect(isCapabilityRoomId(`share-${"a".repeat(16)}`)).toBe(true);
    expect(isCapabilityRoomId(`share-${"a".repeat(64)}`)).toBe(true);
    expect(isCapabilityRoomId(`share-${"a".repeat(65)}`)).toBe(false);
    expect(isCapabilityRoomId(`share-${"a".repeat(10_000)}`)).toBe(false);
  });
});

describe("isActiveCapabilityRoom — the admit/deny predicate", () => {
  it("a well-formed, unrevoked, unexpired record is active", () => {
    expect(isActiveCapabilityRoom(record(), NOW)).toBe(true);
    expect(
      isActiveCapabilityRoom(
        record({ kind: "control", expiresAtMs: NOW + 1 }),
        NOW,
      ),
    ).toBe(true);
  });

  it("a revoked record (tombstone) is NEVER active", () => {
    expect(
      isActiveCapabilityRoom(
        record({ revokedAtMs: NOW - 1, revokedBy: "user-1" }),
        NOW,
      ),
    ).toBe(false);
    // Even a "future" revocation timestamp counts as revoked — the marker is the fact.
    expect(
      isActiveCapabilityRoom(record({ revokedAtMs: NOW + 999 }), NOW),
    ).toBe(false);
  });

  it("an expired record is not active (boundary: expiry == now is expired)", () => {
    expect(isActiveCapabilityRoom(record({ expiresAtMs: NOW }), NOW)).toBe(
      false,
    );
    expect(isActiveCapabilityRoom(record({ expiresAtMs: NOW - 1 }), NOW)).toBe(
      false,
    );
    expect(isActiveCapabilityRoom(record({ expiresAtMs: NOW + 1 }), NOW)).toBe(
      true,
    );
  });

  it("fails closed on malformed records (a garbage file must authorize nothing)", () => {
    const r = record;
    expect(isActiveCapabilityRoom(r({ version: 2 as unknown as 1 }), NOW)).toBe(
      false,
    );
    expect(
      isActiveCapabilityRoom(r({ roomId: "not-a-capability-room" }), NOW),
    ).toBe(false);
    expect(
      isActiveCapabilityRoom(r({ kind: "admin" as unknown as "share" }), NOW),
    ).toBe(false);
    expect(isActiveCapabilityRoom(r({ createdBy: "" }), NOW)).toBe(false);
    expect(
      isActiveCapabilityRoom(r({ createdBy: 7 as unknown as string }), NOW),
    ).toBe(false);
    expect(isActiveCapabilityRoom(r({ createdAtMs: Number.NaN }), NOW)).toBe(
      false,
    );
    expect(
      isActiveCapabilityRoom(r({ createdAtMs: "x" as unknown as number }), NOW),
    ).toBe(false);
    // A NON-NUMERIC expiry must read as "malformed → inactive", never "no expiry".
    expect(
      isActiveCapabilityRoom(
        r({ expiresAtMs: "never" as unknown as number }),
        NOW,
      ),
    ).toBe(false);
    expect(isActiveCapabilityRoom(r({ expiresAtMs: Number.NaN }), NOW)).toBe(
      false,
    );
  });
});
