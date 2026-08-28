import { describe, it, expect } from "vitest";
import {
  sha256Hex,
  buildBlobTerminalAuth,
  BlobTransport,
  type WebSocketLike,
  type ReceivedBlob,
} from "@galley/collab";
import { createKernelBlobSession } from "./blob-session.js";

/**
 * In-memory paired blob sockets (relay 2-peer semantics) so the kernel session is
 * tested without depending on `@galley/sync` (not an mcp dep). The real relay
 * round-trip is proven in the sync test; here we prove putBlob/onBlob/takeBlob +
 * the bounded buffer.
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
    // its frame, even on a slow CI runner. A single trailing yield races that chain
    // and can strand the COMPLETE → a putBlob that never resolves (5s timeout flake).
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

describe("kernel blob-session", () => {
  it("is OPT-IN: not enabled until connect() (§E14)", () => {
    const { a } = makePair();
    const kernel = createKernelBlobSession("ws://x", "room", { socketFactory: () => a });
    expect(kernel.enabled).toBe(false);
    kernel.connect();
    expect(kernel.enabled).toBe(true);
    kernel.destroy();
    expect(kernel.enabled).toBe(false);
  });

  it("putBlob hashes + pushes; the EXPECTED peer receives the verified bytes", async () => {
    const { a, b, flush } = makePair();
    const kernel = createKernelBlobSession("ws://x", "room", { socketFactory: () => a });
    const peer = createKernelBlobSession("ws://x", "room", { socketFactory: () => b });
    kernel.connect();
    peer.connect();
    await flush();

    const bytes = new Uint8Array(256 * 1024 + 9).map((_, i) => (i * 5) & 0xff);
    const expectedHash = await sha256Hex(bytes);
    peer.expect(expectedHash, bytes.length); // §E13
    const putP = kernel.putBlob(bytes, "image/png");
    await flush();
    const { hash, size } = await putP;
    expect(hash).toBe(expectedHash);
    expect(size).toBe(bytes.length);

    expect(peer.hasBlob(expectedHash)).toBe(true);
    const taken = peer.takeBlob(expectedHash);
    expect(taken?.bytes).toEqual(bytes);
    expect(taken?.mime).toBe("image/png");
    expect(peer.hasBlob(expectedHash)).toBe(false);

    kernel.destroy();
    peer.destroy();
  });

  it("DISCARDS an unexpected inbound blob (no expect, §E13)", async () => {
    const { a, b, flush } = makePair();
    const kernel = createKernelBlobSession("ws://x", "room", { socketFactory: () => a });
    const peer = createKernelBlobSession("ws://x", "room", { socketFactory: () => b });
    kernel.connect();
    peer.connect();
    await flush();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const hash = await sha256Hex(bytes);
    // No peer.expect(...) → the push is aborted, nothing buffered.
    const handle = kernel.putBlob(bytes, "x");
    const assert = expect(handle).rejects.toThrow(/unexpected|aborted/);
    await flush();
    await assert;
    expect(peer.hasBlob(hash)).toBe(false);
    expect(peer.bufferedCount).toBe(0);
    kernel.destroy();
    peer.destroy();
  });

  it("onBlob fires for a VERIFIED + EXPECTED inbound blob", async () => {
    const { a, b, flush } = makePair();
    const kernel = createKernelBlobSession("ws://x", "r", { socketFactory: () => a });
    const peer = createKernelBlobSession("ws://x", "r", { socketFactory: () => b });
    const seen: string[] = [];
    const off = peer.onBlob((blob) => seen.push(blob.hash));
    kernel.connect();
    peer.connect();
    await flush();

    const bytes = new Uint8Array([1, 2, 3]);
    const hash = await sha256Hex(bytes);
    peer.expect(hash, 3);
    const p = kernel.putBlob(bytes, "x");
    await flush();
    await p;
    expect(seen).toEqual([hash]);

    off();
    kernel.destroy();
    peer.destroy();
  });

  it("bounds the inbound buffer, evicting the oldest past the count cap", async () => {
    const { a, b, flush } = makePair();
    const kernel = createKernelBlobSession("ws://x", "cap", { socketFactory: () => a });
    const peer = createKernelBlobSession("ws://x", "cap", {
      socketFactory: () => b,
      maxBufferedBlobs: 2,
    });
    kernel.connect();
    peer.connect();
    await flush();

    const hashes: string[] = [];
    const admitted: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      const bytes = new Uint8Array([i, i, i, i]);
      const h = await sha256Hex(bytes);
      hashes.push(h);
      const ok = peer.expect(h, 4);
      admitted.push(ok);
      const p = kernel.putBlob(bytes, "x").catch(() => undefined); // 3rd refused
      await flush();
      await p;
    }
    // §rd3-5: expect() reserves capacity, so the 3rd registration was REFUSED and
    // never delivered/buffered — the two earlier PINNED blobs are NEVER evicted.
    expect(admitted).toEqual([true, true, false]);
    expect(peer.bufferedCount).toBe(2);
    expect(peer.hasBlob(hashes[0]!)).toBe(true);
    expect(peer.hasBlob(hashes[1]!)).toBe(true);
    expect(peer.hasBlob(hashes[2]!)).toBe(false);

    kernel.destroy();
    peer.destroy();
  });

  it("expect() RESERVES capacity and refuses past the cap; pinned blobs never evicted (§rd3-5)", async () => {
    const { b } = makePair();
    const peer = createKernelBlobSession("ws://x", "cap2", { socketFactory: () => b, maxBufferedBlobs: 2 });
    peer.connect();
    // Two expectations fit; the third is refused (capacity reserved up front).
    expect(peer.expect("a".repeat(64), 4)).toBe(true);
    expect(peer.expect("b".repeat(64), 4)).toBe(true);
    expect(peer.expect("c".repeat(64), 4)).toBe(false);
    // Releasing one frees a slot.
    peer.unexpect("a".repeat(64), 4);
    expect(peer.expect("c".repeat(64), 4)).toBe(true);
    peer.destroy();
  });

  it("ENFORCE terminal auth: putBlob resolves only on a MAC-verified COMPLETE", async () => {
    const { a, b, flush } = makePair();
    const scope = { grantId: "g", controlRoom: "c", syncUrl: "ws://r", projectId: "p", shareRoom: "s" };
    const key = new Uint8Array(32).fill(3);
    const kAuth = buildBlobTerminalAuth(key, scope);
    const pAuth = buildBlobTerminalAuth(key, scope);
    const kernel = createKernelBlobSession("ws://x", "auth", {
      socketFactory: () => a,
      terminalVerifier: kAuth.terminalVerifier,
      terminalSigner: kAuth.terminalSigner,
    });
    const peer = createKernelBlobSession("ws://x", "auth", {
      socketFactory: () => b,
      terminalVerifier: pAuth.terminalVerifier,
      terminalSigner: pAuth.terminalSigner,
    });
    kernel.connect();
    peer.connect();
    await flush();
    const bytes = new Uint8Array([7, 7, 7, 7]);
    const hash = await sha256Hex(bytes);
    peer.expect(hash, 4);
    const p = kernel.putBlob(bytes, "x");
    await flush();
    await expect(p).resolves.toMatchObject({ hash });
    expect(peer.hasBlob(hash)).toBe(true);
    kernel.destroy();
    peer.destroy();
  });
});

describe("kernel blob-session — transferId reservations (A1 export channel)", () => {
  it("expectTransfer reserves; a peer pushing under the SAME id is buffered + pulled by takeBlobByTransfer", async () => {
    const { a, b, flush } = makePair();
    // The kernel is the RECEIVER (it reserves + pulls). The sender is a raw
    // BlobTransport standing in for the browser responder's push.
    const kernel = createKernelBlobSession("ws://x", "export", { socketFactory: () => b });
    const sender = new BlobTransport(() => a);
    kernel.connect();
    sender.connect();
    await flush();

    const bytes = new Uint8Array([10, 20, 30, 40, 50]);
    const hash = await sha256Hex(bytes);
    const transferId = "kernel-mint-1";
    expect(kernel.expectTransfer(transferId, 1024)).toBe(true);

    const handle = sender.send(bytes, hash, "application/pdf", { transferId });
    await flush();
    await expect(handle.done).resolves.toBeUndefined();

    // The blob is buffered + pullable by transferId; the bytes + hash match.
    const blob = kernel.takeBlobByTransfer(transferId);
    expect(blob).toBeDefined();
    expect(blob!.hash).toBe(hash);
    expect(blob!.size).toBe(bytes.length);
    expect(blob!.bytes).toEqual(bytes);
    // Pulled exactly once.
    expect(kernel.takeBlobByTransfer(transferId)).toBeUndefined();
    kernel.destroy();
  });

  it("unexpectTransfer releases the reservation; a later unexpected push is discarded", async () => {
    const { a, b, flush } = makePair();
    const kernel = createKernelBlobSession("ws://x", "export2", { socketFactory: () => b });
    const sender = new BlobTransport(() => a);
    kernel.connect();
    sender.connect();
    await flush();
    expect(kernel.expectTransfer("gone", 512)).toBe(true);
    kernel.unexpectTransfer("gone");
    const bytes = new Uint8Array([1, 2, 3]);
    const hash = await sha256Hex(bytes);
    const handle = sender.send(bytes, hash, "x", { transferId: "gone" });
    const assert = expect(handle.done).rejects.toThrow();
    await flush();
    await assert;
    expect(kernel.takeBlobByTransfer("gone")).toBeUndefined();
    kernel.destroy();
  });
});

describe("kernel blob-session — concurrent same-hash exports + failure drain (rd-A1 §4/§5)", () => {
  it("two concurrent exports with the SAME hash do NOT delete each other's candidate (§5)", async () => {
    const { a, b, flush } = makePair();
    const kernel = createKernelBlobSession("ws://x", "dup", { socketFactory: () => b });
    const sender = new BlobTransport(() => a);
    kernel.connect();
    sender.connect();
    await flush();

    // The SAME bytes (unchanged project) → the SAME hash, under TWO transferIds.
    const bytes = new Uint8Array([7, 7, 7, 7]);
    const hash = await sha256Hex(bytes);
    expect(kernel.expectTransfer("t-A", 1024)).toBe(true);
    expect(kernel.expectTransfer("t-B", 1024)).toBe(true);

    const hA = sender.send(bytes, hash, "application/pdf", { transferId: "t-A" });
    await flush();
    await hA.done;
    const hB = sender.send(bytes, hash, "application/pdf", { transferId: "t-B" });
    await flush();
    await hB.done;

    // BOTH candidates are independently held + peekable, keyed by their own id.
    expect(kernel.peekBlobByTransfer("t-A")!.hash).toBe(hash);
    expect(kernel.peekBlobByTransfer("t-B")!.hash).toBe(hash);

    // Export A FAILS → its cleanup withdraws t-A. This must NOT delete B's artifact.
    kernel.unexpectTransfer("t-A");
    expect(kernel.peekBlobByTransfer("t-A")).toBeUndefined();
    const blobB = kernel.takeBlobByTransfer("t-B");
    expect(blobB).toBeDefined();
    expect(blobB!.bytes).toEqual(bytes);
    kernel.destroy();
  });

  it("unexpectTransfer DRAINS a delivered candidate (no orphan) + frees the reservation (§4)", async () => {
    const { a, b, flush } = makePair();
    const kernel = createKernelBlobSession("ws://x", "drain", { socketFactory: () => b });
    const sender = new BlobTransport(() => a);
    kernel.connect();
    sender.connect();
    await flush();
    const bytes = new Uint8Array([3, 3, 3]);
    const hash = await sha256Hex(bytes);
    expect(kernel.expectTransfer("t-x", 1024)).toBe(true);
    const h = sender.send(bytes, hash, "application/pdf", { transferId: "t-x" });
    await flush();
    await h.done;
    // The candidate is buffered — now a failure cleanup withdraws it.
    expect(kernel.peekBlobByTransfer("t-x")).toBeDefined();
    kernel.unexpectTransfer("t-x");
    // No orphan: the candidate is gone AND a fresh reservation of the full quota
    // succeeds (the bytes were freed).
    expect(kernel.peekBlobByTransfer("t-x")).toBeUndefined();
    expect(kernel.takeBlobByTransfer("t-x")).toBeUndefined();
    kernel.destroy();
  });
});

describe("kernel blob-session — awaitMatchingCandidate (candidate/promote loop, rd-A1 §2)", () => {
  it("discards a forged early candidate (predicate fails) and resolves the matching one; reservation stays live", async () => {
    const { a, b, flush } = makePair();
    const kernel = createKernelBlobSession("ws://x", "loop", { socketFactory: () => b });
    const sender = new BlobTransport(() => a);
    kernel.connect();
    sender.connect();
    await flush();

    const real = new Uint8Array([1, 2, 3, 4]);
    const realHash = await sha256Hex(real);
    expect(kernel.expectTransfer("t-loop", 1024)).toBe(true);

    // Start waiting for a candidate whose hash === realHash, discarding mismatches.
    const matchP = kernel.awaitMatchingCandidate("t-loop", (b2) => b2.hash === realHash, 10_000);

    // A FORGED candidate arrives first (wrong hash) → discarded, wait continues.
    const fake = new Uint8Array([9, 9]);
    const fakeHash = await sha256Hex(fake);
    const hF = sender.send(fake, fakeHash, "application/pdf", { transferId: "t-loop" });
    await flush();
    await hF.done;
    // The reservation is STILL live and the forged candidate was discarded.
    expect(kernel.peekBlobByTransfer("t-loop")).toBeUndefined();
    expect(kernel.takeBlobByTransfer("t-loop")).toBeUndefined();

    // The REAL candidate arrives → it must resolve the wait.
    const hR = sender.send(real, realHash, "application/pdf", { transferId: "t-loop" });
    await flush();
    await hR.done;
    const matched = await matchP;
    expect(matched).toBeDefined();
    expect(matched!.hash).toBe(realHash);
    expect(matched!.bytes).toEqual(real);
    // It is left buffered for the caller to take (promotion is the caller's job).
    expect(kernel.takeBlobByTransfer("t-loop")).toBeDefined();
    kernel.unexpectTransfer("t-loop");
    kernel.destroy();
  });

  it("resolves undefined at the deadline when no candidate matches", async () => {
    const { a, b, flush } = makePair();
    const kernel = createKernelBlobSession("ws://x", "loop2", { socketFactory: () => b });
    const sender = new BlobTransport(() => a);
    kernel.connect();
    sender.connect();
    await flush();
    expect(kernel.expectTransfer("t-none", 1024)).toBe(true);
    const wait = kernel.awaitMatchingCandidate("t-none", () => false, 20);
    // A non-matching candidate arrives but never satisfies the predicate.
    const fake = new Uint8Array([7]);
    const fakeHash = await sha256Hex(fake);
    const h = sender.send(fake, fakeHash, "application/pdf", { transferId: "t-none" });
    await flush();
    await h.done;
    expect(await wait).toBeUndefined();
    // The reservation is untouched by the helper (caller withdraws it).
    expect(kernel.unexpectTransfer).toBeTypeOf("function");
    kernel.unexpectTransfer("t-none");
    kernel.destroy();
  });
});

describe("kernel blob-session — retainBlob (F11 export-artifact pin for save_artifact)", () => {
  const blobOf = (hash: string, size: number): ReceivedBlob => ({
    bytes: new Uint8Array(size),
    hash,
    size,
    mime: "application/pdf",
  });

  it("PINS a verified blob into the hash-keyed buffer; takeBlob fetches then removes it", () => {
    const { b } = makePair();
    const kernel = createKernelBlobSession("ws://x", "retain", { socketFactory: () => b });
    const blob = blobOf("a".repeat(64), 4);
    expect(kernel.retainBlob(blob)).toBe(true);
    expect(kernel.hasBlob(blob.hash)).toBe(true);
    expect(kernel.bufferedCount).toBe(1);
    const taken = kernel.takeBlob(blob.hash);
    expect(taken).toBe(blob);
    expect(kernel.hasBlob(blob.hash)).toBe(false);
    expect(kernel.bufferedCount).toBe(0);
    kernel.destroy();
  });

  it("is IDEMPOTENT for the same hash — a second retain is a no-op (single buffered entry)", () => {
    const { b } = makePair();
    const kernel = createKernelBlobSession("ws://x", "retain2", { socketFactory: () => b });
    const blob = blobOf("b".repeat(64), 4);
    expect(kernel.retainBlob(blob)).toBe(true);
    expect(kernel.retainBlob(blob)).toBe(true);
    expect(kernel.bufferedCount).toBe(1);
    kernel.destroy();
  });

  it("returns FALSE when the byte cap would be exceeded", () => {
    const { b } = makePair();
    const kernel = createKernelBlobSession("ws://x", "retain3", {
      socketFactory: () => b,
      maxBufferedBytes: 8,
    });
    // A blob larger than the aggregate byte ceiling cannot be held.
    expect(kernel.retainBlob(blobOf("c".repeat(64), 16))).toBe(false);
    expect(kernel.hasBlob("c".repeat(64))).toBe(false);
    expect(kernel.bufferedCount).toBe(0);
    kernel.destroy();
  });

  it("a retained blob is PINNED — exceeding the count cap with other expectations never evicts it", () => {
    const { b } = makePair();
    const kernel = createKernelBlobSession("ws://x", "retain4", {
      socketFactory: () => b,
      maxBufferedBlobs: 2,
    });
    const pinned = blobOf("d".repeat(64), 4);
    expect(kernel.retainBlob(pinned)).toBe(true);
    // One more expectation fits (count = 2); a third is REFUSED, so the reserving
    // path can never push the pinned blob out (it is charged against the same cap).
    expect(kernel.expect("e".repeat(64), 4)).toBe(true);
    expect(kernel.expect("f".repeat(64), 4)).toBe(false);
    expect(kernel.hasBlob(pinned.hash)).toBe(true);
    kernel.destroy();
  });
});
