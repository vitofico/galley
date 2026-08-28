/**
 * B2 (cloud enabler) — relay per-room storage counters + caps. With a
 * `storageQuota` configured, the relay gates GROWTH writes on PERSISTED rooms:
 *
 *   - a write that would push a room past its per-room content cap (or the flat
 *     raw-log hard ceiling) is refused BEFORE apply — the in-memory doc is
 *     unchanged, nothing is appended/rebroadcast, and a typed `messageStorageFull`
 *     frame is sent while the socket STAYS OPEN (reads + other peers keep flowing);
 *   - delete-only updates ALWAYS admit (a user is never locked out of shrinking
 *     their own doc);
 *   - the content bound is a cheap per-append upper estimate, reconciled to the
 *     exact `Y.encodeStateAsUpdate` size only when it crosses a cap or the
 *     compaction high-water fires (never per frame);
 *   - a getCaps rejection fails CLOSED for growth with a DISTINCT reason (3,
 *     quota-unavailable) — never "you are out of storage".
 *
 * Without a `storageQuota` the relay does ZERO accounting and is byte-for-byte the
 * previous behavior (the existing sync-server suites are the real default-OFF
 * guard; test 1 here pins the accounting stays inert).
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket as WS } from "ws";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import type { Author, CrdtStore } from "@galley/shared";
import {
  CollabDocument,
  CollabConnection,
  WebSocketTransport,
  restoreDoc,
  type WebSocketLike,
} from "@galley/collab";
import { FsCrdtStore } from "@galley/persistence";
import {
  startSyncServer,
  messageStorageFull,
  StorageFullReason,
  type StorageQuota,
  type SyncServerHandle,
} from "./index.js";

const HUMAN: Author = { kind: "human", userId: "u1" };
const settle = { timeout: 4000, interval: 20 };

/** A CollabConnection wired to the server over a real ws socket. */
function client(handle: SyncServerHandle, room: string, doc: CollabDocument) {
  const url = `ws://127.0.0.1:${handle.port}/${room}`;
  const transport = new WebSocketTransport(() => new WS(url) as unknown as WebSocketLike);
  return new CollabConnection(doc, transport, { author: HUMAN });
}

/**
 * A raw socket that classifies inbound frames: `storageFull[]` collects decoded
 * `messageStorageFull` control frames; `gotFirst` resolves on the first NON
 * storage-full frame (the server's initial syncStep1 — which is only sent AFTER
 * the server has attached its message listener, so awaiting it makes a subsequent
 * send race-free).
 */
async function openRaw(handle: SyncServerHandle, room: string) {
  const ws = new WS(`ws://127.0.0.1:${handle.port}/${room}`);
  ws.binaryType = "arraybuffer";
  const storageFull: Array<{ reason: number; cap: number }> = [];
  let syncFrames = 0;
  let resolveFirst!: () => void;
  const gotFirst = new Promise<void>((r) => (resolveFirst = r));
  ws.on("message", (data: ArrayBuffer) => {
    const u = new Uint8Array(data);
    const dec = decoding.createDecoder(u);
    let type: number;
    try {
      type = decoding.readVarUint(dec);
    } catch {
      return;
    }
    if (type === messageStorageFull) {
      storageFull.push({ reason: decoding.readVarUint(dec), cap: decoding.readVarUint(dec) });
    } else {
      syncFrames++;
      resolveFirst();
    }
  });
  await new Promise<void>((res, rej) => {
    ws.on("open", () => res());
    ws.on("error", rej);
  });
  ws.removeAllListeners("error");
  ws.on("error", () => {
    /* a server-forced close on a hostile frame surfaces here; the test asserts state */
  });
  return {
    ws,
    storageFull,
    gotFirst,
    syncFrames: () => syncFrames,
    send: (frame: Uint8Array) => ws.send(frame),
    close: () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/** A messageSync Update (subtype 2) frame carrying `update`. */
function syncUpdateFrame(update: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0); // messageSync
  encoding.writeVarUint(enc, 2); // syncUpdate
  encoding.writeVarUint8Array(enc, update);
  return encoding.toUint8Array(enc);
}

/** A messageSync SyncStep1 (subtype 0) frame — a state-vector READ request. */
function syncStep1Frame(doc: Y.Doc): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0); // messageSync
  syncProtocol.writeSyncStep1(enc, doc); // subtype 0 + state vector
  return encoding.toUint8Array(enc);
}

/** A sync Update frame whose declared payload length LIES (>> the actual bytes). */
function lyingLengthFrame(declaredLen: number): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0); // messageSync
  encoding.writeVarUint(enc, 2); // syncUpdate
  encoding.writeVarUint(enc, declaredLen); // lie: far more than follows
  encoding.writeUint8(enc, 1);
  encoding.writeUint8(enc, 2);
  return encoding.toUint8Array(enc);
}

/** A self-contained update (fresh clientID) inserting `chars` into `source`. */
function freshUpdate(chars: number, fill = "a"): Uint8Array {
  const d = new Y.Doc();
  d.getText("source").insert(0, fill.repeat(chars));
  const u = Y.encodeStateAsUpdate(d);
  d.destroy();
  return u;
}

/** Capture the single update a doc emits for `mutate` (for crafting deletes). */
function capture(doc: Y.Doc, mutate: () => void): Uint8Array {
  let out: Uint8Array | undefined;
  const h = (u: Uint8Array): void => {
    out = u;
  };
  doc.on("update", h);
  mutate();
  doc.off("update", h);
  if (out === undefined) throw new Error("no update captured");
  return out;
}

interface FakeStore extends CrdtStore {
  appends: Uint8Array[];
  compacts: () => number;
}

/** An in-memory CrdtStore with observable append/compact counters. */
function makeStore(load: Uint8Array[] = []): FakeStore {
  const appends: Uint8Array[] = [];
  let compacts = 0;
  return {
    appends,
    compacts: () => compacts,
    async loadUpdates() {
      return load.map((u) => new Uint8Array(u));
    },
    async appendUpdate(_id, u) {
      appends.push(new Uint8Array(u));
    },
    async compact() {
      compacts++;
    },
  };
}

/** A store snapshot whose encoded size is ~`chars` bytes (for seeding over cap). */
function seedSnapshot(chars: number, fill = "s"): Uint8Array {
  const d = new Y.Doc();
  d.getText("source").insert(0, fill.repeat(chars));
  const u = Y.encodeStateAsUpdate(d);
  d.destroy();
  return u;
}

/** A StorageQuota with a fixed flat cap and an observable getCaps call count. */
function makeQuota(opts: {
  maxContentBytes?: number;
  maxLogBytes?: number;
  compactionFloorBytes?: number;
}): StorageQuota & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    ...(opts.maxLogBytes !== undefined ? { maxLogBytes: opts.maxLogBytes } : {}),
    ...(opts.compactionFloorBytes !== undefined
      ? { compactionFloorBytes: opts.compactionFloorBytes }
      : {}),
    async getCaps() {
      calls++;
      return opts.maxContentBytes !== undefined ? { maxContentBytes: opts.maxContentBytes } : {};
    },
  };
}

describe("sync server — storage caps (B2)", () => {
  // ── 1. Default-OFF: no storageQuota ⇒ no accounting, no peek effects ──────────
  it("without a storageQuota the relay does no accounting and applies writes unchanged", async () => {
    const store = makeStore();
    const server = await startSyncServer(0, { crdtStore: store }); // NO storageQuota
    try {
      const w = await openRaw(server, "off-room");
      await w.gotFirst;
      w.send(syncUpdateFrame(freshUpdate(500)));
      await vi.waitFor(() => expect(store.appends.length).toBe(1), settle);
      // Accounting is inert: the counters were never touched.
      expect(server.roomLogBytes("off-room")).toBe(0);
      expect(server.roomContentBytes("off-room")).toBe(0);
      // No storage-full frame is ever sent when no quota is configured.
      expect(w.storageFull).toHaveLength(0);
      w.close();
    } finally {
      await server.close();
    }
  });

  // ── 2. Over-cap growth-write: refused BEFORE apply; socket stays open; reads ok ─
  it("refuses an over-cap growth write before applying it and keeps the socket open", async () => {
    // Seed the store with content already over the cap; the room loads over cap.
    const seed = seedSnapshot(6000);
    const store = makeStore([seed]);
    const quota = makeQuota({ maxContentBytes: 3000 });
    const server = await startSyncServer(0, { crdtStore: store, storageQuota: quota });
    try {
      const w = await openRaw(server, "cap-room");
      await w.gotFirst;
      const contentBefore = server.roomContentBytes("cap-room");
      const appendsBefore = store.appends.length;

      // A growth write that would push further over the cap.
      w.send(syncUpdateFrame(freshUpdate(2000)));

      // Refused: exactly one storage-full frame (reason 1), doc unchanged, nothing
      // appended, socket still OPEN.
      await vi.waitFor(() => expect(w.storageFull).toHaveLength(1), settle);
      expect(w.storageFull[0]!.reason).toBe(StorageFullReason.ContentCap);
      expect(w.storageFull[0]!.cap).toBe(3000);
      expect(server.roomContentBytes("cap-room")).toBe(contentBefore);
      expect(store.appends.length).toBe(appendsBefore);
      expect(w.ws.readyState).toBe(WS.OPEN);

      // Fail-open READ on the SAME socket: a SyncStep1 still gets a step2 reply.
      const before = w.syncFrames();
      w.send(syncStep1Frame(new Y.Doc())); // empty state vector → server replies its full state
      await vi.waitFor(() => expect(w.syncFrames()).toBeGreaterThan(before), settle);

      // Fail-open READ for a NEW joiner: it still syncs the prior (seeded) state.
      const jDoc = new CollabDocument();
      const j = client(server, "cap-room", jDoc);
      j.connect();
      await vi.waitFor(() => expect(jDoc.getSource().length).toBeGreaterThanOrEqual(6000), settle);

      j.destroy();
      w.close();
    } finally {
      await server.close();
    }
  });

  // ── 2b. Recompute-spam guard: repeated over-cap frames refuse on unchanged state ─
  it("refuses a burst of over-cap frames on unchanged state without applying any (anti-spam)", async () => {
    // After the first reconcile, `bytesAppendedSinceExact === 0`, so the bound is
    // already exact — a spammer's repeated over-cap frames must keep refusing on the
    // SAME state (nothing applied, doc/log never grow). This pins correctness of the
    // O(1)-per-refused-frame path (the guard skips a full re-encode when idle).
    const store = makeStore([seedSnapshot(6000)]);
    const quota = makeQuota({ maxContentBytes: 3000 });
    const server = await startSyncServer(0, { crdtStore: store, storageQuota: quota });
    try {
      const w = await openRaw(server, "spam-room");
      await w.gotFirst;
      await new Promise((r) => setTimeout(r, 40)); // eager caps resolved
      const exactBefore = server.roomExactContentBytes("spam-room");
      const logBefore = server.roomLogBytes("spam-room");

      // 25 distinct tiny over-cap growth frames on state that never changes.
      for (let i = 0; i < 25; i++) w.send(syncUpdateFrame(freshUpdate(50, String.fromCharCode(65 + (i % 26)))));

      await vi.waitFor(() => expect(w.storageFull.length).toBeGreaterThanOrEqual(1), settle);
      await new Promise((r) => setTimeout(r, 120));
      // Latched to ONE frame per episode; NOTHING applied; doc + log unchanged; open.
      expect(w.storageFull).toHaveLength(1);
      expect(w.storageFull[0]!.reason).toBe(StorageFullReason.ContentCap);
      expect(store.appends).toHaveLength(0);
      expect(server.roomExactContentBytes("spam-room")).toBe(exactBefore);
      expect(server.roomLogBytes("spam-room")).toBe(logBefore);
      expect(w.ws.readyState).toBe(WS.OPEN);
      w.close();
    } finally {
      await server.close();
    }
  });

  // ── 3. Under-cap writes: applied + persisted exactly as today ─────────────────
  it("applies and persists an under-cap write, accounting for it", async () => {
    const store = makeStore();
    const quota = makeQuota({ maxContentBytes: 1_000_000 });
    const server = await startSyncServer(0, { crdtStore: store, storageQuota: quota });
    try {
      const w = await openRaw(server, "ok-room");
      await w.gotFirst;
      w.send(syncUpdateFrame(freshUpdate(200)));

      await vi.waitFor(() => expect(store.appends.length).toBe(1), settle);
      expect(w.storageFull).toHaveLength(0);
      expect(server.roomLogBytes("ok-room")).toBeGreaterThan(0);
      expect(server.roomContentBytes("ok-room")).toBeGreaterThan(0);

      // A real joiner converges on the applied content (it actually landed).
      const jDoc = new CollabDocument();
      const j = client(server, "ok-room", jDoc);
      j.connect();
      await vi.waitFor(() => expect(jDoc.getSource().length).toBeGreaterThanOrEqual(200), settle);
      j.destroy();
      w.close();
    } finally {
      await server.close();
    }
  });

  // ── 4. Delete-escape: a room at/over cap ADMITS a delete-only update ──────────
  it("admits a delete-only update even when the room is over cap (no lockout)", async () => {
    // Seed over cap from a mirror we control, so we can craft a delete referencing
    // exactly the seeded structs.
    const mirror = new Y.Doc();
    mirror.getText("source").insert(0, "DELETEME" + "x".repeat(6000));
    const seed = Y.encodeStateAsUpdate(mirror);
    const store = makeStore([seed]);
    const quota = makeQuota({ maxContentBytes: 3000 });
    const server = await startSyncServer(0, { crdtStore: store, storageQuota: quota });
    try {
      const w = await openRaw(server, "del-room");
      await w.gotFirst;

      // First prove the room IS enforcing: a growth write is refused (reason 1).
      w.send(syncUpdateFrame(freshUpdate(1000)));
      await vi.waitFor(() => expect(w.storageFull).toHaveLength(1), settle);
      expect(w.storageFull[0]!.reason).toBe(StorageFullReason.ContentCap);

      // Now a DELETE-ONLY update (removes the "DELETEME" prefix) — admitted via the
      // escape hatch despite the room being over cap. No new storage-full frame.
      const del = capture(mirror, () => mirror.getText("source").delete(0, 8));
      expect(Y.decodeUpdate(del).structs.length).toBe(0); // truly delete-set only
      w.send(syncUpdateFrame(del));

      // The deletion actually applied on the server: a fresh joiner no longer sees
      // the "DELETEME" prefix.
      const jDoc = new CollabDocument();
      const j = client(server, "del-room", jDoc);
      j.connect();
      await vi.waitFor(() => {
        expect(jDoc.getSource().length).toBeGreaterThan(0);
        expect(jDoc.getSource().startsWith("DELETEME")).toBe(false);
      }, settle);
      // Still exactly one storage-full frame — the delete did not trigger another.
      expect(w.storageFull).toHaveLength(1);

      j.destroy();
      w.close();
    } finally {
      await server.close();
    }
  });

  // ── 5. SyncStep1 at cap: never refused ───────────────────────────────────────
  it("never refuses a SyncStep1 (read) even when the room is over cap", async () => {
    const store = makeStore([seedSnapshot(6000)]);
    const quota = makeQuota({ maxContentBytes: 3000 });
    const server = await startSyncServer(0, { crdtStore: store, storageQuota: quota });
    try {
      const w = await openRaw(server, "read-room");
      await w.gotFirst;
      const before = w.syncFrames();
      w.send(syncStep1Frame(new Y.Doc())); // pure read request
      // The server replies its state (a step2) and NEVER a storage-full frame.
      await vi.waitFor(() => expect(w.syncFrames()).toBeGreaterThan(before), settle);
      await new Promise((r) => setTimeout(r, 80));
      expect(w.storageFull).toHaveLength(0);
      w.close();
    } finally {
      await server.close();
    }
  });

  // ── 6. Lying length prefix: frame refused safely, no crash, nothing applied ───
  it("refuses a frame whose declared update length lies, without crashing or applying", async () => {
    const store = makeStore();
    const quota = makeQuota({ maxContentBytes: 1_000_000 });
    const server = await startSyncServer(0, { crdtStore: store, storageQuota: quota });
    try {
      const w = await openRaw(server, "lie-room");
      await w.gotFirst;
      w.send(lyingLengthFrame(5_000_000)); // declares 5 MB, sends 2 bytes

      // Nothing applied, nothing appended, no crash: the room is intact and a second
      // peer can still join and sync.
      await new Promise((r) => setTimeout(r, 120));
      expect(store.appends).toHaveLength(0);
      expect(server.roomCount()).toBe(1);
      const w2 = await openRaw(server, "lie-room");
      await w2.gotFirst; // proves the relay survived and still serves the room
      w.close();
      w2.close();
    } finally {
      await server.close();
    }
  });

  // ── 7. Stale-bound no-false-reject: recompute admits when exact is under cap ───
  it("recomputes the exact size on a stale bound and admits a write that actually fits", async () => {
    // Cap chosen so a fresh room accepts one big write, the append bound (which
    // counts every appended byte, NOT the GC'd content) then sits near the cap, a
    // large delete drops the true content well under it, and the next write —
    // whose `bound + declaredLen` CROSSES the cap (forcing the reconcile) while the
    // true `exact + declaredLen` fits — is ADMITTED. Cap 10_000 is deliberately
    // below `bound(~8050) + u2(~2020) = ~10070`, so the reconcile path is exercised
    // (not shadow-admitted by the cheap bound).
    const mirror = new Y.Doc();
    const store = makeStore();
    const quota = makeQuota({ maxContentBytes: 10_000 });
    const server = await startSyncServer(0, { crdtStore: store, storageQuota: quota });
    try {
      const w = await openRaw(server, "stale-room");
      await w.gotFirst;

      // Fill to ~8 KB (under the 10 KB cap).
      const u1 = capture(mirror, () => mirror.getText("source").insert(0, "x".repeat(8000)));
      w.send(syncUpdateFrame(u1));
      await vi.waitFor(() => expect(server.roomContentBytes("stale-room")).toBeGreaterThan(7000), settle);

      // Delete almost all of it — the emitted delete update grows the append bound
      // even though the true (GC'd) content shrinks to near zero.
      const del = capture(mirror, () => mirror.getText("source").delete(0, 7900));
      w.send(syncUpdateFrame(del));
      await vi.waitFor(() => expect(store.appends.length).toBe(2), settle);
      // The bound is now well over the true content (still counts u1's ~8 KB append).
      expect(server.roomContentBytes("stale-room")).toBeGreaterThan(
        server.roomExactContentBytes("stale-room") + 4000,
      );

      // A write whose stale bound crosses the cap (~10070 > 10000) but whose true
      // content easily fits → reconcile recomputes the exact size → ADMITTED.
      const u2 = capture(mirror, () =>
        mirror.getText("source").insert(mirror.getText("source").length, "y".repeat(2000)),
      );
      w.send(syncUpdateFrame(u2));
      await vi.waitFor(() => expect(store.appends.length).toBe(3), settle);
      expect(w.storageFull).toHaveLength(0); // never falsely rejected
      w.close();
    } finally {
      await server.close();
    }
  });

  // ── 8. Provider failure: refused with reason 3 (not 1); cached; recovers ──────
  it("fails closed with reason 3 (not out-of-storage) when getCaps rejects, and recovers", async () => {
    let fail = true;
    let calls = 0;
    const quota: StorageQuota = {
      async getCaps() {
        calls++;
        if (fail) throw new Error("provider down");
        return { maxContentBytes: 1_000_000 };
      },
    };
    const store = makeStore();
    const server = await startSyncServer(0, { crdtStore: store, storageQuota: quota });
    try {
      const w = await openRaw(server, "flap-room");
      await w.gotFirst;
      await new Promise((r) => setTimeout(r, 40)); // let the eager getCaps reject + cache

      // Growth is refused with the DISTINCT unavailable reason, never content-cap.
      w.send(syncUpdateFrame(freshUpdate(200)));
      await vi.waitFor(() => expect(w.storageFull).toHaveLength(1), settle);
      expect(w.storageFull[0]!.reason).toBe(StorageFullReason.QuotaUnavailable);

      // A second growth write within the failure-cache TTL does NOT re-hit getCaps
      // (the flap is cached) — the call count stays at the single eager attempt.
      const callsAfterFirst = calls;
      w.send(syncUpdateFrame(freshUpdate(200)));
      await new Promise((r) => setTimeout(r, 80));
      expect(calls).toBe(callsAfterFirst);
      expect(store.appends).toHaveLength(0); // nothing landed while unavailable

      // Recovery: the provider heals; once the failure cache lapses, a subsequent
      // frame re-resolves getCaps (success) and writes are admitted again.
      fail = false;
      await vi.waitFor(
        async () => {
          w.send(syncUpdateFrame(freshUpdate(50, "z")));
          expect(store.appends.length).toBeGreaterThan(0);
        },
        { timeout: 15_000, interval: 200 },
      );
      expect(calls).toBeGreaterThan(callsAfterFirst); // getCaps was retried on recovery
      w.close();
    } finally {
      await server.close();
    }
  }, 20_000);

  // ── 9. Compaction trigger: fires ONCE, folds the log, restart is byte-identical ─
  it("compacts once past the high-water (no double-fire under a burst) and restart restores identically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "galley-b2-compact-"));
    const inner = new FsCrdtStore(dir);
    let compacts = 0;
    let releaseCompact!: () => void;
    const compactGate = new Promise<void>((r) => (releaseCompact = r));
    // A counting + gating proxy so the FIRST compaction stays in-flight during the
    // burst — the in-flight flag must stop any second schedule.
    const store: CrdtStore = {
      loadUpdates: (id) => inner.loadUpdates(id),
      appendUpdate: (id, u) => inner.appendUpdate(id, u),
      async compact(id) {
        compacts++;
        await compactGate;
        return inner.compact(id);
      },
    };
    // Small floor so a modest incremental history trips the high-water; generous
    // content cap + no log ceiling so ONLY the compaction path is exercised.
    const quota = makeQuota({ maxContentBytes: 10_000_000, compactionFloorBytes: 256 });
    const server = await startSyncServer(0, { crdtStore: store, storageQuota: quota });
    try {
      const doc = new CollabDocument();
      const a = client(server, "proj-compact", doc);
      a.connect();
      await vi.waitFor(() => expect(server.roomCount()).toBe(1), settle);

      // A burst of many tiny appends: the append log outgrows 2× the compacted size
      // and crosses the floor, so compaction is scheduled — exactly once.
      for (let i = 0; i < 80; i++) doc.transact((t) => t.insert(t.length, "z"), HUMAN);

      await vi.waitFor(() => expect(compacts).toBe(1), settle);
      // Still in-flight (gated): more appends must NOT schedule a second compaction.
      for (let i = 0; i < 40; i++) doc.transact((t) => t.insert(t.length, "q"), HUMAN);
      await new Promise((r) => setTimeout(r, 120));
      expect(compacts).toBe(1); // in-flight flag held

      const peakLog = server.roomLogBytes("proj-compact"); // the un-folded accumulation
      releaseCompact();
      // After the fold, the log DROPS (the pre-schedule history is folded into one
      // snapshot) — but the tail appends accepted DURING the compaction are still
      // counted (fix #2 — never erased), so logBytes stays ≥ the exact content size.
      await vi.waitFor(() => {
        expect(server.roomLogBytes("proj-compact")).toBeLessThan(peakLog);
        expect(server.roomLogBytes("proj-compact")).toBeGreaterThanOrEqual(
          server.roomExactContentBytes("proj-compact"),
        );
      }, settle);

      const expected = doc.getSource();
      a.destroy();
      await vi.waitFor(() => expect(server.roomCount()).toBe(0), settle);
      await server.close();

      // Restart over the SAME store: a fresh client converges byte-identically.
      const server2 = await startSyncServer(0, { crdtStore: new FsCrdtStore(dir) });
      try {
        const doc2 = new CollabDocument();
        const b = client(server2, "proj-compact", doc2);
        b.connect();
        await vi.waitFor(() => expect(doc2.getSource()).toBe(expected), settle);
        b.destroy();
      } finally {
        await server2.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ── 10. Hard ceiling: compacted size still over maxLogBytes ⇒ reason 2 ────────
  it("refuses growth with reason 2 when even the compacted log exceeds the hard ceiling", async () => {
    // A single loaded snapshot (already maximally compacted) larger than the flat
    // ceiling: content cap is unlimited, isolating the log-ceiling path.
    const seed = seedSnapshot(4000);
    const store = makeStore([seed]);
    const quota = makeQuota({ maxLogBytes: 2000 }); // unlimited content ⇒ isolate the log ceiling
    const server = await startSyncServer(0, { crdtStore: store, storageQuota: quota });
    try {
      const w = await openRaw(server, "ceil-room");
      await w.gotFirst;
      expect(server.roomLogBytes("ceil-room")).toBeGreaterThan(2000); // loaded over the ceiling

      w.send(syncUpdateFrame(freshUpdate(100)));
      await vi.waitFor(() => expect(w.storageFull).toHaveLength(1), settle);
      expect(w.storageFull[0]!.reason).toBe(StorageFullReason.LogCeiling);
      expect(w.storageFull[0]!.cap).toBe(2000);
      expect(store.appends).toHaveLength(0);
      w.close();
    } finally {
      await server.close();
    }
  });

  // ── 11. Counter init on restart: an over-cap room refuses immediately ─────────
  it("initializes counters from the loaded log so an over-cap room refuses growth right after restart", async () => {
    const store = makeStore([seedSnapshot(6000)]);
    const quota = makeQuota({ maxContentBytes: 3000 });
    const server = await startSyncServer(0, { crdtStore: store, storageQuota: quota });
    try {
      // No writes happened this session; the bound must reflect the LOADED state.
      const w = await openRaw(server, "restart-room");
      await w.gotFirst;
      expect(server.roomContentBytes("restart-room")).toBeGreaterThan(3000);
      expect(server.roomLogBytes("restart-room")).toBeGreaterThan(0);

      w.send(syncUpdateFrame(freshUpdate(100)));
      await vi.waitFor(() => expect(w.storageFull).toHaveLength(1), settle);
      expect(w.storageFull[0]!.reason).toBe(StorageFullReason.ContentCap);
      w.close();
    } finally {
      await server.close();
    }
  });

  // ── 12. Once-per-episode: one frame per full episode per connection ───────────
  it("emits one storage-full frame per full episode, and a fresh frame after leaving+re-entering full", async () => {
    // The mirror stays in lockstep with the SERVER's ACCEPTED state: only admitted
    // updates are applied to it, so a crafted delete references live server structs.
    const mirror = new Y.Doc();
    const store = makeStore();
    const quota = makeQuota({ maxContentBytes: 5000 });
    const server = await startSyncServer(0, { crdtStore: store, storageQuota: quota });
    try {
      const w = await openRaw(server, "episode-room");
      await w.gotFirst;
      await new Promise((r) => setTimeout(r, 40)); // eager caps resolved

      // Fill exact to just under the cap (admitted).
      const u1 = capture(mirror, () => mirror.getText("source").insert(0, "x".repeat(4600)));
      w.send(syncUpdateFrame(u1));
      await vi.waitFor(() => expect(server.roomContentBytes("episode-room")).toBeGreaterThan(4500), settle);

      // Two CONSECUTIVE over-cap growth writes ⇒ exactly ONE storage-full frame.
      w.send(syncUpdateFrame(freshUpdate(600, "y")));
      w.send(syncUpdateFrame(freshUpdate(600, "w")));
      await vi.waitFor(() => expect(w.storageFull).toHaveLength(1), settle);
      await new Promise((r) => setTimeout(r, 80));
      expect(w.storageFull).toHaveLength(1); // second over-cap write is latched — no new frame

      // Leave the full state: delete almost everything (admitted via escape).
      const del = capture(mirror, () => mirror.getText("source").delete(0, 4500));
      w.send(syncUpdateFrame(del));
      await vi.waitFor(() => expect(store.appends.length).toBe(2), settle); // u1 + del

      // A small write now fits (content dropped under cap) → admitted → episode ends.
      const u2 = capture(mirror, () =>
        mirror.getText("source").insert(mirror.getText("source").length, "z".repeat(50)),
      );
      w.send(syncUpdateFrame(u2));
      await vi.waitFor(() => expect(store.appends.length).toBe(3), settle);

      // Re-fill over the cap ⇒ a SECOND storage-full frame (new episode).
      w.send(syncUpdateFrame(freshUpdate(5200, "k")));
      await vi.waitFor(() => expect(w.storageFull).toHaveLength(2), settle);
      expect(w.storageFull[1]!.reason).toBe(StorageFullReason.ContentCap);
      w.close();
    } finally {
      await server.close();
    }
  });

  // ── 13. Old-client safety: a stock client ignores the storage-full frame ──────
  it("a stock CollabConnection client neither crashes nor changes behavior on a storage-full frame", async () => {
    // A real (unmodified) client fills a room over cap. Its optimistic local edit
    // stays local; the server refuses the sync and sends a storage-full frame the
    // client does not understand. The client must keep working: it still syncs
    // subsequent state and stays connected.
    const store = makeStore([seedSnapshot(6000)]);
    const quota = makeQuota({ maxContentBytes: 3000 });
    const server = await startSyncServer(0, { crdtStore: store, storageQuota: quota });
    try {
      const doc = new CollabDocument();
      const c = client(server, "stock-room", doc);
      c.connect();
      // The client reads the seeded state (reads fail open even at cap).
      await vi.waitFor(() => expect(doc.getSource().length).toBeGreaterThanOrEqual(6000), settle);

      // The client attempts a growth edit; the server refuses + sends the frame the
      // stock client does not recognize. It must not crash or disconnect.
      doc.transact((t) => t.insert(t.length, "MORE"), HUMAN);
      await new Promise((r) => setTimeout(r, 150));
      expect(server.roomCount()).toBe(1);

      // Still functional: a second peer's readable state syncs to this client.
      const doc2 = new CollabDocument();
      const c2 = client(server, "stock-room", doc2);
      c2.connect();
      await vi.waitFor(() => expect(doc2.getSource().length).toBeGreaterThanOrEqual(6000), settle);
      // The original client is still connected and consistent with the room.
      expect(doc.getSource().length).toBeGreaterThanOrEqual(6000);

      c.destroy();
      c2.destroy();
    } finally {
      await server.close();
    }
  });

  // ── 14. Bound invariant + hot-path recompute cost ────────────────────────────
  it("keeps the bound ≥ exact across a randomized append/delete sequence (and reports recompute cost)", async () => {
    const store = makeStore();
    const quota = makeQuota({ maxContentBytes: 50_000_000 }); // never refuse; just exercise accounting
    const server = await startSyncServer(0, { crdtStore: store, storageQuota: quota });
    try {
      const doc = new CollabDocument();
      const a = client(server, "prop-room", doc);
      a.connect();
      await vi.waitFor(() => expect(server.roomCount()).toBe(1), settle);

      // A deterministic pseudo-random append/delete walk.
      let seed = 12345;
      const rnd = (n: number): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed % n;
      };
      for (let i = 0; i < 120; i++) {
        const len = doc.getSource().length;
        if (len > 40 && rnd(3) === 0) {
          const start = rnd(len - 10);
          doc.transact((t) => t.delete(start, 1 + rnd(9)), HUMAN);
        } else {
          const at = len === 0 ? 0 : rnd(len);
          doc.transact((t) => t.insert(at, "ab".repeat(1 + rnd(20))), HUMAN);
        }
        await vi.waitFor(() => {
          // The cheap append bound must never under-estimate the true encode size.
          expect(server.roomContentBytes("prop-room")).toBeGreaterThanOrEqual(
            server.roomExactContentBytes("prop-room"),
          );
        }, settle);
      }

      // Measure the exact-recompute cost on a large doc (the hot-path claim: this is
      // NOT run per frame — only on a cap crossing / compaction high-water).
      const bigDoc = new CollabDocument();
      const big = client(server, "prop-big", bigDoc);
      big.connect();
      await vi.waitFor(() => expect(server.roomCount()).toBe(2), settle);
      bigDoc.transact((t) => t.insert(0, "lorem ipsum ".repeat(50_000)), HUMAN); // ~600 KB
      await vi.waitFor(
        () => expect(server.roomExactContentBytes("prop-big")).toBeGreaterThan(400_000),
        settle,
      );
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) server.roomExactContentBytes("prop-big");
      const perRecompute = (performance.now() - t0) / 20;
      // eslint-disable-next-line no-console
      console.log(
        `[B2] exact-recompute on a ~${server.roomExactContentBytes("prop-big")}-byte doc: ` +
          `${perRecompute.toFixed(3)} ms/call`,
      );
      expect(perRecompute).toBeLessThan(50); // generous; documents the cold-path cost

      a.destroy();
      big.destroy();
    } finally {
      await server.close();
    }
  });
});

// GPT security-round fixes (3 HIGH / 2 MEDIUM). Each test fails against the code
// BEFORE its fix and passes after.
describe("sync server — storage caps (B2) security round", () => {
  // ── #2 HIGH: compaction must not erase tail appends accepted while it ran ──────
  it("preserves tail appends accepted while a compaction was in flight (no log under-count)", async () => {
    let releaseCompact!: () => void;
    const gate = new Promise<void>((r) => (releaseCompact = r));
    let compacts = 0;
    const store: CrdtStore = {
      async loadUpdates() {
        return [];
      },
      async appendUpdate() {},
      async compact() {
        compacts++;
        await gate; // held open so tail appends accrue mid-compaction
      },
    };
    const quota = makeQuota({ maxContentBytes: 50_000_000, compactionFloorBytes: 256 });
    const server = await startSyncServer(0, { crdtStore: store, storageQuota: quota });
    try {
      const doc = new CollabDocument();
      const a = client(server, "tail-room", doc);
      a.connect();
      await vi.waitFor(() => expect(server.roomCount()).toBe(1), settle);

      // Drive the append log past the high-water so ONE compaction is scheduled+gated.
      for (let i = 0; i < 40; i++) doc.transact((t) => t.insert(t.length, "z"), HUMAN);
      await vi.waitFor(() => expect(compacts).toBe(1), settle);

      // While the compaction is HELD, more appends accrue in the log.
      const logAtHold = server.roomLogBytes("tail-room");
      for (let i = 0; i < 40; i++) doc.transact((t) => t.insert(t.length, "q"), HUMAN);
      await vi.waitFor(
        () => expect(server.roomLogBytes("tail-room")).toBeGreaterThan(logAtHold),
        settle,
      );

      releaseCompact();
      // After the fold, logBytes must still include the tail (freshEncode + tail) —
      // NOT collapse to just the snapshot, or the high-water could never refire.
      await vi.waitFor(() => {
        expect(server.roomLogBytes("tail-room")).toBeGreaterThan(
          server.roomExactContentBytes("tail-room") + 200,
        );
      }, settle);
      a.destroy();
    } finally {
      await server.close();
    }
  });

  // ── #1/#3 HIGH: a hung getCaps fails closed, dedupes, and never blocks reap ────
  it("a hung getCaps fails growth closed (reason 3), dedupes calls, and does not block reap", async () => {
    let calls = 0;
    const quota: StorageQuota = {
      getCaps() {
        calls++;
        return new Promise<{ maxContentBytes?: number }>(() => {}); // never resolves — a hung provider
      },
    };
    const store = makeStore();
    const server = await startSyncServer(0, { crdtStore: store, storageQuota: quota });
    try {
      const w = await openRaw(server, "hang-room");
      await w.gotFirst;
      // Growth fails closed with the DISTINCT unavailable reason while caps hang…
      for (let i = 0; i < 10; i++) {
        w.send(syncUpdateFrame(freshUpdate(50, String.fromCharCode(65 + i))));
      }
      await vi.waitFor(() => expect(w.storageFull.length).toBeGreaterThanOrEqual(1), settle);
      expect(w.storageFull[0]!.reason).toBe(StorageFullReason.QuotaUnavailable);
      // …and the 10 frames do NOT each re-hit getCaps (per-instance dedupe: only the
      // eager load-barrier resolve is in flight).
      expect(calls).toBe(1);
      expect(store.appends).toHaveLength(0);

      // The hung getCaps does not retain/block the room: disconnect reaps it.
      w.close();
      await vi.waitFor(() => expect(server.roomCount()).toBe(0), settle);

      // Reconnect recreates the room → exactly one more resolve (bounded, not a flood).
      const w2 = await openRaw(server, "hang-room");
      await w2.gotFirst;
      w2.send(syncUpdateFrame(freshUpdate(50, "Z")));
      await vi.waitFor(() => expect(w2.storageFull.length).toBeGreaterThanOrEqual(1), settle);
      expect(calls).toBe(2);
      w2.close();
    } finally {
      await server.close();
    }
  });

  // ── #4 MEDIUM: the latch must NOT suppress a reason TRANSITION (3 → 1) ─────────
  it("re-notifies on a reason transition (provider-flap 3 → genuine over-cap 1) on one socket", async () => {
    let fail = true;
    const quota: StorageQuota = {
      async getCaps() {
        if (fail) throw new Error("provider down");
        return { maxContentBytes: 3000 };
      },
    };
    const store = makeStore([seedSnapshot(6000)]); // exceeds the eventual cap
    const server = await startSyncServer(0, { crdtStore: store, storageQuota: quota });
    try {
      const w = await openRaw(server, "transition-room");
      await w.gotFirst;
      await new Promise((r) => setTimeout(r, 40)); // eager getCaps rejected + cached

      // Phase 1 — provider down → growth refused reason 3 (frame 1).
      w.send(syncUpdateFrame(freshUpdate(50)));
      await vi.waitFor(() => expect(w.storageFull.length).toBe(1), settle);
      expect(w.storageFull[0]!.reason).toBe(StorageFullReason.QuotaUnavailable);

      // Provider heals with a low cap the seeded room already exceeds.
      fail = false;
      // Phase 2 — once the failure cache lapses + caps re-resolve, the SAME socket
      // hits the genuine content cap → a SECOND frame (reason 1). The old Set latch
      // would have suppressed this transition; the {reason,cap} latch must emit it.
      await vi.waitFor(
        () => {
          w.send(syncUpdateFrame(freshUpdate(50, "y")));
          expect(w.storageFull.length).toBe(2);
        },
        { timeout: 15_000, interval: 200 },
      );
      expect(w.storageFull[1]!.reason).toBe(StorageFullReason.ContentCap);
      expect(w.storageFull[1]!.cap).toBe(3000);
      w.close();
    } finally {
      await server.close();
    }
  }, 20_000);

  // ── #5 MEDIUM: a failed appendUpdate must roll its bytes back out of logBytes ──
  it("rolls a failed appendUpdate out of the log counter (no false ceiling refusal)", async () => {
    let down = true;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const appended: Uint8Array[] = [];
    const store: CrdtStore = {
      async loadUpdates() {
        return [];
      },
      async appendUpdate(_id, u) {
        if (down) throw new Error("store outage");
        appended.push(new Uint8Array(u));
      },
      async compact() {},
    };
    // Log ceiling 800: without the rollback, a few ~220-byte appends climb past it
    // and start refusing reason 2. Content cap huge so ONLY the log path matters.
    const quota = makeQuota({ maxContentBytes: 50_000_000, maxLogBytes: 800 });
    const server = await startSyncServer(0, { crdtStore: store, storageQuota: quota });
    try {
      const w = await openRaw(server, "outage-room");
      await w.gotFirst;
      await new Promise((r) => setTimeout(r, 40));

      // Send ONE frame at a time; wait for it to APPLY (content grows) and then for
      // its failed-append rollback to bring logBytes back down before the next. This
      // is deterministic (not racing ws frame delivery) and, WITHOUT the rollback,
      // logBytes would climb monotonically and this settle-wait would time out by
      // ~frame 4 (and start refusing reason 2).
      for (let i = 0; i < 20; i++) {
        const before = server.roomExactContentBytes("outage-room");
        w.send(syncUpdateFrame(freshUpdate(200, String.fromCharCode(48 + i))));
        await vi.waitFor(
          () => expect(server.roomExactContentBytes("outage-room")).toBeGreaterThan(before),
          settle,
        ); // the update APPLIED in memory (content grew)…
        await vi.waitFor(
          () => expect(server.roomLogBytes("outage-room")).toBeLessThan(300),
          settle,
        ); // …and its failed LOG write rolled back out of logBytes
      }
      // No false log-ceiling refusal ever fired, and nothing persisted this outage.
      expect(w.storageFull).toHaveLength(0);
      expect(appended).toHaveLength(0);
      // Content DID grow in memory (the updates applied) even though the log rolled back.
      expect(server.roomExactContentBytes("outage-room")).toBeGreaterThan(1000);

      // Recovery: the store heals; a growth write appends + admits normally.
      down = false;
      w.send(syncUpdateFrame(freshUpdate(60, "R")));
      await vi.waitFor(() => expect(appended.length).toBeGreaterThan(0), settle);
      expect(w.storageFull).toHaveLength(0); // never a spurious ceiling refusal
      w.close();
    } finally {
      errorSpy.mockRestore();
      await server.close();
    }
  });
});

// A tiny sanity check that the WIRE FORMAT is exactly what the cross-repo consumer
// will decode: type=4, then two varints (reason, cap). This pins the byte contract.
describe("storage-full wire format (cross-repo contract)", () => {
  it("encodes [messageStorageFull][reason][cap] as three varuints", async () => {
    const { encodeStorageFull } = await import("./index.js");
    const bytes = encodeStorageFull(StorageFullReason.ContentCap, 4096);
    const dec = decoding.createDecoder(bytes);
    expect(decoding.readVarUint(dec)).toBe(messageStorageFull);
    expect(decoding.readVarUint(dec)).toBe(StorageFullReason.ContentCap);
    expect(decoding.readVarUint(dec)).toBe(4096);
    expect(decoding.hasContent(dec)).toBe(false); // bounded — nothing trailing
  });
});

// Self-hoster env wiring (B2). Unset ⇒ `{}` (accounting off, byte-identical);
// set ⇒ a trivial flat-cap StorageQuota; invalid ⇒ fail loud at startup.
describe("buildStorageOptions — GALLEY_SYNC_MAX_* (storage caps, default OFF)", () => {
  it("UNSET / blank: no storageQuota (byte-for-byte the accounting-off default)", async () => {
    const { buildStorageOptions } = await import("./server-config.js");
    expect(buildStorageOptions({})).toEqual({});
    expect(buildStorageOptions({ GALLEY_SYNC_MAX_CONTENT_BYTES: "" })).toEqual({});
    expect(buildStorageOptions({ GALLEY_SYNC_MAX_LOG_BYTES: "   " })).toEqual({});
  });

  it("SET content cap: attaches a flat-cap StorageQuota whose getCaps returns it", async () => {
    const { buildStorageOptions } = await import("./server-config.js");
    const opts = buildStorageOptions({ GALLEY_SYNC_MAX_CONTENT_BYTES: "1048576" });
    expect(opts.storageQuota).toBeDefined();
    await expect(opts.storageQuota!.getCaps("any-room")).resolves.toEqual({ maxContentBytes: 1048576 });
  });

  it("SET log ceiling + floor: carried onto the StorageQuota", async () => {
    const { buildStorageOptions } = await import("./server-config.js");
    const opts = buildStorageOptions({
      GALLEY_SYNC_MAX_LOG_BYTES: "8388608",
      GALLEY_SYNC_COMPACT_FLOOR_BYTES: "4194304",
    });
    expect(opts.storageQuota!.maxLogBytes).toBe(8388608);
    expect(opts.storageQuota!.compactionFloorBytes).toBe(4194304);
    // No content cap set ⇒ unlimited content, log ceiling still enforced.
    await expect(opts.storageQuota!.getCaps("r")).resolves.toEqual({ maxContentBytes: undefined });
  });

  it("THROWS on an invalid (non positive-integer) value (fail loud, never silently off)", async () => {
    const { buildStorageOptions } = await import("./server-config.js");
    for (const v of ["0", "-1", "1.5", "10mb", "abc", " 12 3 "]) {
      expect(() => buildStorageOptions({ GALLEY_SYNC_MAX_CONTENT_BYTES: v }), v).toThrow(
        /GALLEY_SYNC_MAX_CONTENT_BYTES/,
      );
    }
  });

  it("buildSyncOptions default path stays `{}` (storage caps do not disturb it)", async () => {
    const { buildSyncOptions } = await import("./server-config.js");
    expect(buildSyncOptions({})).toEqual({});
    // And a set cap surfaces on the assembled open-path options.
    expect(buildSyncOptions({ GALLEY_SYNC_MAX_CONTENT_BYTES: "1000" }).storageQuota).toBeDefined();
  });
});
