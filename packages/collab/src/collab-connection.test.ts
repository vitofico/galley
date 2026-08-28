/**
 * B2 storage-full control frame (messageStorageFull = 4). The relay emits this
 * as its OWN ws frame when it refuses a growth write; CollabConnection decodes
 * reason + cap and surfaces it via onStorageFull WITHOUT touching the doc or
 * awareness (a storage frame is not peer activity — it must never bump the L6
 * stale timer, which keys on origin === connection doc/awareness updates).
 */
import { describe, it, expect } from "vitest";
import { Doc } from "yjs";
import * as encoding from "lib0/encoding";
import { CollabConnection } from "./collab-connection.js";
import type { StorageFullInfo } from "./collab-connection.js";
import type { Transport, TransportStatus } from "./transport.js";

/** A transport whose inbound frames + status the test drives by hand. */
class DriveTransport implements Transport {
  sent: Uint8Array[] = [];
  private readonly msgH = new Set<(d: Uint8Array) => void>();
  private readonly statusH = new Set<(s: TransportStatus) => void>();
  send(d: Uint8Array): void {
    this.sent.push(d);
  }
  onMessage(h: (d: Uint8Array) => void): () => void {
    this.msgH.add(h);
    return () => this.msgH.delete(h);
  }
  connect(): void {}
  disconnect(): void {}
  onStatus(h: (s: TransportStatus) => void): () => void {
    this.statusH.add(h);
    return () => this.statusH.delete(h);
  }
  /** Deliver a raw inbound frame to the connection's message handler. */
  deliver(d: Uint8Array): void {
    for (const h of [...this.msgH]) h(d);
  }
}

const MSG_STORAGE_FULL = 4;

/** Encode a storage-full frame exactly as the relay does: varints [4, reason, cap]. */
function storageFrame(reason: number, cap: number): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MSG_STORAGE_FULL);
  encoding.writeVarUint(e, reason);
  encoding.writeVarUint(e, cap);
  return encoding.toUint8Array(e);
}

describe("CollabConnection — storage-full control frame (B2)", () => {
  it("maps reason 1/2/3 to content-cap/log-ceiling/quota-unavailable and carries the cap", () => {
    const tr = new DriveTransport();
    const conn = new CollabConnection({ doc: new Doc() }, tr);
    const seen: StorageFullInfo[] = [];
    conn.onStorageFull((i) => seen.push(i));
    conn.connect();
    tr.deliver(storageFrame(1, 1_000_000));
    tr.deliver(storageFrame(2, 4_000_000));
    tr.deliver(storageFrame(3, 0));
    expect(seen).toEqual([
      { reason: "content-cap", capBytes: 1_000_000 },
      { reason: "log-ceiling", capBytes: 4_000_000 },
      { reason: "quota-unavailable", capBytes: 0 },
    ]);
    conn.destroy();
  });

  it("maps an UNKNOWN reason (open enum) to 'unknown' but still carries the cap", () => {
    const tr = new DriveTransport();
    const conn = new CollabConnection({ doc: new Doc() }, tr);
    const seen: StorageFullInfo[] = [];
    conn.onStorageFull((i) => seen.push(i));
    conn.connect();
    tr.deliver(storageFrame(7, 123));
    expect(seen).toEqual([{ reason: "unknown", capBytes: 123 }]);
    conn.destroy();
  });

  it("ignores a truncated frame fail-soft: no throw, no listener call", () => {
    const tr = new DriveTransport();
    const conn = new CollabConnection({ doc: new Doc() }, tr);
    const seen: StorageFullInfo[] = [];
    conn.onStorageFull((i) => seen.push(i));
    conn.connect();
    // type byte only (no reason, no cap)
    const typeOnly = encoding.createEncoder();
    encoding.writeVarUint(typeOnly, MSG_STORAGE_FULL);
    expect(() => tr.deliver(encoding.toUint8Array(typeOnly))).not.toThrow();
    // type + reason, missing cap
    const noCap = encoding.createEncoder();
    encoding.writeVarUint(noCap, MSG_STORAGE_FULL);
    encoding.writeVarUint(noCap, 1);
    expect(() => tr.deliver(encoding.toUint8Array(noCap))).not.toThrow();
    expect(seen).toEqual([]); // fail-soft: never fired for either truncation
    conn.destroy();
  });

  it("does NOT disturb the doc, awareness, or synced state (no liveness side effect)", () => {
    const tr = new DriveTransport();
    const doc = new Doc();
    const conn = new CollabConnection({ doc }, tr);
    conn.connect();
    // Any doc/awareness 'update' with origin === conn would bump the L6 stale
    // timer — a storage frame must produce NEITHER. Attach AFTER connect so the
    // handshake's own awareness set is not counted.
    let docUpdatesFromConn = 0;
    let awUpdatesFromConn = 0;
    doc.on("update", (_u: Uint8Array, origin: unknown) => {
      if (origin === conn) docUpdatesFromConn += 1;
    });
    conn.awareness.on("update", (_c: unknown, origin: unknown) => {
      if (origin === conn) awUpdatesFromConn += 1;
    });
    const sentBefore = tr.sent.length;
    const syncedBefore = conn.synced;
    tr.deliver(storageFrame(1, 500));
    expect(docUpdatesFromConn).toBe(0);
    expect(awUpdatesFromConn).toBe(0);
    expect(tr.sent.length).toBe(sentBefore); // the case replies with nothing
    expect(conn.synced).toBe(syncedBefore); // a storage frame never marks synced
    conn.destroy();
  });

  it("still routes a normal queryAwareness frame after the storage case was added", () => {
    // Regression guard: adding case 4 must not break the switch's other types.
    // A queryAwareness (type 3) frame makes the connection reply with its state.
    const tr = new DriveTransport();
    const conn = new CollabConnection({ doc: new Doc() }, tr);
    conn.connect();
    // First deliver a storage frame, then a normal query — the query must still
    // produce a reply (proving handleMessage kept routing after the new case).
    tr.deliver(storageFrame(1, 1));
    const before = tr.sent.length;
    const q = encoding.createEncoder();
    encoding.writeVarUint(q, 3); // messageQueryAwareness
    tr.deliver(encoding.toUint8Array(q));
    expect(tr.sent.length).toBeGreaterThan(before);
    conn.destroy();
  });

  it("onStorageFull returns an unsubscribe that stops further deliveries", () => {
    const tr = new DriveTransport();
    const conn = new CollabConnection({ doc: new Doc() }, tr);
    const seen: StorageFullInfo[] = [];
    const off = conn.onStorageFull((i) => seen.push(i));
    conn.connect();
    tr.deliver(storageFrame(1, 1));
    off();
    tr.deliver(storageFrame(1, 2));
    expect(seen).toEqual([{ reason: "content-cap", capBytes: 1 }]);
    conn.destroy();
  });
});
