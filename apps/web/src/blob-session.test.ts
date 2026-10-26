import { describe, it, expect } from "vitest";
import {
  sha256Hex,
  encodeFrame,
  decodeFrame,
  buildBlobTerminalAuth,
  type WebSocketLike,
  type BlobStore,
  type SchedulerLike,
  type HeaderFrame,
} from "@galley/collab";
import { PersistentBlobStore, InMemoryBlobBackend } from "./idb-blob-store.js";
import { createBlobChannelSession } from "./blob-session.js";

const TERMINAL_SCOPE = {
  grantId: "g",
  controlRoom: "ctl",
  syncUrl: "ws://x",
  projectId: "proj-1",
  shareRoom: "share-1",
};
const RESPONSE_KEY = new Uint8Array(32).map((_, i) => (i * 11) & 0xff);

/**
 * An in-memory pair of blob sockets that forwards each side's sends to the OTHER
 * — the relay's 2-peer room semantics, without depending on `@galley/sync` (not a
 * dep of `@galley/web`). The real relay round-trip is covered by the sync test;
 * here we prove the browser session bridges the transport to a PersistentBlobStore.
 */
function makePair(): {
  a: WebSocketLike;
  b: WebSocketLike;
  flush: () => Promise<void>;
} {
  const queue: Array<() => void> = [];
  function endpoint() {
    const listeners = new Map<string, Set<(e: unknown) => void>>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self: any = {
      readyState: 1,
      binaryType: "arraybuffer",
      send(d: Uint8Array) {
        const peer = self._peer;
        const copy = d.slice();
        queue.push(() => peer?._emit?.("message", { data: copy.buffer }));
      },
      close() {
        queue.push(() => self._emit?.("close", {}));
      },
      addEventListener(t: string, l: (e: unknown) => void) {
        if (!listeners.has(t)) listeners.set(t, new Set());
        listeners.get(t)!.add(l);
        if (t === "open") queue.push(() => l({}));
      },
      removeEventListener(t: string, l: (e: unknown) => void) {
        listeners.get(t)?.delete(l);
      },
    };
    self._emit = (t: string, e: unknown) => {
      for (const l of [...(listeners.get(t) ?? [])]) l(e);
    };
    return self;
  }
  const a = endpoint();
  const b = endpoint();
  a._peer = b;
  b._peer = a;
  async function flush(): Promise<void> {
    // Drain queued deliveries, then keep yielding macrotasks until the queue has
    // stayed empty across several CONSECUTIVE ticks — long enough for an in-flight
    // async WebCrypto chain (terminal-auth HMAC sign/verify) to settle and enqueue
    // its frame, even on a slow CI runner. A single trailing yield races that chain.
    let idle = 0;
    for (let i = 0; i < 5000; i++) {
      if (queue.length > 0) {
        idle = 0;
        const job = queue.shift()!;
        job();
      } else if (++idle >= 10) {
        break;
      }
      await new Promise((r) => globalThis.setTimeout(r, 0));
    }
  }
  return { a, b, flush };
}

function hostedFixture(
  reply: (header: HeaderFrame, attempt: number) => string | null | undefined,
) {
  const peer = makePair(),
    hosted = makePair();
  const attempts = new Map<string, number>();
  const transferIds = new Set<string>();
  const inbound = new Map<string, HeaderFrame>();
  const stored = new Map<string, number[]>();
  const timers = new Map<number, () => void>();
  const delays: number[] = [];
  let nextTimer = 0,
    connections = 0,
    errors = 0;
  const scheduler: SchedulerLike = {
    setTimeout(fn, ms) {
      delays.push(ms);
      timers.set(++nextTimer, fn);
      return nextTimer;
    },
    clearTimeout(timer) {
      timers.delete(timer as number);
    },
  };
  hosted.b.addEventListener("message", (event) => {
    const frame = decodeFrame(
      new Uint8Array((event as { data: ArrayBuffer }).data),
    );
    if (!frame) return;
    if (frame.kind === "header") {
      // An already-open fake socket also emits its queued open notification;
      // retransmission of that same transfer is not a new persist attempt.
      if (transferIds.has(frame.transferId)) return;
      transferIds.add(frame.transferId);
      const attempt = (attempts.get(frame.hash) ?? 0) + 1;
      attempts.set(frame.hash, attempt);
      const reason = reply(frame, attempt);
      if (typeof reason === "string") {
        hosted.b.send(
          encodeFrame({ kind: "abort", transferId: frame.transferId, reason }),
        );
      } else if (reason === undefined) inbound.set(frame.transferId, frame);
    } else if (frame.kind === "data") {
      const header = inbound.get(frame.transferId);
      if (!header) return;
      stored.set(header.hash, [...frame.bytes]);
      hosted.b.send(
        encodeFrame({
          kind: "complete",
          transferId: frame.transferId,
          hash: header.hash,
          size: header.size,
        }),
      );
      inbound.delete(frame.transferId);
    }
  });
  const session = createBlobChannelSession(
    "ws://x",
    "hosted",
    new PersistentBlobStore(new InMemoryBlobBackend()),
    {
      hosted: true,
      socketFactory: () => peer.a,
      hostedSocketFactory: () => {
        connections++;
        return hosted.a;
      },
      hostedRetryScheduler: scheduler,
      onHostedStorageError: () => {
        errors++;
      },
    },
  );
  session.connect();
  return {
    session,
    attempts,
    stored,
    delays,
    flush: hosted.flush,
    get pendingTimers() {
      return timers.size;
    },
    get connections() {
      return connections;
    },
    get errors() {
      return errors;
    },
    retry() {
      const entry = timers.entries().next().value;
      if (!entry) throw new Error("No pending hosted retry");
      const [id, fn] = entry;
      timers.delete(id);
      fn();
    },
  };
}

describe("hosted upload admission retry", () => {
  it("makes progress for four concurrent assets after explicit busy without reconnecting", async () => {
    const busyHashes = new Set<string>();
    const fixture = hostedFixture((header, attempt) =>
      busyHashes.has(header.hash) && attempt === 1
        ? "Hosted storage busy"
        : undefined,
    );
    try {
      const assets = await Promise.all(
        [1, 2, 3, 4].map(async (value) => {
          const bytes = new Uint8Array([value, 5, 6, 7]);
          return { bytes, hash: await sha256Hex(bytes) };
        }),
      );
      for (const asset of assets.slice(2)) busyHashes.add(asset.hash);
      const persisted = assets.map((asset) =>
        fixture.session.persist!(asset.bytes, asset.hash, "image/png"),
      );
      await fixture.flush();
      expect(fixture.pendingTimers).toBe(2);
      expect(fixture.errors).toBe(0);
      assets[2]!.bytes.fill(0);
      while (fixture.pendingTimers) {
        fixture.retry();
        await fixture.flush();
      }
      await Promise.all(persisted);
      expect(assets.map((asset) => fixture.attempts.get(asset.hash))).toEqual([
        1, 1, 2, 2,
      ]);
      expect(fixture.stored.get(assets[2]!.hash)).toEqual([3, 5, 6, 7]);
      expect(fixture.stored.size).toBe(4);
      expect(fixture.connections).toBe(1);
      expect(fixture.errors).toBe(0);
    } finally {
      fixture.session.destroy();
    }
  });

  it("bounds persistent busy and reports the terminal storage error once", async () => {
    const fixture = hostedFixture(() => "Hosted storage busy");
    try {
      const bytes = new Uint8Array([1, 2, 3]);
      const hash = await sha256Hex(bytes);
      const outcome = fixture.session.persist!(bytes, hash, "image/png").catch(
        (error) => error,
      );
      await fixture.flush();
      while (fixture.pendingTimers) {
        fixture.retry();
        await fixture.flush();
      }
      expect(await outcome).toEqual(
        new Error("receiver aborted: Hosted storage busy"),
      );
      expect(fixture.attempts.get(hash)).toBe(8);
      expect(fixture.delays).toEqual([250, 500, 1000, 2000, 2000, 2000, 2000]);
      expect(fixture.errors).toBe(1);
      expect(fixture.pendingTimers).toBe(0);
    } finally {
      fixture.session.destroy();
    }
  });

  it.each([
    "Hosted storage quota exceeded",
    "store-failed",
    "Hosted storage unavailable",
    "hosted storage busy",
  ])("does not retry terminal %s", async (reason) => {
    const fixture = hostedFixture(() => reason);
    try {
      const bytes = new Uint8Array([1, 2, 3]),
        hash = await sha256Hex(bytes);
      const outcome = fixture.session.persist!(bytes, hash, "image/png").catch(
        (error) => error,
      );
      await fixture.flush();
      expect(await outcome).toEqual(new Error(`receiver aborted: ${reason}`));
      expect(fixture.attempts.get(hash)).toBe(1);
      expect(fixture.pendingTimers).toBe(0);
      expect(fixture.errors).toBe(1);
    } finally {
      fixture.session.destroy();
    }
  });

  it("destroy cancels waiting and in-flight work and prevents later retries", async () => {
    let busyHash = "";
    const fixture = hostedFixture((header) =>
      header.hash === busyHash ? "Hosted storage busy" : null,
    );
    const bytes = new Uint8Array([1, 2, 3]);
    busyHash = await sha256Hex(bytes);
    const second = new Uint8Array([4, 5, 6]),
      secondHash = await sha256Hex(second);
    const outcomes = [
      fixture.session.persist!(bytes, busyHash, "image/png"),
      fixture.session.persist!(second, secondHash, "image/png"),
    ].map((promise) => promise.catch((error) => error));
    await fixture.flush();
    expect(fixture.pendingTimers).toBe(1);
    fixture.session.destroy();
    expect(await Promise.all(outcomes)).toEqual([
      new Error("blob channel destroyed"),
      new Error("blob channel destroyed"),
    ]);
    expect(fixture.pendingTimers).toBe(0);
    expect(fixture.errors).toBe(0);
    await expect(
      fixture.session.persist!(bytes, busyHash, "image/png"),
    ).rejects.toThrow("blob channel destroyed");
    fixture.session.connect();
    await fixture.flush();
    expect(fixture.connections).toBe(1);
    expect([...fixture.attempts.values()]).toEqual([1, 1]);
  });
});

describe("browser blob-session", () => {
  it("stores a VERIFIED inbound blob into the PersistentBlobStore", async () => {
    const { a, b, flush } = makePair();
    const backend = new InMemoryBlobBackend();
    const store: BlobStore = new PersistentBlobStore(backend);
    const session = createBlobChannelSession("ws://x", "room", store, {
      socketFactory: () => b,
    });
    // A bare sender on the OTHER end of the pair pushes a blob into the session.
    const senderStore = new PersistentBlobStore(new InMemoryBlobBackend());
    const sender = createBlobChannelSession("ws://x", "room", senderStore, {
      socketFactory: () => a,
    });
    session.connect();
    sender.connect();
    await flush();

    const bytes = new Uint8Array(300 * 1024).map((_, i) => (i * 7) & 0xff);
    const hash = await sha256Hex(bytes);
    session.expect(hash, bytes.length); // §E13: the receiver must opt in
    const p = sender.send(bytes, hash, "image/png").done;
    await flush();
    await p;

    expect(await store.has(hash)).toBe(true);
    const got = await store.get(hash);
    expect(got).toEqual(bytes);

    session.destroy();
    sender.destroy();
  });

  it("stores a verified inbound blob NEUTRAL — isServable stays false (received bytes are a non-re-servable cache)", async () => {
    const { a, b, flush } = makePair();
    const store: BlobStore = new PersistentBlobStore(new InMemoryBlobBackend());
    const session = createBlobChannelSession("ws://x", "room", store, {
      socketFactory: () => b,
    });
    const sender = createBlobChannelSession(
      "ws://x",
      "room",
      new PersistentBlobStore(new InMemoryBlobBackend()),
      {
        socketFactory: () => a,
      },
    );
    session.connect();
    sender.connect();
    await flush();

    const bytes = new Uint8Array(128 * 1024).map((_, i) => (i * 3) & 0xff);
    const hash = await sha256Hex(bytes);
    session.expect(hash, bytes.length);
    const p = sender.send(bytes, hash, "image/png").done;
    await flush();
    await p;

    // Bytes landed (renderable/exportable locally)...
    expect(await store.has(hash)).toBe(true);
    // ...but the channel's `put` NEVER grants a servable marker: this device did not
    // locally provenance these bytes, so it must not re-serve them (non-transitivity).
    expect(await store.isServable(hash)).toBe(false);

    session.destroy();
    sender.destroy();
  });

  it("A2/C1a: fires onInboundStored with {hash,size} after a verified blob is stored", async () => {
    const { a, b, flush } = makePair();
    const store: BlobStore = new PersistentBlobStore(new InMemoryBlobBackend());
    const delivered: { hash: string; size: number }[] = [];
    const session = createBlobChannelSession("ws://x", "room", store, {
      socketFactory: () => b,
      onInboundStored: (hash, size) => delivered.push({ hash, size }),
    });
    const sender = createBlobChannelSession(
      "ws://x",
      "room",
      new PersistentBlobStore(new InMemoryBlobBackend()),
      {
        socketFactory: () => a,
      },
    );
    session.connect();
    sender.connect();
    await flush();

    const bytes = new Uint8Array(64 * 1024).map((_, i) => (i * 5) & 0xff);
    const hash = await sha256Hex(bytes);
    session.expect(hash, bytes.length);
    const p = sender.send(bytes, hash, "image/png").done;
    await flush();
    await p;

    expect(delivered).toEqual([{ hash, size: bytes.length }]);
    session.destroy();
    sender.destroy();
  });

  it("DISCARDS an unexpected inbound blob (no expect → not stored, §E13)", async () => {
    const { a, b, flush } = makePair();
    const backend = new InMemoryBlobBackend();
    const store: BlobStore = new PersistentBlobStore(backend);
    const session = createBlobChannelSession("ws://x", "room", store, {
      socketFactory: () => b,
    });
    const sender = createBlobChannelSession(
      "ws://x",
      "room",
      new PersistentBlobStore(new InMemoryBlobBackend()),
      {
        socketFactory: () => a,
      },
    );
    session.connect();
    sender.connect();
    await flush();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const hash = await sha256Hex(bytes);
    // No session.expect(...) → the push is rejected and nothing is stored.
    const handle = sender.send(bytes, hash, "image/png");
    const assert = expect(handle.done).rejects.toThrow(/unexpected|aborted/);
    await flush();
    await assert;
    expect(await store.has(hash)).toBe(false);
    session.destroy();
    sender.destroy();
  });

  it("send() pushes a local blob to the room's other peer's store", async () => {
    const { a, b, flush } = makePair();
    const recvBackend = new InMemoryBlobBackend();
    const receiver = createBlobChannelSession(
      "ws://x",
      "push",
      new PersistentBlobStore(recvBackend),
      {
        socketFactory: () => b,
      },
    );
    const sender = createBlobChannelSession(
      "ws://x",
      "push",
      new PersistentBlobStore(new InMemoryBlobBackend()),
      {
        socketFactory: () => a,
      },
    );
    receiver.connect();
    sender.connect();
    await flush();

    const bytes = new Uint8Array([10, 20, 30, 40, 50]);
    const hash = await sha256Hex(bytes);
    receiver.expect(hash, bytes.length);
    const handle = sender.send(bytes, hash, "application/octet-stream");
    await flush();
    await expect(handle.done).resolves.toBeUndefined();
    expect(await recvBackend.has(hash)).toBe(true);

    receiver.destroy();
    sender.destroy();
  });

  it("A1 §1: `authenticated` is true with a terminalVerifier, false without", () => {
    const auth = buildBlobTerminalAuth(RESPONSE_KEY, TERMINAL_SCOPE);
    const advisory = createBlobChannelSession(
      "ws://x",
      "r",
      new PersistentBlobStore(new InMemoryBlobBackend()),
      {
        socketFactory: () => makePair().a,
      },
    );
    expect(advisory.authenticated).toBe(false);
    const authed = createBlobChannelSession(
      "ws://x",
      "r",
      new PersistentBlobStore(new InMemoryBlobBackend()),
      {
        socketFactory: () => makePair().a,
        terminalSigner: auth.terminalSigner,
        terminalVerifier: auth.terminalVerifier,
      },
    );
    expect(authed.authenticated).toBe(true);
    advisory.destroy();
    authed.destroy();
  });

  it("A1 §1: the SENDER with terminalVerifier does NOT resolve on a FORGED (unsigned) COMPLETE", async () => {
    // The browser is the SENDER of the exported PDF. With the grant-scoped terminal
    // verifier wired, a 3rd peer's forged/unsigned COMPLETE must NOT resolve the
    // push — so the browser never returns the export descriptor (fails closed).
    const { a, b, flush } = makePair();
    const auth = buildBlobTerminalAuth(RESPONSE_KEY, TERMINAL_SCOPE);
    const browser = createBlobChannelSession(
      "ws://x",
      "share-1",
      new PersistentBlobStore(new InMemoryBlobBackend()),
      {
        socketFactory: () => a,
        terminalSigner: auth.terminalSigner,
        terminalVerifier: auth.terminalVerifier,
      },
    );
    browser.connect();
    await flush();

    const bytes = new Uint8Array([1, 2, 3]);
    const hash = await sha256Hex(bytes);
    const handle = browser.send(bytes, hash, "application/pdf", {
      transferId: "exp-1",
    });
    let resolved = false;
    let rejected = false;
    void handle.done.then(
      () => (resolved = true),
      () => (rejected = true),
    );
    // A 3rd peer (on socket b) injects a FORGED, unsigned COMPLETE for the transfer.
    b.send(
      encodeFrame({
        kind: "complete",
        transferId: "exp-1",
        hash,
        size: bytes.length,
      }),
    );
    await flush();
    // The enforcing sender IGNORES it — the push neither resolves nor (spuriously)
    // rejects on the forged frame; it stays pending (would fail closed via timeout).
    expect(resolved).toBe(false);
    expect(rejected).toBe(false);
    browser.destroy();
  });

  it("A1 §1: the SENDER with terminalVerifier RESOLVES on a correctly-SIGNED COMPLETE", async () => {
    // The genuine RECEIVER (the kernel, here mirrored) signs its COMPLETE with the
    // SAME grant key → the browser sender accepts it and the push resolves.
    const { a, b, flush } = makePair();
    const auth = buildBlobTerminalAuth(RESPONSE_KEY, TERMINAL_SCOPE);
    const browser = createBlobChannelSession(
      "ws://x",
      "share-1",
      new PersistentBlobStore(new InMemoryBlobBackend()),
      {
        socketFactory: () => a,
        terminalSigner: auth.terminalSigner,
        terminalVerifier: auth.terminalVerifier,
      },
    );
    // The receiver holds the SAME key (it signs its COMPLETE) + opts in to the blob.
    const receiver = createBlobChannelSession(
      "ws://x",
      "share-1",
      new PersistentBlobStore(new InMemoryBlobBackend()),
      {
        socketFactory: () => b,
        terminalSigner: auth.terminalSigner,
        terminalVerifier: auth.terminalVerifier,
      },
    );
    browser.connect();
    receiver.connect();
    await flush();
    const bytes = new Uint8Array([7, 8, 9]);
    const hash = await sha256Hex(bytes);
    receiver.expect(hash, bytes.length);
    const handle = browser.send(bytes, hash, "application/pdf", {
      transferId: "exp-2",
    });
    await flush();
    await expect(handle.done).resolves.toBeUndefined();
    browser.destroy();
    receiver.destroy();
  });

  it("does not store a tampered transfer (verify gate)", async () => {
    const { a, b, flush } = makePair();
    const backend = new InMemoryBlobBackend();
    const session = createBlobChannelSession(
      "ws://x",
      "r",
      new PersistentBlobStore(backend),
      {
        socketFactory: () => b,
      },
    );
    session.connect();
    await flush();
    // Raw lying frames straight onto the wire: announce a hash, ship other bytes.
    // EXPECT the lied hash so it passes the acceptance gate — the VERIFY gate must
    // still reject the tampered bytes.
    const honest = new Uint8Array([1, 2, 3, 4]);
    const liedHash = await sha256Hex(honest);
    session.expect(liedHash, 4);
    a.send(
      encodeFrame({
        kind: "header",
        transferId: "x",
        hash: liedHash,
        size: 4,
        mime: "x",
        totalChunks: 1,
      }),
    );
    a.send(
      encodeFrame({
        kind: "data",
        transferId: "x",
        index: 0,
        bytes: new Uint8Array([4, 3, 2, 1]),
      }),
    );
    await flush();
    expect(await backend.has(liedHash)).toBe(false);

    session.destroy();
  });
});
