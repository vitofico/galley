import { describe, it, expect } from "vitest";
import { BlobTransport, buildBlobTerminalAuth, type ReceivedBlob } from "./blob-transport.js";
import { sha256Hex } from "./binary-assets.js";
import { encodeFrame, BLOB_CHUNK_BYTES, BLOB_MAX_INFLIGHT_TRANSFERS } from "./blob-protocol.js";
import type { WebSocketLike } from "./websocket-transport.js";

const TERMINAL_SCOPE = {
  grantId: "g",
  controlRoom: "c",
  syncUrl: "ws://r",
  projectId: "p",
  shareRoom: "s",
};
const TERMINAL_KEY = new Uint8Array(32).map((_, i) => (i * 7) & 0xff);

/**
 * An in-memory pair of sockets forwarding each side's sends to the OTHER — the
 * relay's 2-peer room semantics. `flush` drains the queue, yielding a real
 * macrotask between jobs so the async verify (sha256) + store + COMPLETE all
 * settle. A test can also inject hostile frames straight onto an endpoint.
 */
function makePair(): { a: WebSocketLike; b: WebSocketLike; flush: () => Promise<void> } {
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
        // Fire 'open' to THIS listener on the next flush tick whenever a consumer
        // binds one — so connect() AND a later reconnect both see an open (a real
        // socket fires open on each successful connection).
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
    // async WebCrypto chain (receiver verify sha256 → sign COMPLETE; sender verify
    // MAC) to settle and enqueue its frame, even on a slow CI runner. A single
    // trailing yield races that chain and can strand the COMPLETE (flaky).
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

const fastSweep = {
  setTimeout: (fn: () => void) => globalThis.setTimeout(fn, 0),
  clearTimeout: (h: unknown) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

describe("BlobTransport — honest completion (§A)", () => {
  it("resolves a push ONLY after the receiver verified + stored (COMPLETE)", async () => {
    const { a, b, flush } = makePair();
    const received: ReceivedBlob[] = [];
    const stored: string[] = [];
    const sender = new BlobTransport(() => a);
    const receiver = new BlobTransport(() => b, {
      onBlob: async (blob) => {
        await new Promise((r) => globalThis.setTimeout(r, 0)); // async store
        stored.push(blob.hash);
        received.push(blob);
      },
    });
    sender.connect();
    receiver.connect();
    await flush();

    const bytes = new Uint8Array(BLOB_CHUNK_BYTES * 2 + 123).map((_, i) => (i * 13) & 0xff);
    const hash = await sha256Hex(bytes);
    receiver.expect(hash, bytes.length);
    const handle = sender.send(bytes, hash, "application/octet-stream");
    await flush();

    await expect(handle.done).resolves.toBeUndefined();
    expect(stored).toEqual([hash]); // store ran before COMPLETE → done
    expect(received[0]!.bytes).toEqual(bytes);
    expect(sender.outboundCount).toBe(0);
    expect(receiver.inboundCount).toBe(0);
    expect(receiver.expectationCount).toBe(0);
  });

  it("delivers an empty blob via HEADER + COMPLETE (no self-resolve, §A3)", async () => {
    const { a, b, flush } = makePair();
    const received: ReceivedBlob[] = [];
    const sender = new BlobTransport(() => a);
    const receiver = new BlobTransport(() => b, { onBlob: (blob) => void received.push(blob) });
    sender.connect();
    receiver.connect();
    await flush();

    const empty = new Uint8Array(0);
    const hash = await sha256Hex(empty);
    receiver.expect(hash, 0);
    const handle = sender.send(empty, hash, "application/octet-stream");
    let resolvedEarly = false;
    void handle.done.then(() => (resolvedEarly = true));
    await new Promise((r) => globalThis.setTimeout(r, 0));
    expect(resolvedEarly).toBe(false); // not before the receiver's COMPLETE
    await flush();
    await expect(handle.done).resolves.toBeUndefined();
    expect(received).toHaveLength(1);
    expect(received[0]!.bytes.length).toBe(0);
  });

  it("a store FAILURE never resolves the push (no false success)", async () => {
    const { a, b, flush } = makePair();
    const sender = new BlobTransport(() => a);
    const receiver = new BlobTransport(() => b, {
      onBlob: () => {
        throw new Error("store boom");
      },
    });
    sender.connect();
    receiver.connect();
    await flush();
    const bytes = new Uint8Array([1, 2, 3]);
    const hash = await sha256Hex(bytes);
    receiver.expect(hash, 3);
    const handle = sender.send(bytes, hash, "x");
    const assert = expect(handle.done).rejects.toThrow(/store-failed|aborted/);
    await flush();
    await assert;
  });
});

describe("BlobTransport — ACK is flow-control only (§A2 adversarial)", () => {
  it("an ACK(0xffffffff) does NOT instantly complete the push", async () => {
    const { a, b, flush } = makePair();
    const sender = new BlobTransport(() => a);
    sender.connect();
    await flush();
    const bytes = new Uint8Array(BLOB_CHUNK_BYTES * 3).map((_, i) => i & 0xff);
    const hash = await sha256Hex(bytes);
    const handle = sender.send(bytes, hash, "x");
    let resolved = false;
    let rejected = false;
    void handle.done.then(
      () => (resolved = true),
      () => (rejected = true),
    );
    await flush();
    b.send(encodeFrame({ kind: "ack", transferId: handle.transferId, index: 0xffffffff }));
    await flush();
    expect(resolved).toBe(false);
    expect(rejected).toBe(false);
    sender.disconnect();
  });

  it("only advances the send window on a contiguous ACK, not an arbitrary index", async () => {
    const { a, b, flush } = makePair();
    const sender = new BlobTransport(() => a);
    const seenData: number[] = [];
    b.addEventListener("message", (e: unknown) => {
      const buf = new Uint8Array((e as { data: ArrayBuffer }).data);
      if (buf[0] === 2 /* Data */) {
        const idLen = buf[1]!;
        const off = 2 + idLen;
        const idx = ((buf[off]! << 24) | (buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!) >>> 0;
        seenData.push(idx);
      }
    });
    sender.connect();
    await flush();
    const bytes = new Uint8Array(BLOB_CHUNK_BYTES * 6).map((_, i) => i & 0xff); // 6 chunks
    const hash = await sha256Hex(bytes);
    const handle = sender.send(bytes, hash, "x");
    handle.done.catch(() => {}); // disconnect below rejects it; swallow
    await flush();
    expect(seenData).toEqual([0, 1, 2, 3]); // window 4
    // A cumulative ACK of index 1 advances the window to admit 4 and 5.
    b.send(encodeFrame({ kind: "ack", transferId: handle.transferId, index: 1 }));
    await flush();
    expect(seenData).toEqual([0, 1, 2, 3, 4, 5]);
    sender.disconnect();
  });
});

describe("BlobTransport — acceptance gating (§E13/E15)", () => {
  it("DISCARDS an unexpected blob (no expect registration)", async () => {
    const { a, b, flush } = makePair();
    const received: ReceivedBlob[] = [];
    const sender = new BlobTransport(() => a);
    const receiver = new BlobTransport(() => b, { onBlob: (blob) => void received.push(blob) });
    sender.connect();
    receiver.connect();
    await flush();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const hash = await sha256Hex(bytes);
    const handle = sender.send(bytes, hash, "x"); // no expect()
    const assert = expect(handle.done).rejects.toThrow(/unexpected|aborted/);
    await flush();
    await assert;
    expect(received).toHaveLength(0);
    expect(receiver.inboundCount).toBe(0);
  });

  it("accepts the EXPECTED blob and consumes the expectation (one push per expect)", async () => {
    const { a, b, flush } = makePair();
    const received: ReceivedBlob[] = [];
    const sender = new BlobTransport(() => a);
    const receiver = new BlobTransport(() => b, { onBlob: (blob) => void received.push(blob) });
    sender.connect();
    receiver.connect();
    await flush();
    const bytes = new Uint8Array([5, 6, 7, 8]);
    const hash = await sha256Hex(bytes);
    expect(receiver.expect(hash, 4)).toBe(true);
    const first = sender.send(bytes, hash, "x").done;
    await flush();
    await first;
    expect(received).toHaveLength(1);
    expect(receiver.expectationCount).toBe(0);
    const second = sender.send(bytes, hash, "x");
    const secondAssert = expect(second.done).rejects.toThrow(/unexpected|aborted/);
    await flush();
    await secondAssert;
    expect(received).toHaveLength(1);
  });

  it("a receiver byte quota refuses an over-quota expectation", () => {
    const { b } = makePair();
    const receiver = new BlobTransport(() => b, { maxExpectedBytes: 10 });
    expect(receiver.expect("a".repeat(64), 6)).toBe(true);
    expect(receiver.expect("b".repeat(64), 6)).toBe(false); // 12 > 10
    expect(receiver.expect("b".repeat(64), 4)).toBe(true); // 10 == 10 ok
  });
});

describe("BlobTransport — integrity + DoS rejections", () => {
  it("REJECTS a corrupted transfer (bytes don't match the declared hash)", async () => {
    const { a, b, flush } = makePair();
    const received: ReceivedBlob[] = [];
    const honest = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const liedHash = await sha256Hex(honest);
    const tampered = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]);
    const receiver = new BlobTransport(() => b, { onBlob: (blob) => void received.push(blob) });
    receiver.connect();
    receiver.expect(liedHash, 8);
    await flush();
    a.send(encodeFrame({ kind: "header", transferId: "evil", hash: liedHash, size: 8, mime: "x", totalChunks: 1 }));
    a.send(encodeFrame({ kind: "data", transferId: "evil", index: 0, bytes: tampered }));
    await flush();
    expect(received).toHaveLength(0);
    expect(receiver.inboundCount).toBe(0);
  });

  it("caps concurrent inbound transfers past the limit", async () => {
    const { a, b, flush } = makePair();
    const receiver = new BlobTransport(() => b, { onBlob: () => {}, maxExpectedBytes: 1_000_000 });
    receiver.connect();
    await flush();
    for (let i = 0; i <= BLOB_MAX_INFLIGHT_TRANSFERS; i++) {
      const hash = i.toString(16).padStart(64, "0");
      receiver.expect(hash, 100);
      a.send(encodeFrame({ kind: "header", transferId: `t${i}`, hash, size: 100, mime: "x", totalChunks: 1 }));
    }
    await flush();
    expect(receiver.inboundCount).toBe(BLOB_MAX_INFLIGHT_TRANSFERS);
  });

  it("aborts a transfer whose data exceeds its declared size", async () => {
    const { a, b, flush } = makePair();
    const received: ReceivedBlob[] = [];
    const hash = "a".repeat(64);
    const receiver = new BlobTransport(() => b, { onBlob: (blob) => void received.push(blob) });
    receiver.connect();
    receiver.expect(hash, 4);
    await flush();
    a.send(encodeFrame({ kind: "header", transferId: "big", hash, size: 4, mime: "x", totalChunks: 1 }));
    a.send(encodeFrame({ kind: "data", transferId: "big", index: 0, bytes: new Uint8Array(8) }));
    await flush();
    expect(received).toHaveLength(0);
    expect(receiver.inboundCount).toBe(0);
  });

  it("rejects a duplicate transferId with DIFFERENT contents as a conflict (§B6)", async () => {
    const { a, b, flush } = makePair();
    const received: ReceivedBlob[] = [];
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    const receiver = new BlobTransport(() => b, { onBlob: (blob) => void received.push(blob) });
    receiver.connect();
    receiver.expect(hashA, 100);
    receiver.expect(hashB, 100);
    await flush();
    a.send(encodeFrame({ kind: "header", transferId: "dup", hash: hashA, size: 100, mime: "x", totalChunks: 1 }));
    await flush();
    expect(receiver.inboundCount).toBe(1);
    a.send(encodeFrame({ kind: "header", transferId: "dup", hash: hashB, size: 100, mime: "x", totalChunks: 1 }));
    await flush();
    expect(receiver.inboundCount).toBe(0);
    expect(received).toHaveLength(0);
  });

  it("rejects an over-cap blob on send (validation fails fast)", async () => {
    const { a } = makePair();
    const sender = new BlobTransport(() => a);
    sender.connect();
    const fake = { length: 64 * 1024 * 1024 + 1, slice: () => new Uint8Array(0) } as unknown as Uint8Array;
    const handle = sender.send(fake, "a".repeat(64), "x");
    await expect(handle.done).rejects.toThrow(/BLOB_MAX_TRANSFER_BYTES/);
    expect(sender.outboundCount).toBe(0);
  });

  it("rejects send() with a bad hash or over-long mime immediately (§C10)", async () => {
    const { a } = makePair();
    const sender = new BlobTransport(() => a);
    sender.connect();
    await expect(sender.send(new Uint8Array([1]), "NOTHEX", "x").done).rejects.toThrow(/hash/);
    await expect(sender.send(new Uint8Array([1]), "a".repeat(64), "x".repeat(256)).done).rejects.toThrow(/mime/);
    expect(sender.outboundCount).toBe(0);
  });
});

describe("BlobTransport — lifecycle (§B5/B7)", () => {
  it("retransmits the HEADER on open so a send-before-connect isn't stranded", async () => {
    const { a, b, flush } = makePair();
    const received: ReceivedBlob[] = [];
    const sender = new BlobTransport(() => a);
    const receiver = new BlobTransport(() => b, { onBlob: (blob) => void received.push(blob) });
    receiver.connect();
    await flush();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const hash = await sha256Hex(bytes);
    receiver.expect(hash, 4);
    const handle = sender.send(bytes, hash, "x"); // socket not connected yet
    sender.connect(); // open re-sends HEADER + re-pumps
    await flush();
    await expect(handle.done).resolves.toBeUndefined();
    expect(received).toHaveLength(1);
  });

  it("frees all per-transfer state, timers, and expectations on disconnect", async () => {
    const { a, b, flush } = makePair();
    const receiver = new BlobTransport(() => b, { onBlob: () => {} });
    receiver.connect();
    receiver.expect("a".repeat(64), 100);
    await flush();
    a.send(encodeFrame({ kind: "header", transferId: "x", hash: "a".repeat(64), size: 100, mime: "x", totalChunks: 1 }));
    await flush();
    expect(receiver.inboundCount).toBe(1);
    expect(receiver.expectationCount).toBe(1);
    receiver.disconnect();
    expect(receiver.inboundCount).toBe(0);
    expect(receiver.expectationCount).toBe(0);
  });

  it("expires an idle inbound transfer via the sweep", async () => {
    const { a, b, flush } = makePair();
    let clock = 0;
    const receiver = new BlobTransport(() => b, {
      onBlob: () => {},
      idleTransferMs: 1000,
      scheduler: fastSweep,
      now: () => clock,
    });
    receiver.connect();
    receiver.expect("a".repeat(64), 100);
    await flush();
    a.send(encodeFrame({ kind: "header", transferId: "stale", hash: "a".repeat(64), size: 100, mime: "x", totalChunks: 1 }));
    await flush();
    expect(receiver.inboundCount).toBe(1);
    clock = 5000;
    await new Promise((r) => globalThis.setTimeout(r, 5));
    await flush();
    expect(receiver.inboundCount).toBe(0);
  });
});

describe("BlobTransport — quota accounting (rework rd3 §2: release exactly once)", () => {
  it("expect→deliver returns the outstanding-bytes counter to its starting value", async () => {
    const { a, b, flush } = makePair();
    const sender = new BlobTransport(() => a);
    const receiver = new BlobTransport(() => b, { onBlob: () => {} });
    sender.connect();
    receiver.connect();
    await flush();
    expect(receiver.outstandingBytes).toBe(0);
    const bytes = new Uint8Array(300 * 1024).map((_, i) => i & 0xff);
    const hash = await sha256Hex(bytes);
    receiver.expect(hash, bytes.length);
    expect(receiver.outstandingBytes).toBe(bytes.length); // reserved by expect
    const p = sender.send(bytes, hash, "x").done;
    await flush();
    await p;
    expect(receiver.outstandingBytes).toBe(0); // released EXACTLY once on delivery
    expect(receiver.expectationCount).toBe(0);
  });

  it("expect→abort also returns the counter to its starting value (no double release)", async () => {
    const { a, b, flush } = makePair();
    const receiver = new BlobTransport(() => b, { onBlob: () => {} });
    receiver.connect();
    const hash = "a".repeat(64);
    receiver.expect(hash, 100);
    await flush();
    expect(receiver.outstandingBytes).toBe(100);
    // Header arrives (expected, charged=false), then a bad chunk triggers abort.
    a.send(encodeFrame({ kind: "header", transferId: "t", hash, size: 100, mime: "x", totalChunks: 1 }));
    a.send(encodeFrame({ kind: "data", transferId: "t", index: 0, bytes: new Uint8Array(200) })); // > size
    await flush();
    // The transfer aborted; its reservation belongs to the expectation, which is
    // still live (abort doesn't consume an expectation) — so the counter holds at
    // the expectation's reservation, NOT underflowed below it.
    expect(receiver.outstandingBytes).toBe(100);
    receiver.unexpect(hash, 100);
    expect(receiver.outstandingBytes).toBe(0); // released exactly once
  });
});

describe("BlobTransport — terminal authentication (rework rd3 §1)", () => {
  it("ENFORCE: a valid signed COMPLETE resolves the push", async () => {
    const { a, b, flush } = makePair();
    const auth = buildBlobTerminalAuth(TERMINAL_KEY, TERMINAL_SCOPE);
    const sender = new BlobTransport(() => a, { terminalVerifier: auth.terminalVerifier });
    const receiver = new BlobTransport(() => b, { onBlob: () => {}, terminalSigner: auth.terminalSigner });
    sender.connect();
    receiver.connect();
    await flush();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const hash = await sha256Hex(bytes);
    receiver.expect(hash, 4);
    const p = sender.send(bytes, hash, "x").done;
    await flush();
    await expect(p).resolves.toBeUndefined();
  });

  it("ENFORCE: a FORGED/unsigned COMPLETE does NOT resolve (fails closed)", async () => {
    const { a, b, flush } = makePair();
    const auth = buildBlobTerminalAuth(TERMINAL_KEY, TERMINAL_SCOPE);
    // The sender ENFORCES; the receiver does NOT sign (a forging/un-paired peer).
    const sender = new BlobTransport(() => a, {
      terminalVerifier: auth.terminalVerifier,
      idleTransferMs: 40,
      scheduler: fastSweep,
      now: () => Date.now(),
    });
    const receiver = new BlobTransport(() => b, { onBlob: () => {} }); // no signer
    sender.connect();
    receiver.connect();
    await flush();
    const bytes = new Uint8Array([5, 6, 7, 8]);
    const hash = await sha256Hex(bytes);
    receiver.expect(hash, 4);
    const handle = sender.send(bytes, hash, "x");
    // The receiver sends an UNSIGNED COMPLETE; the enforcing sender ignores it and
    // fails closed via the idle sweep.
    const assert = expect(handle.done).rejects.toThrow(/idle|timeout|aborted/);
    await flush();
    await assert;
  });

  it("ENFORCE: a COMPLETE signed with the WRONG key does NOT resolve", async () => {
    const { a, b, flush } = makePair();
    const senderAuth = buildBlobTerminalAuth(TERMINAL_KEY, TERMINAL_SCOPE);
    const wrongAuth = buildBlobTerminalAuth(new Uint8Array(32).fill(9), TERMINAL_SCOPE);
    const sender = new BlobTransport(() => a, {
      terminalVerifier: senderAuth.terminalVerifier,
      idleTransferMs: 40,
      scheduler: fastSweep,
      now: () => Date.now(),
    });
    const receiver = new BlobTransport(() => b, { onBlob: () => {}, terminalSigner: wrongAuth.terminalSigner });
    sender.connect();
    receiver.connect();
    await flush();
    const bytes = new Uint8Array([9, 9, 9]);
    const hash = await sha256Hex(bytes);
    receiver.expect(hash, 3);
    const handle = sender.send(bytes, hash, "x");
    const assert = expect(handle.done).rejects.toThrow(/idle|timeout|aborted/);
    await flush();
    await assert;
  });

  it("ENFORCE: a forged (unsigned) ABORT is IGNORED — the transfer is not torn down", async () => {
    const { a, b, flush } = makePair();
    const auth = buildBlobTerminalAuth(TERMINAL_KEY, TERMINAL_SCOPE);
    const sender = new BlobTransport(() => a, { terminalVerifier: auth.terminalVerifier });
    const receiver = new BlobTransport(() => b, { onBlob: () => {}, terminalSigner: auth.terminalSigner });
    sender.connect();
    receiver.connect();
    await flush();
    const bytes = new Uint8Array(BLOB_CHUNK_BYTES * 2).map((_, i) => i & 0xff);
    const hash = await sha256Hex(bytes);
    receiver.expect(hash, bytes.length);
    const handle = sender.send(bytes, hash, "x");
    // A 3rd peer injects an UNSIGNED abort mid-flight — must be ignored; the real
    // signed COMPLETE still resolves the push.
    b.send(encodeFrame({ kind: "abort", transferId: handle.transferId, reason: "forged" }));
    await flush();
    await expect(handle.done).resolves.toBeUndefined();
  });

  it("ADVISORY: without a key, completion still works (advisory path)", async () => {
    const { a, b, flush } = makePair();
    const sender = new BlobTransport(() => a); // no verifier
    const receiver = new BlobTransport(() => b, { onBlob: () => {} }); // no signer
    sender.connect();
    receiver.connect();
    await flush();
    const bytes = new Uint8Array([1, 2, 3]);
    const hash = await sha256Hex(bytes);
    receiver.expect(hash, 3);
    const p = sender.send(bytes, hash, "x").done;
    await flush();
    await expect(p).resolves.toBeUndefined();
  });
});

describe("BlobTransport — transferId reservations (A1 export channel)", () => {
  it("reserves by transferId, binds an inbound HEADER, delivers a CANDIDATE with the id (reservation STAYS OPEN)", async () => {
    const { a, b, flush } = makePair();
    const received: ReceivedBlob[] = [];
    const sender = new BlobTransport(() => a);
    const receiver = new BlobTransport(() => b, { onBlob: (blob) => void received.push(blob) });
    sender.connect();
    receiver.connect();
    await flush();

    const bytes = new Uint8Array(BLOB_CHUNK_BYTES + 50).map((_, i) => (i * 5) & 0xff);
    const hash = await sha256Hex(bytes);
    const transferId = "export-abc";
    // Reserve a generous maxBytes (the receiver does not know the exact size yet).
    expect(receiver.expectTransfer(transferId, BLOB_CHUNK_BYTES * 4)).toBe(true);
    expect(receiver.transferReservationCount).toBe(1);
    expect(receiver.outstandingBytes).toBe(BLOB_CHUNK_BYTES * 4);

    // The sender pushes under the SAME caller-supplied transferId.
    const handle = sender.send(bytes, hash, "application/pdf", { transferId });
    expect(handle.transferId).toBe(transferId);
    await flush();

    await expect(handle.done).resolves.toBeUndefined();
    expect(received).toHaveLength(1);
    expect(received[0]!.hash).toBe(hash);
    expect(received[0]!.bytes).toEqual(bytes);
    expect(received[0]!.transferId).toBe(transferId);
    // rd-A1 §2: the delivered blob is a CANDIDATE — the reservation STAYS OPEN (the
    // kernel promotes/discards it, then withdraws the reservation). The in-flight
    // reassembly is gone, but the reservation + its quota persist until unexpect.
    expect(receiver.inboundCount).toBe(0);
    expect(receiver.transferReservationCount).toBe(1);
    expect(receiver.outstandingBytes).toBe(BLOB_CHUNK_BYTES * 4);
    // The kernel withdraws the reservation once it has promoted the candidate.
    expect(receiver.unexpectTransfer(transferId)).toBe(true);
    expect(receiver.transferReservationCount).toBe(0);
    expect(receiver.outstandingBytes).toBe(0);
  });

  it("CANDIDATE model: a forged early candidate delivers, the reservation STAYS OPEN, a later candidate also delivers (rd-A1 §2)", async () => {
    const { a, b, flush } = makePair();
    const received: ReceivedBlob[] = [];
    const forger = new BlobTransport(() => a);
    const receiver = new BlobTransport(() => b, { onBlob: (blob) => void received.push(blob) });
    forger.connect();
    receiver.connect();
    await flush();

    const transferId = "export-race";
    expect(receiver.expectTransfer(transferId, BLOB_CHUNK_BYTES * 4)).toBe(true);

    // A 3rd peer pushes a FORGED blob FIRST under the visible transferId.
    const fake = new Uint8Array([1, 1, 1]);
    const fakeHash = await sha256Hex(fake);
    const h1 = forger.send(fake, fakeHash, "application/pdf", { transferId });
    await flush();
    await h1.done;
    // The forged candidate WAS delivered (the kernel will discard it on the
    // descriptor mismatch) — but the reservation is STILL OPEN.
    expect(received).toHaveLength(1);
    expect(received[0]!.hash).toBe(fakeHash);
    expect(received[0]!.transferId).toBe(transferId);
    expect(receiver.transferReservationCount).toBe(1);

    // The REAL browser's candidate now arrives under the SAME id and also delivers.
    const real = new Uint8Array(BLOB_CHUNK_BYTES + 7).map((_, i) => (i * 3) & 0xff);
    const realHash = await sha256Hex(real);
    const h2 = forger.send(real, realHash, "application/pdf", { transferId });
    await flush();
    await h2.done;
    expect(received).toHaveLength(2);
    expect(received[1]!.hash).toBe(realHash);
    expect(received[1]!.transferId).toBe(transferId);
    expect(receiver.transferReservationCount).toBe(1); // still open until withdrawn
    receiver.unexpectTransfer(transferId);
    expect(receiver.outstandingBytes).toBe(0);
  });

  it("unexpectTransfer aborts a BOUND in-flight candidate + frees quota; a late completion stores nothing (rd-A1 §4)", async () => {
    const { a, b, flush } = makePair();
    const received: ReceivedBlob[] = [];
    const sender = new BlobTransport(() => a, { scheduler: fastSweep, idleTransferMs: 10_000 });
    const receiver = new BlobTransport(() => b, { onBlob: (blob) => void received.push(blob) });
    sender.connect();
    receiver.connect();
    await flush();

    const transferId = "export-withdraw";
    // A multi-chunk blob so it is mid-flight (bound but not finished) when we send
    // ONLY the header before withdrawing. NOTE: in makePair, `a.send(...)` delivers
    // INTO the receiver (a's peer is b = the receiver's socket).
    const bytes = new Uint8Array(BLOB_CHUNK_BYTES * 3).map((_, i) => i & 0xff);
    const hash = await sha256Hex(bytes);
    expect(receiver.expectTransfer(transferId, BLOB_CHUNK_BYTES * 4)).toBe(true);
    // Inject ONLY the header so a candidate is BOUND but unfinished.
    a.send(encodeFrame({ kind: "header", transferId, hash, size: bytes.length, mime: "application/pdf", totalChunks: 3 }));
    await flush();
    expect(receiver.inboundCount).toBe(1);
    // Withdraw while the candidate is bound: it aborts the in-flight candidate AND
    // frees the reservation quota.
    expect(receiver.unexpectTransfer(transferId)).toBe(true);
    expect(receiver.inboundCount).toBe(0);
    expect(receiver.transferReservationCount).toBe(0);
    expect(receiver.outstandingBytes).toBe(0);
    // A late "completion" (the data) after withdrawal stores nothing.
    for (let i = 0; i < 3; i++) {
      a.send(encodeFrame({ kind: "data", transferId, index: i, bytes: bytes.subarray(i * BLOB_CHUNK_BYTES, (i + 1) * BLOB_CHUNK_BYTES) }));
    }
    await flush();
    expect(received).toHaveLength(0);
    expect(receiver.outstandingBytes).toBe(0);
  });

  it("DUAL-MATCH: a transfer matching BOTH a hash-expectation AND a reservation consumes the hash-expectation (no leak, rd-A1 §3)", async () => {
    const { a, b, flush } = makePair();
    const received: ReceivedBlob[] = [];
    const sender = new BlobTransport(() => a);
    const receiver = new BlobTransport(() => b, { onBlob: (blob) => void received.push(blob) });
    sender.connect();
    receiver.connect();
    await flush();

    const bytes = new Uint8Array([4, 4, 4, 4]);
    const hash = await sha256Hex(bytes);
    const transferId = "export-dual";
    // Register BOTH a hash-expectation AND a transferId reservation for the same blob.
    expect(receiver.expect(hash, bytes.length)).toBe(true);
    expect(receiver.expectTransfer(transferId, 1024)).toBe(true);
    const before = receiver.outstandingBytes; // size (expect) + 1024 (reservation)
    expect(before).toBe(bytes.length + 1024);

    const h = sender.send(bytes, hash, "application/pdf", { transferId });
    await flush();
    await h.done;
    expect(received).toHaveLength(1);
    // The hash-expectation is CONSUMED (count back to 0, its bytes freed); the
    // reservation persists.
    expect(receiver.expectationCount).toBe(0);
    expect(receiver.transferReservationCount).toBe(1);
    expect(receiver.outstandingBytes).toBe(1024); // only the reservation's bytes remain
    receiver.unexpectTransfer(transferId);
    expect(receiver.outstandingBytes).toBe(0);
  });

  it("forged candidates cannot exhaust quota beyond the single reservation (rd-A1 §2)", async () => {
    const { a, b, flush } = makePair();
    const sender = new BlobTransport(() => a);
    const receiver = new BlobTransport(() => b, { onBlob: () => {}, maxExpectedBytes: 4096 });
    sender.connect();
    receiver.connect();
    await flush();
    const transferId = "export-quota";
    expect(receiver.expectTransfer(transferId, 2048)).toBe(true);
    // Push several sequential candidates under the same id; the reservation caps the
    // outstanding bytes — they never accumulate beyond the single reservation.
    for (let i = 0; i < 4; i++) {
      const bytes = new Uint8Array([i, i, i]);
      const hash = await sha256Hex(bytes);
      const h = sender.send(bytes, hash, "application/pdf", { transferId });
      await flush();
      await h.done;
      expect(receiver.outstandingBytes).toBe(2048); // only the reservation, every time
    }
    expect(receiver.transferReservationCount).toBe(1);
  });

  it("ABORTS a transferId-reserved HEADER that declares MORE than the reserved maxBytes", async () => {
    const { a, b, flush } = makePair();
    const received: ReceivedBlob[] = [];
    const sender = new BlobTransport(() => a, { scheduler: fastSweep, idleTransferMs: 50 });
    const receiver = new BlobTransport(() => b, { onBlob: (blob) => void received.push(blob) });
    sender.connect();
    receiver.connect();
    await flush();

    const bytes = new Uint8Array(BLOB_CHUNK_BYTES * 3).map((_, i) => i & 0xff);
    const hash = await sha256Hex(bytes);
    const transferId = "export-oversize";
    // Reserve LESS than the blob's size → the header must be aborted.
    expect(receiver.expectTransfer(transferId, BLOB_CHUNK_BYTES)).toBe(true);
    const handle = sender.send(bytes, hash, "application/pdf", { transferId });
    const assert = expect(handle.done).rejects.toThrow();
    await flush();
    await assert;
    expect(received).toHaveLength(0);
    // The reservation stays live (a conformant retry could still arrive); the
    // failed inbound left nothing reassembling.
    expect(receiver.inboundCount).toBe(0);
  });

  it("ABORTS an unexpected inbound that matches NEITHER a hash-expectation NOR a reservation", async () => {
    const { a, b, flush } = makePair();
    const received: ReceivedBlob[] = [];
    const sender = new BlobTransport(() => a, { scheduler: fastSweep, idleTransferMs: 50 });
    const receiver = new BlobTransport(() => b, { onBlob: (blob) => void received.push(blob) });
    sender.connect();
    receiver.connect();
    await flush();
    const bytes = new Uint8Array([9, 9, 9]);
    const hash = await sha256Hex(bytes);
    // No expect() and no expectTransfer() → unexpected → aborted (gating preserved).
    const handle = sender.send(bytes, hash, "x", { transferId: "no-reservation" });
    const assert = expect(handle.done).rejects.toThrow();
    await flush();
    await assert;
    expect(received).toHaveLength(0);
    expect(receiver.transferReservationCount).toBe(0);
  });

  it("unexpectTransfer releases the reservation + its quota exactly once", async () => {
    const { b } = makePair();
    const receiver = new BlobTransport(() => b, { onBlob: () => {} });
    receiver.connect();
    expect(receiver.expectTransfer("t1", 1000)).toBe(true);
    expect(receiver.outstandingBytes).toBe(1000);
    expect(receiver.unexpectTransfer("t1")).toBe(true);
    expect(receiver.outstandingBytes).toBe(0);
    expect(receiver.transferReservationCount).toBe(0);
    // A second release is a no-op (no double-free).
    expect(receiver.unexpectTransfer("t1")).toBe(false);
    expect(receiver.outstandingBytes).toBe(0);
  });

  it("expectTransfer is idempotent for the same maxBytes and refuses a conflicting cap / over-quota", () => {
    const { b } = makePair();
    const receiver = new BlobTransport(() => b, { onBlob: () => {}, maxExpectedBytes: 1000 });
    receiver.connect();
    expect(receiver.expectTransfer("t", 600)).toBe(true);
    expect(receiver.expectTransfer("t", 600)).toBe(true); // idempotent
    expect(receiver.transferReservationCount).toBe(1);
    expect(receiver.expectTransfer("t", 700)).toBe(false); // conflicting cap
    expect(receiver.expectTransfer("u", 600)).toBe(false); // would exceed the 1000 quota
    expect(receiver.outstandingBytes).toBe(600);
    // Invalid args reserve nothing — including a non-positive maxBytes (rd-A1 §6).
    expect(receiver.expectTransfer("", 100)).toBe(false);
    expect(receiver.expectTransfer("v", -1)).toBe(false);
    expect(receiver.expectTransfer("z", 0)).toBe(false);
  });

  it("the existing expect(hash) path is unchanged when a reservation also exists", async () => {
    const { a, b, flush } = makePair();
    const received: ReceivedBlob[] = [];
    const sender = new BlobTransport(() => a);
    const receiver = new BlobTransport(() => b, { onBlob: (blob) => void received.push(blob) });
    sender.connect();
    receiver.connect();
    await flush();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const hash = await sha256Hex(bytes);
    // A hash-expectation (NOT a transferId reservation) still delivers with an
    // auto-minted id and NO transferId on the blob.
    receiver.expect(hash, bytes.length);
    const handle = sender.send(bytes, hash, "x");
    await flush();
    await expect(handle.done).resolves.toBeUndefined();
    expect(received[0]!.transferId).toBeUndefined();
    expect(receiver.expectationCount).toBe(0);
    expect(receiver.outstandingBytes).toBe(0);
  });
});
