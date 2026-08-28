/**
 * #1 sync reconnection (2026-06-15 audit): a dropped socket used to leave the
 * transport permanently "connected" with frames piling into a dead outbox.
 * These cover the WebSocketTransport backoff/reconnect machinery and the
 * CollabConnection re-handshake + status signal it drives.
 */
import { describe, it, expect } from "vitest";
import { Doc } from "yjs";
import { CollabConnection } from "./collab-connection.js";
import type { ConnectionStatus } from "./collab-connection.js";
import { WebSocketTransport } from "./websocket-transport.js";
import type { WebSocketLike, SchedulerLike } from "./websocket-transport.js";
import type { Transport, TransportStatus } from "./transport.js";

const bytes = (...n: number[]) => new Uint8Array(n);

/** A WebSocketLike whose lifecycle events are driven by the test. */
class FakeSocket implements WebSocketLike {
  readyState = 0; // CONNECTING
  binaryType = "";
  sent: Uint8Array[] = [];
  closed = false;
  private listeners: Record<string, ((e: unknown) => void)[]> = {};
  send(d: Uint8Array): void {
    this.sent.push(d);
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(type: string, l: (e: unknown) => void): void {
    (this.listeners[type] ??= []).push(l);
  }
  removeEventListener(type: string, l: (e: unknown) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((x) => x !== l);
  }
  private dispatch(type: string, e?: unknown): void {
    for (const l of [...(this.listeners[type] ?? [])]) l(e);
  }
  open(): void {
    this.readyState = 1;
    this.dispatch("open");
  }
  drop(): void {
    this.readyState = 3;
    this.dispatch("close");
  }
}

/** A scheduler the test fires by hand; records the delays requested. */
class ManualScheduler implements SchedulerLike {
  delays: number[] = [];
  private tasks: { id: number; fn: () => void }[] = [];
  private nextId = 1;
  setTimeout(fn: () => void, ms: number): unknown {
    this.delays.push(ms);
    const id = this.nextId++;
    this.tasks.push({ id, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.tasks = this.tasks.filter((t) => t.id !== handle);
  }
  get pending(): number {
    return this.tasks.length;
  }
  runNext(): void {
    const t = this.tasks.shift();
    t?.fn();
  }
}

function makeTransport(opts?: ConstructorParameters<typeof WebSocketTransport>[1]) {
  const sockets: FakeSocket[] = [];
  const t = new WebSocketTransport(() => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  }, opts);
  return { t, sockets };
}

describe("WebSocketTransport reconnection", () => {
  it("buffers sends until open, then flushes", () => {
    const { t, sockets } = makeTransport();
    t.connect();
    t.send(bytes(1));
    expect(sockets[0]!.sent).toEqual([]); // buffered (socket not open)
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([bytes(1)]); // flushed on open
  });

  it("reconnects with backoff after an unexpected drop and re-emits open", () => {
    const sched = new ManualScheduler();
    const { t, sockets } = makeTransport({ scheduler: sched, reconnect: { baseDelayMs: 100 } });
    const statuses: TransportStatus[] = [];
    t.onStatus((s) => statuses.push(s));
    t.connect();
    sockets[0]!.open();
    expect(statuses).toEqual(["open"]);
    sockets[0]!.drop();
    expect(statuses).toEqual(["open", "closed"]);
    expect(sched.pending).toBe(1); // a reconnect is scheduled
    sched.runNext(); // fire backoff → opens a NEW socket
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(statuses).toEqual(["open", "closed", "open"]);
  });

  it("does NOT reconnect after an intentional disconnect", () => {
    const sched = new ManualScheduler();
    const { t, sockets } = makeTransport({ scheduler: sched });
    t.connect();
    sockets[0]!.open();
    t.disconnect();
    expect(sockets[0]!.closed).toBe(true);
    sockets[0]!.drop(); // the real socket's close fires after our close()
    expect(sched.pending).toBe(0); // no reconnect scheduled
    expect(sockets).toHaveLength(1);
  });

  it("backs off exponentially up to the cap", () => {
    const sched = new ManualScheduler();
    const { t, sockets } = makeTransport({
      scheduler: sched,
      reconnect: { baseDelayMs: 100, factor: 2, maxDelayMs: 350 },
    });
    t.connect();
    sockets[0]!.drop(); // attempt 0 → 100
    sched.runNext();
    sockets[1]!.drop(); // attempt 1 → 200
    sched.runNext();
    sockets[2]!.drop(); // attempt 2 → 400, capped to 350
    expect(sched.delays).toEqual([100, 200, 350]);
  });

  it("resets the backoff after a successful open", () => {
    const sched = new ManualScheduler();
    const { t, sockets } = makeTransport({ scheduler: sched, reconnect: { baseDelayMs: 100 } });
    t.connect();
    sockets[0]!.drop(); // → 100
    sched.runNext();
    sockets[1]!.open(); // clean open resets attempt
    sockets[1]!.drop(); // attempt back to 0 → 100 again
    expect(sched.delays).toEqual([100, 100]);
  });

  it("bounds the outbox while down (drops the oldest)", () => {
    const { t, sockets } = makeTransport({ reconnect: { maxOutboxFrames: 2 } });
    t.connect();
    t.send(bytes(1));
    t.send(bytes(2));
    t.send(bytes(3)); // cap 2 → bytes(1) dropped
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([bytes(2), bytes(3)]);
  });

  // L6 — "Retry now": force an immediate reconnect instead of waiting on backoff.
  it("retryNow() cancels the pending backoff and reopens immediately", () => {
    const sched = new ManualScheduler();
    const { t, sockets } = makeTransport({ scheduler: sched, reconnect: { baseDelayMs: 100 } });
    const statuses: TransportStatus[] = [];
    t.onStatus((s) => statuses.push(s));
    t.connect();
    sockets[0]!.open();
    sockets[0]!.drop();
    expect(sched.pending).toBe(1); // a backoff reconnect is scheduled
    t.retryNow();
    expect(sched.pending).toBe(0); // the pending backoff timer was cancelled
    expect(sockets).toHaveLength(2); // reopened right away, not after the delay
    sockets[1]!.open();
    expect(statuses).toEqual(["open", "closed", "open"]);
  });

  it("retryNow() resets the backoff so a later drop starts from base again", () => {
    const sched = new ManualScheduler();
    const { t, sockets } = makeTransport({
      scheduler: sched,
      reconnect: { baseDelayMs: 100, factor: 2 },
    });
    t.connect();
    sockets[0]!.drop(); // attempt 0 → 100
    sched.runNext();
    sockets[1]!.drop(); // attempt 1 → 200
    expect(sched.delays).toEqual([100, 200]);
    t.retryNow(); // cancels the 200 timer, reopens, resets attempt to 0
    sockets[2]!.drop(); // attempt 0 again → 100
    expect(sched.delays).toEqual([100, 200, 100]);
  });

  it("retryNow() is a no-op while a socket is live (connecting/open)", () => {
    const { t, sockets } = makeTransport();
    t.connect();
    sockets[0]!.open();
    t.retryNow();
    expect(sockets).toHaveLength(1); // already connected → no new socket
  });

  it("retryNow() is a no-op after an intentional disconnect", () => {
    const { t, sockets } = makeTransport();
    t.connect();
    sockets[0]!.open();
    t.disconnect();
    t.retryNow();
    expect(sockets).toHaveLength(1); // we don't want a connection → stays down
  });
});

/** A transport whose status stream the test drives directly. */
class FakeTransport implements Transport {
  sent: Uint8Array[] = [];
  retries = 0;
  private statusH = new Set<(s: TransportStatus) => void>();
  send(d: Uint8Array): void {
    this.sent.push(d);
  }
  onMessage(): () => void {
    return () => {};
  }
  connect(): void {}
  disconnect(): void {}
  retryNow(): void {
    this.retries += 1;
  }
  onStatus(h: (s: TransportStatus) => void): () => void {
    this.statusH.add(h);
    return () => this.statusH.delete(h);
  }
  emit(s: TransportStatus): void {
    for (const h of [...this.statusH]) h(s);
  }
}

describe("CollabConnection reconnect handshake", () => {
  it("re-runs the sync handshake on a reconnect (not on the first open)", () => {
    const tr = new FakeTransport();
    const conn = new CollabConnection({ doc: new Doc() }, tr);
    conn.connect();
    const afterConnect = tr.sent.length; // handshake queued synchronously
    expect(afterConnect).toBeGreaterThan(0);
    tr.emit("open"); // first open: handshake already queued, no re-send
    expect(tr.sent.length).toBe(afterConnect);
    tr.emit("closed");
    tr.emit("open"); // reconnect: re-handshake
    expect(tr.sent.length).toBeGreaterThan(afterConnect);
    conn.destroy();
  });

  it("surfaces connected/disconnected to onStatus across a reconnect", () => {
    const tr = new FakeTransport();
    const conn = new CollabConnection({ doc: new Doc() }, tr);
    const seen: ConnectionStatus[] = [];
    conn.onStatus((s) => seen.push(s));
    conn.connect();
    tr.emit("open");
    tr.emit("closed");
    tr.emit("open");
    expect(seen).toEqual(["connected", "disconnected", "connected"]);
    conn.destroy();
  });

  it("retryNow() delegates to the transport (L6 'Retry now')", () => {
    const tr = new FakeTransport();
    const conn = new CollabConnection({ doc: new Doc() }, tr);
    conn.retryNow();
    conn.retryNow();
    expect(tr.retries).toBe(2);
    conn.destroy();
  });

  it("retryNow() is a safe no-op when the transport has no retryNow", () => {
    // A stable in-process transport (e.g. InMemoryNetwork) omits retryNow.
    const tr: Transport = {
      send() {},
      onMessage: () => () => {},
      connect() {},
      disconnect() {},
    };
    const conn = new CollabConnection({ doc: new Doc() }, tr);
    expect(() => conn.retryNow()).not.toThrow();
    conn.destroy();
  });
});
