/**
 * Capability-room registration/revocation policy (#1 slice 2). Drives the
 * framework-agnostic core against an in-memory store, pinning the frozen
 * contract: namespace-gated validation, idempotent re-registration, tombstoned
 * revocation with NO resurrection (tombstones are NEVER collected), creator-
 * only revoke with no ownership oracle, the 128/8 per-user caps (including the
 * HIGH-2 concurrency property: parallel registrations cannot over-shoot),
 * session-bounded control expiry, and the registration-time GC of expired
 * control records (with the M4 re-read-under-lock race guard).
 */
import { describe, it, expect } from "vitest";
import type { CapabilityRoomRecord, CapabilityRoomStore } from "@galley/shared";
import { isCapabilityRoomId } from "@galley/shared";
import {
  registerCapabilityRoom,
  revokeCapabilityRoom,
  MAX_ACTIVE_CAPABILITY_ROOMS_PER_USER,
  MAX_ACTIVE_CONTROL_ROOMS_PER_USER,
  TOMBSTONE_CAP_PER_USER,
} from "./capability-rooms.js";
import { authorizeCapabilityRoomUpgrade } from "./upgrade.js";

const NOW = 1_700_000_000_000;
const SESSION_EXP = NOW + 8 * 60 * 60 * 1000;
const ROOM = "share-0123456789abcdef0123456789abcdef";

class MemStore implements CapabilityRoomStore {
  readonly map = new Map<string, CapabilityRoomRecord>();
  async get(roomId: string): Promise<CapabilityRoomRecord | null> {
    if (!isCapabilityRoomId(roomId)) return null;
    return this.map.get(roomId) ?? null;
  }
  async put(record: CapabilityRoomRecord): Promise<void> {
    if (!isCapabilityRoomId(record.roomId)) throw new Error("invalid roomId");
    this.map.set(record.roomId, record);
  }
  async list(): Promise<CapabilityRoomRecord[]> {
    return [...this.map.values()];
  }
  async remove(roomId: string): Promise<void> {
    this.map.delete(roomId);
  }
}

const register = (
  store: CapabilityRoomStore,
  body: unknown,
  over: Partial<{
    userId: string;
    sessionExpiresAtMs: number;
    nowMs: number;
  }> = {},
) =>
  registerCapabilityRoom(store, {
    body,
    userId: over.userId ?? "alice",
    sessionExpiresAtMs: over.sessionExpiresAtMs ?? SESSION_EXP,
    nowMs: over.nowMs ?? NOW,
  });

describe("registerCapabilityRoom — validation", () => {
  it.each([
    ["not an object", "share-room"],
    ["null", null],
    ["array", [ROOM]],
    ["missing roomId", { kind: "share" }],
    ["non-namespace roomId", { roomId: "my-project", kind: "share" }],
    [
      "traversal roomId",
      { roomId: "share-../../../etc/passwd", kind: "share" },
    ],
    ["unknown kind", { roomId: ROOM, kind: "admin" }],
    ["missing kind", { roomId: ROOM }],
    ["non-string projectId", { roomId: ROOM, kind: "share", projectId: 42 }],
    [
      "oversized projectId",
      { roomId: ROOM, kind: "share", projectId: "p".repeat(257) },
    ],
    [
      "control chars in projectId",
      { roomId: ROOM, kind: "share", projectId: "a\nb" },
    ],
  ])("rejects %s with the constant invalid shape", async (_name, body) => {
    const store = new MemStore();
    const res = await register(store, body);
    expect(res).toEqual({ status: 400, body: { ok: false, code: "invalid" } });
    expect(store.map.size).toBe(0); // nothing written
  });

  it("registers a share room: no default expiry, creator + timestamps server-derived", async () => {
    const store = new MemStore();
    const res = await register(store, {
      roomId: ROOM,
      kind: "share",
      projectId: "proj-1",
    });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(store.map.get(ROOM)).toEqual({
      version: 1,
      roomId: ROOM,
      kind: "share",
      createdBy: "alice",
      createdAtMs: NOW,
      projectId: "proj-1",
    });
  });

  it("registers a control room with expiry = THE SESSION'S expiry", async () => {
    const store = new MemStore();
    await register(store, { roomId: ROOM, kind: "control" });
    expect(store.map.get(ROOM)?.expiresAtMs).toBe(SESSION_EXP);
  });
});

describe("registerCapabilityRoom — idempotency, conflicts, resurrection", () => {
  it("re-POST of the same active registration (same user+kind) is idempotent", async () => {
    const store = new MemStore();
    await register(store, { roomId: ROOM, kind: "share" });
    const first = store.map.get(ROOM);
    const res = await register(
      store,
      { roomId: ROOM, kind: "share" },
      { nowMs: NOW + 60_000 },
    );
    expect(res.status).toBe(200);
    expect(store.map.get(ROOM)).toEqual(first); // unchanged, not rewritten
  });

  it("an ACTIVE room cannot be claimed by another user, nor re-typed to another kind", async () => {
    const store = new MemStore();
    await register(store, { roomId: ROOM, kind: "share" });
    const otherUser = await register(
      store,
      { roomId: ROOM, kind: "share" },
      { userId: "mallory" },
    );
    expect(otherUser).toEqual({
      status: 403,
      body: { ok: false, code: "forbidden" },
    });
    const otherKind = await register(store, { roomId: ROOM, kind: "control" });
    expect(otherKind).toEqual({
      status: 403,
      body: { ok: false, code: "forbidden" },
    });
    expect(store.map.get(ROOM)?.kind).toBe("share"); // untouched
  });

  it("a REVOKED roomId can NEVER be re-registered — not even by its creator", async () => {
    const store = new MemStore();
    await register(store, { roomId: ROOM, kind: "share" });
    await revokeCapabilityRoom(store, {
      roomId: ROOM,
      userId: "alice",
      nowMs: NOW + 1,
    });
    const again = await register(
      store,
      { roomId: ROOM, kind: "share" },
      { nowMs: NOW + 2 },
    );
    expect(again).toEqual({
      status: 403,
      body: { ok: false, code: "forbidden" },
    });
    const byOther = await register(
      store,
      { roomId: ROOM, kind: "share" },
      { userId: "bob", nowMs: NOW + 2 },
    );
    expect(byOther).toEqual({
      status: 403,
      body: { ok: false, code: "forbidden" },
    });
    expect(store.map.get(ROOM)?.revokedAtMs).toBe(NOW + 1); // tombstone intact
  });

  it("an EXPIRED control room can be re-registered by its creator with a fresh expiry", async () => {
    const store = new MemStore();
    await register(store, { roomId: ROOM, kind: "control" });
    const later = SESSION_EXP + 1; // the original session lapsed
    const res = await register(
      store,
      { roomId: ROOM, kind: "control" },
      { nowMs: later, sessionExpiresAtMs: later + 1000 },
    );
    expect(res.status).toBe(200);
    expect(store.map.get(ROOM)?.expiresAtMs).toBe(later + 1000);
  });
});

describe("registerCapabilityRoom — per-user caps", () => {
  const roomN = (n: number) => `share-${String(n).padStart(32, "0")}`;

  it(`caps ACTIVE rooms at ${MAX_ACTIVE_CAPABILITY_ROOMS_PER_USER} per user (others unaffected)`, async () => {
    const store = new MemStore();
    for (let i = 0; i < MAX_ACTIVE_CAPABILITY_ROOMS_PER_USER; i++) {
      const res = await register(store, { roomId: roomN(i), kind: "share" });
      expect(res.status).toBe(200);
    }
    const over = await register(store, { roomId: roomN(999), kind: "share" });
    expect(over).toEqual({
      status: 409,
      body: { ok: false, code: "cap-exceeded" },
    });
    // A DIFFERENT user is not affected by alice's cap.
    const bob = await register(
      store,
      { roomId: roomN(1000), kind: "share" },
      { userId: "bob" },
    );
    expect(bob.status).toBe(200);
    // Idempotent re-POST of an EXISTING room still succeeds at the cap.
    const idem = await register(store, { roomId: roomN(0), kind: "share" });
    expect(idem.status).toBe(200);
  });

  it(`caps ACTIVE control rooms at ${MAX_ACTIVE_CONTROL_ROOMS_PER_USER} per user`, async () => {
    const store = new MemStore();
    for (let i = 0; i < MAX_ACTIVE_CONTROL_ROOMS_PER_USER; i++) {
      const res = await register(store, { roomId: roomN(i), kind: "control" });
      expect(res.status).toBe(200);
    }
    const over = await register(store, { roomId: roomN(99), kind: "control" });
    expect(over).toEqual({
      status: 409,
      body: { ok: false, code: "cap-exceeded" },
    });
    // Share rooms are NOT blocked by the control cap.
    const share = await register(store, { roomId: roomN(98), kind: "share" });
    expect(share.status).toBe(200);
  });

  it("revoked/expired rooms do not count against the caps", async () => {
    const store = new MemStore();
    for (let i = 0; i < MAX_ACTIVE_CONTROL_ROOMS_PER_USER; i++) {
      await register(store, { roomId: roomN(i), kind: "control" });
    }
    await revokeCapabilityRoom(store, {
      roomId: roomN(0),
      userId: "alice",
      nowMs: NOW + 1,
    });
    const res = await register(
      store,
      { roomId: roomN(50), kind: "control" },
      { nowMs: NOW + 2 },
    );
    expect(res.status).toBe(200);
  });
});

describe("registerCapabilityRoom — registration-time GC", () => {
  it("drops EXPIRED control records; tombstones — even ANCIENT ones — are NEVER collected", async () => {
    const store = new MemStore();
    const expiredControl = "share-expiredcontrol0000000000000000";
    const liveShare = "share-liveshare0000000000000000000000";
    const ancientTombstone = "share-oldtombstone000000000000000000";
    const freshTombstone = "share-freshtombstone0000000000000000";
    store.map.set(expiredControl, {
      version: 1,
      roomId: expiredControl,
      kind: "control",
      createdBy: "x",
      createdAtMs: 0,
      expiresAtMs: NOW - 1,
    });
    store.map.set(liveShare, {
      version: 1,
      roomId: liveShare,
      kind: "share",
      createdBy: "x",
      createdAtMs: 0,
    });
    store.map.set(ancientTombstone, {
      version: 1,
      roomId: ancientTombstone,
      kind: "share",
      createdBy: "x",
      createdAtMs: 0,
      revokedAtMs: 1, // revoked ~forever ago — still kept (no resurrection, EVER)
      revokedBy: "x",
    });
    store.map.set(freshTombstone, {
      version: 1,
      roomId: freshTombstone,
      kind: "share",
      createdBy: "x",
      createdAtMs: 0,
      revokedAtMs: NOW - 1,
      revokedBy: "x",
    });
    await register(store, { roomId: ROOM, kind: "share" });
    expect([...store.map.keys()].sort()).toEqual(
      [liveShare, ancientTombstone, freshTombstone, ROOM].sort(),
    );
    // And the ancient tombstone still rejects resurrection — by its creator too.
    const res = await register(store, { roomId: ancientTombstone, kind: "share" }, { userId: "x" });
    expect(res).toEqual({ status: 403, body: { ok: false, code: "forbidden" } });
  });

  it("M4: GC re-reads under the room lock — a record that is ACTIVE again is NOT removed", async () => {
    // The stale-snapshot race: list() returns an EXPIRED control record, but by
    // the time GC re-reads it, a concurrent re-registration refreshed it
    // (ACTIVE). The fixed GC must keep it. Simulated with a store whose list()
    // serves the stale snapshot while get() serves the fresh record.
    const fresh = "share-freshlyrenewed0000000000000000";
    const store = new MemStore();
    store.map.set(fresh, {
      version: 1,
      roomId: fresh,
      kind: "control",
      createdBy: "bob",
      createdAtMs: NOW - 1,
      expiresAtMs: NOW + 60_000, // ACTIVE — what get() (the re-read) sees
    });
    const stale: CapabilityRoomRecord = {
      version: 1,
      roomId: fresh,
      kind: "control",
      createdBy: "bob",
      createdAtMs: 0,
      expiresAtMs: NOW - 1, // EXPIRED — what the GC's list() snapshot saw
    };
    const racing: CapabilityRoomStore = {
      get: (id) => store.get(id),
      put: (r) => store.put(r),
      remove: (id) => store.remove(id),
      list: async () => [stale],
    };
    await register(racing, { roomId: ROOM, kind: "share" });
    expect(store.map.has(fresh)).toBe(true); // survived the sweep
  });
});

describe("registerCapabilityRoom — cap concurrency (HIGH-2)", () => {
  const room9 = (n: number) => `share-${String(n).padStart(32, "9")}`;

  it("N PARALLEL registrations at cap-1 → exactly ONE wins (no TOCTOU over-shoot)", async () => {
    const store = new MemStore();
    for (let i = 0; i < MAX_ACTIVE_CONTROL_ROOMS_PER_USER - 1; i++) {
      expect((await register(store, { roomId: room9(i), kind: "control" })).status).toBe(200);
    }
    // One slot left; fire 5 registrations for DISTINCT new rooms at once.
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        register(store, { roomId: room9(100 + i), kind: "control" }),
      ),
    );
    const okCount = results.filter((r) => r.status === 200).length;
    const capCount = results.filter(
      (r) => r.status === 409 && !r.body.ok && r.body.code === "cap-exceeded",
    ).length;
    expect(okCount).toBe(1); // the single free slot
    expect(capCount).toBe(4);
    const activeControl = [...store.map.values()].filter(
      (r) => r.kind === "control" && r.revokedAtMs === undefined,
    );
    expect(activeControl.length).toBe(MAX_ACTIVE_CONTROL_ROOMS_PER_USER); // never over cap
  });

  it("parallel registrations by DIFFERENT users all succeed (per-user locks don't cross-block)", async () => {
    const store = new MemStore();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        register(store, { roomId: room9(200 + i), kind: "share" }, { userId: `user-${i}` }),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});

describe("revokeCapabilityRoom", () => {
  it("creator revoke tombstones the record (kept, marked) and is idempotent", async () => {
    const store = new MemStore();
    await register(store, { roomId: ROOM, kind: "share" });
    const res = await revokeCapabilityRoom(store, {
      roomId: ROOM,
      userId: "alice",
      nowMs: NOW + 5,
    });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(store.map.get(ROOM)).toMatchObject({
      revokedAtMs: NOW + 5,
      revokedBy: "alice",
    });
    const again = await revokeCapabilityRoom(store, {
      roomId: ROOM,
      userId: "alice",
      nowMs: NOW + 9,
    });
    expect(again.status).toBe(200);
    expect(store.map.get(ROOM)?.revokedAtMs).toBe(NOW + 5); // first tombstone wins
  });

  it("unknown room and not-the-creator answer IDENTICALLY (no ownership oracle)", async () => {
    const store = new MemStore();
    await register(store, { roomId: ROOM, kind: "share" });
    const unknown = await revokeCapabilityRoom(store, {
      roomId: "share-doesnotexist000000000000000000",
      userId: "alice",
      nowMs: NOW,
    });
    const notMine = await revokeCapabilityRoom(store, {
      roomId: ROOM,
      userId: "mallory",
      nowMs: NOW,
    });
    expect(unknown).toEqual(notMine);
    expect(unknown).toEqual({
      status: 404,
      body: { ok: false, code: "unknown" },
    });
    expect(store.map.get(ROOM)?.revokedAtMs).toBeUndefined(); // untouched
    const invalid = await revokeCapabilityRoom(store, {
      roomId: "../../x",
      userId: "alice",
      nowMs: NOW,
    });
    expect(invalid).toEqual(unknown); // invalid ids share the same constant shape
  });
});

describe("revokeCapabilityRoom — tombstone retention cap (verification round)", () => {
  const roomT = (n: number) => `share-t${String(n).padStart(31, "0")}`;

  it("stays untouched at or under the cap (no prune, nothing lost)", async () => {
    const store = new MemStore();
    for (let i = 0; i < 3; i++) {
      await register(store, { roomId: roomT(i), kind: "share" }, { nowMs: NOW + i });
      await revokeCapabilityRoom(store, { roomId: roomT(i), userId: "alice", nowMs: NOW + i });
    }
    expect([...store.map.values()].filter((r) => r.revokedAtMs !== undefined)).toHaveLength(3);
  });

  it("the cap+1-th revoke FIFO-prunes exactly the oldest; recent tombstones stay protected; other users untouched", async () => {
    const store = new MemStore();
    // Bob's single tombstone is the OLDEST of all — alice's churn must not touch it.
    const bobRoom = "share-bobsroom0000000000000000000000";
    await register(store, { roomId: bobRoom, kind: "share" }, { userId: "bob", nowMs: NOW - 10 });
    await revokeCapabilityRoom(store, { roomId: bobRoom, userId: "bob", nowMs: NOW - 10 });

    // Alice register→revokes cap+1 fresh rooms with strictly increasing clocks
    // (the disk-exhaustion loop the cap exists to bound).
    for (let i = 0; i <= TOMBSTONE_CAP_PER_USER; i++) {
      await register(store, { roomId: roomT(i), kind: "share" }, { nowMs: NOW + i });
      await revokeCapabilityRoom(store, { roomId: roomT(i), userId: "alice", nowMs: NOW + i });
    }

    const aliceTombs = [...store.map.values()].filter(
      (r) => r.createdBy === "alice" && r.revokedAtMs !== undefined,
    );
    expect(aliceTombs).toHaveLength(TOMBSTONE_CAP_PER_USER); // bounded
    expect(store.map.has(roomT(0))).toBe(false); // EXACTLY the oldest pruned…
    expect(store.map.has(roomT(1))).toBe(true); // …and nothing newer
    expect(store.map.has(roomT(TOMBSTONE_CAP_PER_USER))).toBe(true);
    expect(store.map.has(bobRoom)).toBe(true); // per-user isolation

    // Every RETAINED tombstone still rejects resurrection…
    const recent = await register(store, { roomId: roomT(1), kind: "share" }, { nowMs: NOW + 99_999 });
    expect(recent).toEqual({ status: 403, body: { ok: false, code: "forbidden" } });
    // …while the pruned id is deliberately re-claimable — only via an
    // authenticated registration of that exact leaked id (the documented,
    // bounded trade-off for a bounded disk).
    const reclaimed = await register(store, { roomId: roomT(0), kind: "share" }, { nowMs: NOW + 99_999 });
    expect(reclaimed.status).toBe(200);
  }, 30_000);
});

describe("authorizeCapabilityRoomUpgrade — the relay's capability gate", () => {
  it("admits ONLY an active registered capability room; everything else fails closed", async () => {
    const store = new MemStore();
    await register(store, { roomId: ROOM, kind: "share" });
    const gate = (room: string, nowMs = NOW + 1) =>
      authorizeCapabilityRoomUpgrade({ room, registry: store, nowMs });
    expect(await gate(ROOM)).toBe(true);
    expect(await gate("share-unregistered000000000000000000")).toBe(false);
    expect(await gate("not-a-capability-room")).toBe(false);
    await revokeCapabilityRoom(store, {
      roomId: ROOM,
      userId: "alice",
      nowMs: NOW + 2,
    });
    expect(await gate(ROOM, NOW + 3)).toBe(false); // revoked → future joins denied
  });

  it("denies an expired control room and fails closed on a registry error", async () => {
    const store = new MemStore();
    await register(store, { roomId: ROOM, kind: "control" });
    expect(
      await authorizeCapabilityRoomUpgrade({
        room: ROOM,
        registry: store,
        nowMs: NOW + 1,
      }),
    ).toBe(true);
    expect(
      await authorizeCapabilityRoomUpgrade({
        room: ROOM,
        registry: store,
        nowMs: SESSION_EXP,
      }),
    ).toBe(false); // session expiry boundary = expired
    const broken: CapabilityRoomStore = {
      get: async () => {
        throw new Error("disk gone");
      },
      put: async () => undefined,
      list: async () => [],
      remove: async () => undefined,
    };
    expect(
      await authorizeCapabilityRoomUpgrade({
        room: ROOM,
        registry: broken,
        nowMs: NOW,
      }),
    ).toBe(false);
  });
});
