import { describe, it, expect, vi } from "vitest";
import { WebSocket as WS } from "ws";
import {
  BlobTransport,
  sha256Hex,
  encodeFrame,
  type ReceivedBlob,
  type WebSocketLike,
} from "@galley/collab";
import { startSyncServer, BLOB_SUBPROTOCOL, type SyncServerHandle } from "./index.js";

const settle = { timeout: 4000, interval: 20 };

/** A BlobTransport wired to the server's blob channel over a real ws socket. */
function blobClient(handle: SyncServerHandle, room: string, onBlob?: (b: ReceivedBlob) => void): BlobTransport {
  const url = `ws://127.0.0.1:${handle.port}/${room}`;
  return new BlobTransport(
    () => new WS(url, BLOB_SUBPROTOCOL) as unknown as WebSocketLike,
    onBlob ? { onBlob } : {},
  );
}

describe("blob relay — real websocket channel", () => {
  it("forwards a multi-chunk blob between two peers; sender done resolves on COMPLETE", async () => {
    const server = await startSyncServer(0);
    try {
      const received: ReceivedBlob[] = [];
      const sender = blobClient(server, "blobroom");
      const receiver = blobClient(server, "blobroom", (b) => received.push(b));
      sender.connect();
      receiver.connect();
      await vi.waitFor(() => expect(server.blobConnCount("blobroom")).toBe(2), settle);

      const bytes = new Uint8Array(256 * 1024 * 2 + 77).map((_, i) => (i * 31) & 0xff);
      const hash = await sha256Hex(bytes);
      receiver.expect(hash, bytes.length); // §E13 handshake-gated
      const handle = sender.send(bytes, hash, "application/octet-stream");

      await expect(handle.done).resolves.toBeUndefined();
      await vi.waitFor(() => expect(received).toHaveLength(1), settle);
      expect(received[0]!.bytes).toEqual(bytes);
      // The relay freed the transfer once COMPLETE routed back.
      await vi.waitFor(() => expect(server.blobTransferCount("blobroom")).toBe(0), settle);

      sender.disconnect();
      receiver.disconnect();
    } finally {
      await server.close();
    }
  });

  it("pushes in BOTH directions (browser ⇄ kernel symmetry), each gated by expect()", async () => {
    const server = await startSyncServer(0);
    try {
      const atA: ReceivedBlob[] = [];
      const atB: ReceivedBlob[] = [];
      const peerA = blobClient(server, "duo", (b) => atA.push(b));
      const peerB = blobClient(server, "duo", (b) => atB.push(b));
      peerA.connect();
      peerB.connect();
      await vi.waitFor(() => expect(server.blobConnCount("duo")).toBe(2), settle);

      const fromA = new Uint8Array([1, 2, 3, 4, 5]);
      const fromB = new Uint8Array(300 * 1024).map((_, i) => i & 0xff);
      const hA = await sha256Hex(fromA);
      const hB = await sha256Hex(fromB);
      peerB.expect(hA, fromA.length);
      peerA.expect(hB, fromB.length);
      await Promise.all([peerA.send(fromA, hA, "x").done, peerB.send(fromB, hB, "y").done]);

      await vi.waitFor(() => {
        expect(atB).toHaveLength(1);
        expect(atA).toHaveLength(1);
      }, settle);
      expect(atB[0]!.bytes).toEqual(fromA);
      expect(atA[0]!.bytes).toEqual(fromB);

      peerA.disconnect();
      peerB.disconnect();
    } finally {
      await server.close();
    }
  });

  it("does NOT leak a blob across distinct rooms", async () => {
    const server = await startSyncServer(0);
    try {
      const inRoom1: ReceivedBlob[] = [];
      const outsider: ReceivedBlob[] = [];
      const sender = blobClient(server, "r1");
      const peerSameRoom = blobClient(server, "r1", (b) => inRoom1.push(b));
      const peerOtherRoom = blobClient(server, "r2", (b) => outsider.push(b));
      sender.connect();
      peerSameRoom.connect();
      peerOtherRoom.connect();
      await vi.waitFor(() => {
        expect(server.blobConnCount("r1")).toBe(2);
        expect(server.blobConnCount("r2")).toBe(1);
      }, settle);

      const bytes = new Uint8Array([9, 8, 7, 6]);
      const hash = await sha256Hex(bytes);
      peerSameRoom.expect(hash, 4);
      await sender.send(bytes, hash, "x").done;
      await vi.waitFor(() => expect(inRoom1).toHaveLength(1), settle);
      await new Promise((r) => setTimeout(r, 100));
      expect(outsider).toHaveLength(0);

      sender.disconnect();
      peerSameRoom.disconnect();
      peerOtherRoom.disconnect();
    } finally {
      await server.close();
    }
  });

  it("a receiver REJECTS a corrupted transfer forwarded by the relay", async () => {
    const server = await startSyncServer(0);
    try {
      const received: ReceivedBlob[] = [];
      const url = `ws://127.0.0.1:${server.port}/poison`;
      const liar = new WS(url, BLOB_SUBPROTOCOL);
      const receiver = blobClient(server, "poison", (b) => received.push(b));
      receiver.connect();
      await vi.waitFor(() => expect(server.blobConnCount("poison")).toBe(2), settle);

      const honest = new Uint8Array([1, 2, 3, 4]);
      const liedHash = await sha256Hex(honest);
      const tampered = new Uint8Array([4, 3, 2, 1]);
      receiver.expect(liedHash, 4); // even expected, the verify gate must reject
      liar.send(encodeFrame({ kind: "header", transferId: "p", hash: liedHash, size: 4, mime: "x", totalChunks: 1 }));
      liar.send(encodeFrame({ kind: "data", transferId: "p", index: 0, bytes: tampered }));

      await new Promise((r) => setTimeout(r, 200));
      expect(received).toHaveLength(0);
      expect(receiver.inboundCount).toBe(0);

      liar.close();
      receiver.disconnect();
    } finally {
      await server.close();
    }
  });

  it("the relay DROPS a non-blob (garbage) frame instead of broadcasting it", async () => {
    const server = await startSyncServer(0);
    try {
      const received: ReceivedBlob[] = [];
      const url = `ws://127.0.0.1:${server.port}/garbage`;
      const noisy = new WS(url, BLOB_SUBPROTOCOL);
      const receiver = blobClient(server, "garbage", (b) => received.push(b));
      receiver.connect();
      await vi.waitFor(() => expect(server.blobConnCount("garbage")).toBe(2), settle);

      noisy.send(new Uint8Array([0xff, 0x00, 0x13, 0x37]));
      noisy.send(new Uint8Array(64).fill(0xab));
      await new Promise((r) => setTimeout(r, 150));
      expect(received).toHaveLength(0);

      noisy.close();
      receiver.disconnect();
    } finally {
      await server.close();
    }
  });

  it("a 3rd room peer CANNOT inject control frames into a transfer it didn't receive (§A4/§B6)", async () => {
    const server = await startSyncServer(0);
    try {
      // sender pushes to the real receiver; a malicious 3rd peer tries to forge a
      // COMPLETE to the sender. Because the real receiver binds first (it ACKs),
      // the attacker's COMPLETE is dropped — the push resolves only on the REAL
      // receiver's verified COMPLETE.
      const received: ReceivedBlob[] = [];
      const sender = blobClient(server, "trio");
      const receiver = blobClient(server, "trio", (b) => received.push(b));
      const url = `ws://127.0.0.1:${server.port}/trio`;
      const attacker = new WS(url, BLOB_SUBPROTOCOL);
      sender.connect();
      receiver.connect();
      await vi.waitFor(() => expect(server.blobConnCount("trio")).toBe(3), settle);

      const bytes = new Uint8Array(256 * 1024 + 5).map((_, i) => i & 0xff);
      const hash = await sha256Hex(bytes);
      receiver.expect(hash, bytes.length);
      const handle = sender.send(bytes, hash, "x");
      // Attacker forges a COMPLETE for the transfer (it can guess nothing useful,
      // but even given the id it must be dropped because it's not the bound
      // receiver). Spam it during the transfer.
      const forge = setInterval(() => {
        try {
          attacker.send(encodeFrame({ kind: "complete", transferId: handle.transferId, hash, size: bytes.length }));
        } catch {
          /* socket may be closing */
        }
      }, 5);

      await expect(handle.done).resolves.toBeUndefined();
      clearInterval(forge);
      // Success came from the REAL receiver (it actually has the verified bytes).
      await vi.waitFor(() => expect(received).toHaveLength(1), settle);
      expect(received[0]!.bytes).toEqual(bytes);

      attacker.close();
      sender.disconnect();
      receiver.disconnect();
    } finally {
      await server.close();
    }
  });

  it("reaps a blob room after its last connection closes", async () => {
    const server = await startSyncServer(0);
    try {
      const a = blobClient(server, "ephemeral");
      a.connect();
      await vi.waitFor(() => expect(server.blobRoomCount()).toBe(1), settle);
      a.disconnect();
      await vi.waitFor(() => expect(server.blobRoomCount()).toBe(0), settle);
    } finally {
      await server.close();
    }
  });

  it("caps peers per room (§D11): the 17th connection is refused", async () => {
    const server = await startSyncServer(0);
    try {
      const url = `ws://127.0.0.1:${server.port}/crowd`;
      const sockets: WS[] = [];
      for (let i = 0; i < 16; i++) sockets.push(new WS(url, BLOB_SUBPROTOCOL));
      await vi.waitFor(() => expect(server.blobConnCount("crowd")).toBe(16), settle);
      const overflow = new WS(url, BLOB_SUBPROTOCOL);
      const closed = await new Promise<boolean>((resolve) => {
        overflow.on("close", () => resolve(true));
        // If the socket briefly opens before the §D11 cap refuses it, poll
        // readyState until it reaches CLOSING/CLOSED within the settle window,
        // instead of a fixed one-shot dwell that could miss a slow refusal.
        overflow.on("open", () =>
          vi
            .waitFor(() => expect(overflow.readyState).toBeGreaterThanOrEqual(2), settle)
            .then(() => resolve(true), () => resolve(false)),
        );
      });
      expect(closed).toBe(true);
      expect(server.blobConnCount("crowd")).toBe(16);
      for (const s of sockets) s.close();
      overflow.close();
    } finally {
      await server.close();
    }
  });

  it("AUTH-gates the blob channel identically to sync: an unauthorized join is rejected", async () => {
    const server = await startSyncServer(0, {
      authorizeUpgrade: ({ room }) => room === "allowed",
    });
    try {
      const allowed = blobClient(server, "allowed");
      const denied = blobClient(server, "denied", undefined);
      allowed.connect();
      denied.connect();
      await vi.waitFor(() => expect(server.blobConnCount("allowed")).toBe(1), settle);
      await new Promise((r) => setTimeout(r, 150));
      expect(server.blobConnCount("denied")).toBe(0);
      expect(server.blobRoomCount()).toBe(1);

      allowed.disconnect();
      denied.disconnect();
    } finally {
      await server.close();
    }
  });

  it("a NON-BINARY frame flood is counted + drops the connection (rework rd3 §3)", async () => {
    const server = await startSyncServer(0);
    try {
      const url = `ws://127.0.0.1:${server.port}/textflood`;
      const noisy = new WS(url, BLOB_SUBPROTOCOL);
      await new Promise<void>((resolve) => noisy.on("open", () => resolve()));
      await vi.waitFor(() => expect(server.blobConnCount("textflood")).toBe(1), settle);
      // A burst of TEXT (non-binary) frames. Previously these `return`ed before the
      // rate counter, bypassing the limit; now each counts and a non-binary frame
      // on the blob socket drops the conn outright.
      const closed = new Promise<boolean>((resolve) => {
        noisy.on("close", () => resolve(true));
      });
      for (let i = 0; i < 50; i++) {
        try {
          noisy.send("not-binary");
        } catch {
          break; // socket already closing
        }
      }
      expect(await Promise.race([closed, new Promise<boolean>((r) => setTimeout(() => r(false), 1500))])).toBe(true);
      await vi.waitFor(() => expect(server.blobConnCount("textflood")).toBe(0), settle);
    } finally {
      await server.close();
    }
  });

  it("the existing sync socket still works alongside the blob channel (no subprotocol regression)", async () => {
    const server = await startSyncServer(0);
    try {
      const url = `ws://127.0.0.1:${server.port}/syncroom`;
      const plain = new WS(url);
      await vi.waitFor(() => expect(server.roomCount()).toBe(1), settle);
      expect(server.blobRoomCount()).toBe(0);
      expect(plain.protocol).toBe("");
      plain.close();
    } finally {
      await server.close();
    }
  });
});
