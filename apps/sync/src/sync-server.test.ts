import { describe, it, expect, vi } from "vitest";
import { WebSocket as WS } from "ws";
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import type { Author } from "@galley/shared";
import {
  CollabDocument,
  CollabConnection,
  WebSocketTransport,
  type WebSocketLike,
} from "@galley/collab";
import { startSyncServer, inspectAwarenessUpdate, type SyncServerHandle } from "./index.js";

const HUMAN: Author = { kind: "human", userId: "u1" };
const AGENT: Author = { kind: "agent", runId: "r1" };

/** A CollabConnection wired to the server over a real ws socket. */
function client(handle: SyncServerHandle, room: string, doc: CollabDocument, author?: Author) {
  const url = `ws://127.0.0.1:${handle.port}/${room}`;
  const transport = new WebSocketTransport(() => new WS(url) as unknown as WebSocketLike);
  return new CollabConnection(doc, transport, author ? { author } : undefined);
}

const settle = { timeout: 4000, interval: 20 };

describe("sync server — real websocket relay", () => {
  it("syncs document state and presence between two clients", async () => {
    const server = await startSyncServer(0);
    try {
      const aDoc = new CollabDocument("hello\n");
      const bDoc = new CollabDocument(); // empty joiner
      const a = client(server, "room1", aDoc, HUMAN);
      const b = client(server, "room1", bDoc, AGENT);
      a.connect();
      b.connect();

      // Initial sync: B converges on A's seeded content through the server.
      await vi.waitFor(() => expect(bDoc.getSource()).toBe("hello\n"), settle);

      // Live edits in both directions merge with no clobber.
      aDoc.transact((t) => t.insert(t.length, "from-A\n"), HUMAN);
      bDoc.transact((t) => t.insert(0, "from-B\n"), AGENT);
      await vi.waitFor(() => {
        expect(aDoc.getSource()).toBe(bDoc.getSource());
        expect(aDoc.getSource()).toContain("from-A");
        expect(aDoc.getSource()).toContain("from-B");
      }, settle);

      // Presence propagates: each sees a human and an agent peer.
      await vi.waitFor(() => {
        expect(a.presences().map((p) => p.author.kind).sort()).toEqual(["agent", "human"]);
        expect(b.presences().map((p) => p.author.kind).sort()).toEqual(["agent", "human"]);
      }, settle);

      a.destroy();
      b.destroy();
    } finally {
      await server.close();
    }
  });

  it("lets a late joiner catch up from the server's room state", async () => {
    const server = await startSyncServer(0);
    try {
      const aDoc = new CollabDocument("seed\n");
      const a = client(server, "room2", aDoc);
      a.connect();
      await vi.waitFor(() => expect(server.roomCount()).toBe(1), settle);
      aDoc.transact((t) => t.insert(t.length, "more\n"), HUMAN);

      // B joins later; the server (not A directly) brings it up to date.
      const bDoc = new CollabDocument();
      const b = client(server, "room2", bDoc);
      b.connect();
      await vi.waitFor(() => expect(bDoc.getSource()).toBe("seed\nmore\n"), settle);

      a.destroy();
      b.destroy();
    } finally {
      await server.close();
    }
  });

  it("reaps an emptied room after its last connection closes", async () => {
    const server = await startSyncServer(0);
    try {
      const aDoc = new CollabDocument("seed\n");
      const a = client(server, "reap-room", aDoc);
      a.connect();
      await vi.waitFor(() => expect(server.roomCount()).toBe(1), settle);

      a.disconnect(); // last (only) peer leaves → the room must be freed
      await vi.waitFor(() => expect(server.roomCount()).toBe(0), settle);

      a.destroy();
    } finally {
      await server.close();
    }
  });

  it("drops a peer's presence for others when it disconnects", async () => {
    const server = await startSyncServer(0);
    try {
      const aDoc = new CollabDocument("x");
      const bDoc = new CollabDocument();
      const a = client(server, "room3", aDoc, HUMAN);
      const b = client(server, "room3", bDoc, AGENT);
      a.connect();
      b.connect();
      await vi.waitFor(() => expect(a.presences()).toHaveLength(2), settle);

      b.disconnect(); // a clean departure must reach A through the server
      await vi.waitFor(() => {
        expect(a.presences().map((p) => p.author.kind)).toEqual(["human"]);
      }, settle);

      a.destroy();
    } finally {
      await server.close();
    }
  });

  it("drops a connection that floods awareness states from one peer (L2-S3)", async () => {
    const server = await startSyncServer(0);
    try {
      const ws = new WS(`ws://127.0.0.1:${server.port}/aware-flood`);
      ws.binaryType = "arraybuffer";
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      await vi.waitFor(() => expect(server.roomCount()).toBe(1), settle);

      // Hand-build ONE awareness frame declaring 100 client ids — far more than
      // the per-frame cap and any honest peer (which sends 1–2). The server reads
      // the declared count and terminates the connection BEFORE applying it.
      const aw = new Awareness(new Y.Doc());
      const ids: number[] = [];
      for (let i = 1; i <= 100; i++) {
        ids.push(i);
        aw.states.set(i, { user: i });
        aw.meta.set(i, { clock: 1, lastUpdated: 0 });
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 1 /* messageAwareness */);
      encoding.writeVarUint8Array(enc, encodeAwarenessUpdate(aw, ids));
      ws.send(encoding.toUint8Array(enc));

      // The server closes the abusive connection; its close handler frees the
      // injected states and reaps the now-empty room.
      await vi.waitFor(() => expect(server.roomCount()).toBe(0), settle);
      aw.destroy();
      try {
        ws.close();
      } catch {
        /* server may have already closed it */
      }
    } finally {
      await server.close();
    }
  });

  // SEC: awareness `meta` memory-DoS — `state:null` ids slip past the per-frame
  // AND per-connection live-states caps (they fire no 'update'), accumulating in
  // `meta` across many in-cap frames. The per-room ceiling bounds the running sum.
  // Each frame here declares fresh ids with NO state set → encodeAwarenessUpdate
  // emits state:null, exactly the silent-meta-growth vector.
  function awarenessFrame(entries: Array<{ id: number; state: unknown }>): Uint8Array {
    const aw = new Awareness(new Y.Doc());
    const ids: number[] = [];
    for (const { id, state } of entries) {
      ids.push(id);
      aw.meta.set(id, { clock: 1, lastUpdated: 0 });
      if (state !== null) aw.states.set(id, state as Record<string, unknown>);
      // state === null → leave out of `states` → encodeAwarenessUpdate emits null
    }
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 1 /* messageAwareness */);
    encoding.writeVarUint8Array(enc, encodeAwarenessUpdate(aw, ids));
    aw.destroy();
    return encoding.toUint8Array(enc);
  }

  // N fresh ids with state:null (the silent-meta-growth vector).
  function nullStateFrame(startId: number, count: number): Uint8Array {
    const entries: Array<{ id: number; state: unknown }> = [];
    for (let k = 0; k < count; k++) entries.push({ id: startId + k, state: null });
    return awarenessFrame(entries);
  }

  // Hand-build an awareness frame with RAW state strings (so a malformed/non-JSON
  // state can be injected — encodeAwarenessUpdate always emits valid JSON).
  function craftedAwarenessFrame(entries: Array<{ id: number; stateJson: string }>): Uint8Array {
    const body = encoding.createEncoder();
    encoding.writeVarUint(body, entries.length);
    for (const { id, stateJson } of entries) {
      encoding.writeVarUint(body, id);
      encoding.writeVarUint(body, 1 /* clock */);
      encoding.writeVarString(body, stateJson);
    }
    const frame = encoding.createEncoder();
    encoding.writeVarUint(frame, 1 /* messageAwareness */);
    encoding.writeVarUint8Array(frame, encoding.toUint8Array(body));
    return encoding.toUint8Array(frame);
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

  it("terminates a peer that accumulates awareness meta past the per-room ceiling across frames (SEC)", async () => {
    // Ceiling 120; each frame declares 50 fresh null-state ids (under the
    // per-frame cap of 64). Frame 3 would push meta past 120 → refuse + drop +
    // reap of the now-empty room.
    const server = await startSyncServer(0, { maxAwarenessMetaPerRoom: 120 });
    try {
      const ws = await openWs(server, "meta-flood");
      await vi.waitFor(() => expect(server.roomCount()).toBe(1), settle);

      for (let f = 0; f < 4; f++) ws.send(nullStateFrame(1 + f * 1000, 50));

      await vi.waitFor(() => expect(server.roomCount()).toBe(0), settle);
      try {
        ws.close();
      } catch {
        /* already closed by the server */
      }
    } finally {
      await server.close();
    }
  });

  it("HARD-bounds awareness meta against a burst, even with a co-resident peer keeping the room alive (SEC)", async () => {
    // The teeth of the fix: an honest peer H keeps the room alive (so it can't
    // reap), then an abuser fires a BURST of 100 queued null-state frames at
    // once. terminate() can't unwind frames already buffered this turn — only the
    // refuse-before-mutate + dropped-latch keeps meta at the ceiling instead of
    // ballooning to ~5000 (100×50).
    const server = await startSyncServer(0, { maxAwarenessMetaPerRoom: 120 });
    try {
      const hDoc = new CollabDocument("hi\n");
      const h = client(server, "poison", hDoc, HUMAN);
      h.connect();
      await vi.waitFor(() => expect(server.roomCount()).toBe(1), settle);

      const attacker = await openWs(server, "poison");
      // One synchronous burst of 100 frames × 50 fresh ids = 5000 declared ids.
      for (let f = 0; f < 100; f++) attacker.send(nullStateFrame(1 + f * 1000, 50));

      // Let the burst drain; the abuser is latched + terminated, the room stays
      // (H present) and its meta is bounded near the ceiling — NOT ~5000.
      await new Promise((r) => setTimeout(r, 200));
      expect(server.roomCount()).toBe(1); // H still holds the room open
      expect(server.maxRoomMetaSize()).toBeLessThanOrEqual(200); // ceiling 120 + slack, ≪ 5000

      try {
        attacker.close();
      } catch {
        /* already closed by the server */
      }
      h.destroy();
      await vi.waitFor(() => expect(server.roomCount()).toBe(0), settle);
    } finally {
      await server.close();
    }
  });

  it("terminates a peer whose awareness frame carries an oversized state payload (SEC)", async () => {
    // One id, but a ~70 KiB JSON state — under every COUNT cap, over the
    // per-frame state-byte budget (64 KiB). Refused before applying → reap.
    const server = await startSyncServer(0);
    try {
      const ws = await openWs(server, "fat-state");
      await vi.waitFor(() => expect(server.roomCount()).toBe(1), settle);

      ws.send(awarenessFrame([{ id: 7, state: { blob: "x".repeat(70_000) } }]));

      await vi.waitFor(() => expect(server.roomCount()).toBe(0), settle);
      try {
        ws.close();
      } catch {
        /* already closed by the server */
      }
    } finally {
      await server.close();
    }
  });

  it("drops a peer whose awareness frame throws mid-apply (malformed JSON after a valid entry) (SEC)", async () => {
    // Frame: a fresh id carrying a valid retained state, then an id whose state is
    // malformed JSON. applyAwarenessUpdate mutates (and RETAINS) the first entry,
    // then throws on the second's JSON.parse — and y-protocols emits no 'update'
    // on that throw, so the retained state would escape the per-conn live-id cap.
    // The apply try/catch latches + drops the peer instead (drop + reap), bounding
    // the partial mutation to this one capped frame.
    const server = await startSyncServer(0);
    try {
      const ws = await openWs(server, "partial-apply");
      await vi.waitFor(() => expect(server.roomCount()).toBe(1), settle);

      ws.send(
        craftedAwarenessFrame([
          { id: 100, stateJson: JSON.stringify({ user: "real" }) },
          { id: 7, stateJson: "{" }, // malformed JSON
        ]),
      );

      await vi.waitFor(() => expect(server.roomCount()).toBe(0), settle);
      try {
        ws.close();
      } catch {
        /* already closed by the server */
      }
    } finally {
      await server.close();
    }
  });

  it("keeps a peer connected while cumulative awareness meta stays under the ceiling", async () => {
    const server = await startSyncServer(0, { maxAwarenessMetaPerRoom: 200 });
    try {
      const ws = await openWs(server, "meta-ok");
      await vi.waitFor(() => expect(server.roomCount()).toBe(1), settle);

      ws.send(nullStateFrame(1, 50));
      ws.send(nullStateFrame(1001, 50));

      await new Promise((r) => setTimeout(r, 100));
      expect(server.roomCount()).toBe(1);
      expect(ws.readyState).toBe(WS.OPEN);

      ws.close();
      await vi.waitFor(() => expect(server.roomCount()).toBe(0), settle);
    } finally {
      await server.close();
    }
  });
});

describe("inspectAwarenessUpdate (awareness frame pre-parse, SEC)", () => {
  function rawUpdate(entries: Array<{ id: number; state: unknown }>): Uint8Array {
    const aw = new Awareness(new Y.Doc());
    const ids: number[] = [];
    for (const { id, state } of entries) {
      ids.push(id);
      aw.meta.set(id, { clock: 1, lastUpdated: 0 });
      if (state !== null) aw.states.set(id, state as Record<string, unknown>);
    }
    const bytes = encodeAwarenessUpdate(aw, ids);
    aw.destroy();
    return bytes;
  }

  it("counts declared ids, new-to-meta ids, and total state bytes", () => {
    const seen = new Set([1]); // id 1 already known to the room
    const update = rawUpdate([
      { id: 1, state: { a: 1 } },
      { id: 2, state: { b: 2 } },
      { id: 3, state: null },
    ]);
    const info = inspectAwarenessUpdate(update, seen);
    expect(info.declared).toBe(3);
    expect(info.newIds).toBe(2); // ids 2 and 3 are new; id 1 is already in `seen`
    expect(info.stateBytes).toBeGreaterThan(0);
  });

  it("reports a large state payload's byte size", () => {
    const update = rawUpdate([{ id: 9, state: { blob: "x".repeat(5000) } }]);
    const info = inspectAwarenessUpdate(update, new Set());
    expect(info.declared).toBe(1);
    expect(info.stateBytes).toBeGreaterThanOrEqual(5000);
  });

  it("short-circuits an over-declared count without walking entries", () => {
    // A frame claiming 1000 ids must return immediately (declared only); the
    // caller rejects on the count without the O(n) walk.
    const ids: Array<{ id: number; state: unknown }> = [];
    for (let i = 1; i <= 100; i++) ids.push({ id: i, state: { i } });
    const info = inspectAwarenessUpdate(rawUpdate(ids), new Set());
    expect(info.declared).toBe(100);
    expect(info.newIds).toBe(0); // not walked
    expect(info.stateBytes).toBe(0); // not walked
  });

  it("counts state size in UTF-8 bytes, not UTF-16 code units (multibyte)", () => {
    // CJK + emoji: each char is >1 UTF-8 byte, so the byte cap must not under-count.
    const state = { name: "名前", flag: "🚩" };
    const update = rawUpdate([{ id: 7, state }]);
    const info = inspectAwarenessUpdate(update, new Set());
    // The wire state is the JSON-serialized string (what encodeAwarenessUpdate emits).
    const stateJson = JSON.stringify(state);
    expect(info.stateBytes).toBe(Buffer.byteLength(stateJson, "utf8"));
    // And the UTF-8 byte length strictly exceeds the UTF-16 code-unit length here.
    expect(info.stateBytes).toBeGreaterThan(stateJson.length);
  });

  it("throws on a malformed body (caller drops the frame)", () => {
    expect(() => inspectAwarenessUpdate(new Uint8Array([0xff]), new Set())).toThrow();
  });
});
