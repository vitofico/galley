/**
 * B1.3 (roadmap S2, blocks beta) — relay CRDT persistence. With a `crdtStore`
 * configured on the sync server, a relay crash/restart loses NO CRDT state:
 *
 *   - room create LOADS the persisted log into the fresh doc BEFORE the first
 *     syncStep1 any joiner sees (all concurrent joiners share ONE in-flight load);
 *   - every relayed doc update is APPENDED as it happens, so durability never
 *     depends on a graceful shutdown (the crash case);
 *   - the log is COMPACTED to one snapshot on room reap and, awaited, on close().
 *
 * Without a store the relay stays byte-for-byte stateless (the existing
 * sync-server.test.ts suite covers that path).
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket as WS } from "ws";
import type { Author, CrdtStore } from "@galley/shared";
import {
  CollabDocument,
  CollabConnection,
  WebSocketTransport,
  restoreDoc,
  snapshotDoc,
  type WebSocketLike,
} from "@galley/collab";
import { FsCrdtStore } from "@galley/persistence";
import { startSyncServer, type SyncServerHandle } from "./index.js";

const HUMAN: Author = { kind: "human", userId: "u1" };
const settle = { timeout: 4000, interval: 20 };

/** A CollabConnection wired to the server over a real ws socket. */
function client(handle: SyncServerHandle, room: string, doc: CollabDocument) {
  const url = `ws://127.0.0.1:${handle.port}/${room}`;
  const transport = new WebSocketTransport(() => new WS(url) as unknown as WebSocketLike);
  return new CollabConnection(doc, transport, { author: HUMAN });
}

async function openWs(handle: SyncServerHandle, room: string): Promise<WS> {
  const ws = new WS(`ws://127.0.0.1:${handle.port}/${room}`);
  ws.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  return ws;
}

/**
 * A raw socket whose message counter is attached AT CONSTRUCTION — before the
 * upgrade even completes — so a frame the server sends the instant it accepts
 * the connection can never slip past the counter (attaching after `open`
 * resolves races the first frame and would let a missing load barrier pass).
 */
async function openCountedWs(
  handle: SyncServerHandle,
  room: string,
): Promise<{ ws: WS; frames: () => number }> {
  const ws = new WS(`ws://127.0.0.1:${handle.port}/${room}`);
  ws.binaryType = "arraybuffer";
  let frames = 0;
  ws.on("message", () => frames++);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  return { ws, frames: () => frames };
}

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "galley-sync-crdt-"));
}

/** Restore a store's persisted log for `room` into a fresh doc's source text. */
async function persistedSource(store: CrdtStore, room: string): Promise<string> {
  return new CollabDocument("", restoreDoc(await store.loadUpdates(room))).getSource();
}

describe("sync server — CRDT persistence (B1.3, integration)", () => {
  it("relay crash/restart loses no state: appends alone rebuild the room on a NEW instance", async () => {
    const dir = await makeDir();
    // Relay A holds the live session…
    const serverA = await startSyncServer(0, { crdtStore: new FsCrdtStore(dir) });
    const aDoc = new CollabDocument("draft v1\n");
    const a = client(serverA, "proj-restart", aDoc);
    try {
      a.connect();
      await vi.waitFor(() => expect(serverA.roomCount()).toBe(1), settle);
      aDoc.transact((t) => t.insert(t.length, "more\n"), HUMAN);

      // The append-on-update path alone (NO reap, NO graceful close ever ran)
      // must make the FULL doc durable — poll the raw store until it does, and
      // require exact Y.Doc equivalence, not just the text projection.
      const probe = new FsCrdtStore(dir);
      await vi.waitFor(async () => {
        const rebuilt = restoreDoc(await probe.loadUpdates("proj-restart"));
        expect(new CollabDocument("", rebuilt).getSource()).toBe("draft v1\nmore\n");
        expect(snapshotDoc(rebuilt)).toEqual(snapshotDoc(aDoc.doc));
      }, settle);

      // "Kill" relay A mid-session: it is simply never closed before B reads —
      // no flush, no compact, exactly what a crash leaves behind. A NEW relay
      // over the same store must serve the full state to a fresh client.
      const serverB = await startSyncServer(0, { crdtStore: new FsCrdtStore(dir) });
      const bDoc = new CollabDocument();
      const b = client(serverB, "proj-restart", bDoc);
      try {
        b.connect();
        await vi.waitFor(() => expect(bDoc.getSource()).toBe("draft v1\nmore\n"), settle);
        b.destroy();
      } finally {
        await serverB.close();
      }
      a.destroy();
    } finally {
      await serverA.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reap-then-rejoin: a room reaped while empty reloads its state from the store", async () => {
    const dir = await makeDir();
    const server = await startSyncServer(0, { crdtStore: new FsCrdtStore(dir) });
    try {
      const aDoc = new CollabDocument("keep me\n");
      const a = client(server, "proj-reap", aDoc);
      a.connect();
      await vi.waitFor(() => expect(server.roomCount()).toBe(1), settle);
      aDoc.transact((t) => t.insert(t.length, "and me\n"), HUMAN);

      a.disconnect(); // last peer leaves → the relay reaps the room (frees the doc)
      await vi.waitFor(() => expect(server.roomCount()).toBe(0), settle);

      // A fresh joiner recreates the room FROM THE STORE, not empty.
      const bDoc = new CollabDocument();
      const b = client(server, "proj-reap", bDoc);
      b.connect();
      await vi.waitFor(() => expect(bDoc.getSource()).toBe("keep me\nand me\n"), settle);

      a.destroy();
      b.destroy();
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reap compacts the room's log to ONE snapshot (storage stays bounded)", async () => {
    const dir = await makeDir();
    const server = await startSyncServer(0, { crdtStore: new FsCrdtStore(dir) });
    try {
      const aDoc = new CollabDocument("0");
      const a = client(server, "proj-compact", aDoc);
      a.connect();
      await vi.waitFor(() => expect(server.roomCount()).toBe(1), settle);
      for (const ch of ["1", "2", "3"]) aDoc.transact((t) => t.insert(t.length, ch), HUMAN);

      a.disconnect();
      await vi.waitFor(() => expect(server.roomCount()).toBe(0), settle);

      // The reap folds the multi-entry log into one snapshot, losslessly.
      const probe = new FsCrdtStore(dir);
      await vi.waitFor(async () => {
        const loaded = await probe.loadUpdates("proj-compact");
        expect(loaded.length).toBe(1);
        expect(new CollabDocument("", restoreDoc(loaded)).getSource()).toBe("0123");
      }, settle);

      a.destroy();
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("close() compacts AND awaits the write — the store is flushed the moment it resolves", async () => {
    const dir = await makeDir();
    const server = await startSyncServer(0, { crdtStore: new FsCrdtStore(dir) });
    const aDoc = new CollabDocument("seed\n");
    const bDoc = new CollabDocument();
    const a = client(server, "proj-shutdown", aDoc);
    const b = client(server, "proj-shutdown", bDoc);
    try {
      a.connect();
      b.connect();
      aDoc.transact((t) => t.insert(t.length, "tail\n"), HUMAN);
      // B converging proves the relay has RECEIVED every update (so the flush,
      // not test timing, is what makes them durable below).
      await vi.waitFor(() => expect(bDoc.getSource()).toBe("seed\ntail\n"), settle);

      await server.close();

      // NO polling: close() resolved, so the compacted snapshot must already
      // be on disk — a graceful shutdown never races process exit.
      const probe = new FsCrdtStore(dir);
      const loaded = await probe.loadUpdates("proj-shutdown");
      expect(loaded.length).toBe(1);
      expect(new CollabDocument("", restoreDoc(loaded)).getSource()).toBe("seed\ntail\n");
    } finally {
      a.destroy();
      b.destroy();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sync server — CRDT persistence (load barrier + append seam)", () => {
  function seedUpdate(text: string): Uint8Array {
    return snapshotDoc(new CollabDocument(text).doc);
  }

  it("holds syncStep1 until the restore completes; concurrent joiners share ONE load", async () => {
    let releaseLoad!: () => void;
    const gate = new Promise<void>((resolve) => (releaseLoad = resolve));
    let loads = 0;
    const store: CrdtStore = {
      async loadUpdates() {
        loads++;
        await gate;
        return [seedUpdate("seeded\n")];
      },
      async appendUpdate() {},
      async compact() {},
    };
    const server = await startSyncServer(0, { crdtStore: store });
    try {
      const w1 = await openCountedWs(server, "room-barrier");
      const w2 = await openCountedWs(server, "room-barrier");

      // While the ONE load is in flight, NEITHER joiner receives any doc bytes.
      await new Promise((r) => setTimeout(r, 150));
      expect(server.roomCount()).toBe(1);
      expect(w1.frames()).toBe(0);
      expect(w2.frames()).toBe(0);
      expect(loads).toBe(1); // both joiners parked on the same in-flight load

      releaseLoad();
      await vi.waitFor(() => {
        expect(w1.frames()).toBeGreaterThan(0);
        expect(w2.frames()).toBeGreaterThan(0);
      }, settle);

      // …and the restored content actually serves: a real client converges on
      // the persisted text without any peer having typed it this session.
      const cDoc = new CollabDocument();
      const c = client(server, "room-barrier", cDoc);
      c.connect();
      await vi.waitFor(() => expect(cDoc.getSource()).toBe("seeded\n"), settle);
      expect(loads).toBe(1); // one load for the room's whole lifetime

      c.destroy();
      w1.ws.close();
      w2.ws.close();
    } finally {
      await server.close();
    }
  });

  it("appends every peer update: the append log alone rebuilds the doc", async () => {
    const appended: Uint8Array[] = [];
    const store: CrdtStore = {
      async loadUpdates() {
        return [];
      },
      async appendUpdate(_id, update) {
        appended.push(new Uint8Array(update));
      },
      async compact() {},
    };
    const server = await startSyncServer(0, { crdtStore: store });
    try {
      const aDoc = new CollabDocument("hi\n");
      const a = client(server, "room-append", aDoc);
      a.connect();
      await vi.waitFor(() => expect(server.roomCount()).toBe(1), settle);
      aDoc.transact((t) => t.insert(t.length, "there\n"), HUMAN);

      await vi.waitFor(() => {
        expect(new CollabDocument("", restoreDoc(appended)).getSource()).toBe("hi\nthere\n");
      }, settle);
      a.destroy();
    } finally {
      await server.close();
    }
  });

  it("does NOT re-append restored updates (a room re-create never snowballs the log)", async () => {
    const appended: Uint8Array[] = [];
    const store: CrdtStore = {
      async loadUpdates() {
        return [seedUpdate("already persisted\n")];
      },
      async appendUpdate(_id, update) {
        appended.push(new Uint8Array(update));
      },
      async compact() {},
    };
    const server = await startSyncServer(0, { crdtStore: store });
    try {
      // A silent raw socket: the ONLY doc mutation is the server's own restore.
      const ws = await openWs(server, "room-noecho");
      await vi.waitFor(() => expect(server.roomCount()).toBe(1), settle);
      await new Promise((r) => setTimeout(r, 150));
      expect(appended).toHaveLength(0); // the restore itself must never round-trip
      ws.close();
    } finally {
      await server.close();
    }
  });

  it("a failing appendUpdate is logged (fixed message) and never crashes the room", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store: CrdtStore = {
      async loadUpdates() {
        return [];
      },
      async appendUpdate() {
        throw new Error("disk full");
      },
      async compact() {},
    };
    const server = await startSyncServer(0, { crdtStore: store });
    try {
      const aDoc = new CollabDocument("x");
      const bDoc = new CollabDocument();
      const a = client(server, "room-badstore", aDoc);
      const b = client(server, "room-badstore", bDoc);
      a.connect();
      b.connect();
      aDoc.transact((t) => t.insert(t.length, "y"), HUMAN);

      // The relay keeps relaying: B converges even though every append fails…
      await vi.waitFor(() => expect(bDoc.getSource()).toBe("xy"), settle);
      expect(server.roomCount()).toBe(1);
      // …and the failure is logged with a FIXED message (no room id leaked).
      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalledWith("[galley/sync] failed to persist a CRDT update");
      }, settle);

      a.destroy();
      b.destroy();
    } finally {
      await server.close();
      errorSpy.mockRestore();
    }
  });

  it("a failed load refuses joiners (1013) instead of silently serving an empty doc", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let loads = 0;
    const store: CrdtStore = {
      async loadUpdates() {
        loads++;
        throw new Error("volume gone");
      },
      async appendUpdate() {},
      async compact() {},
    };
    const server = await startSyncServer(0, { crdtStore: store });
    try {
      const ws = await openWs(server, "room-badload");
      const code = await new Promise<number>((resolve) => ws.on("close", (c) => resolve(c)));
      expect(code).toBe(1013); // "try again later" — never an empty doc a client could re-seed
      // The failed room is reaped, so a later join RETRIES the load fresh.
      await vi.waitFor(() => expect(server.roomCount()).toBe(0), settle);
      const ws2 = await openWs(server, "room-badload");
      await new Promise<void>((resolve) => ws2.on("close", () => resolve()));
      expect(loads).toBe(2);
    } finally {
      await server.close();
      errorSpy.mockRestore();
    }
  });

  it("a room whose name is not a safe storage key stays ephemeral — but fully joinable", async () => {
    let storeCalls = 0;
    const store: CrdtStore = {
      async loadUpdates() {
        storeCalls++;
        return [];
      },
      async appendUpdate() {
        storeCalls++;
      },
      async compact() {
        storeCalls++;
      },
    };
    const server = await startSyncServer(0, { crdtStore: store });
    try {
      // "bad.name" fails the fs adapters' safe-key charset: with a store wired,
      // such a room must degrade to the stateless path — never become unjoinable.
      const aDoc = new CollabDocument("live\n");
      const bDoc = new CollabDocument();
      const a = client(server, "bad.name", aDoc);
      const b = client(server, "bad.name", bDoc);
      a.connect();
      b.connect();
      await vi.waitFor(() => expect(bDoc.getSource()).toBe("live\n"), settle);

      a.destroy();
      b.destroy();
      await vi.waitFor(() => expect(server.roomCount()).toBe(0), settle);
      expect(storeCalls).toBe(0); // no load, no append, no compact — ephemeral
    } finally {
      await server.close();
    }
  });
});
