import type { IncomingMessage } from "node:http";
import { expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import {
  BlobTransport,
  CollabProject,
  sha256Hex,
  restoreDoc,
  type WebSocketLike,
} from "@galley/collab";
import {
  FsCrdtStore,
  FsHostedStorage,
  FsProjectStore,
} from "@galley/persistence";
import * as Y from "yjs";
import { AggregateStorageQuota } from "./aggregate-storage-quota.js";
import { HOSTED_BLOB_SUBPROTOCOL } from "./hosted-blob-handler.js";
import { startSyncServer, type SyncServerHandle } from "./sync-server.js";
const origin = "https://editor.test";
const human = { kind: "human", userId: "alice" } as const;
it("stores verified bytes without another peer, restores after restart, serves owned history and purges both behind a durable fence", async () => {
  const root = await mkdtemp(join(tmpdir(), "hosted-protocol-"));
  let server: SyncServerHandle | undefined;
  const clients: BlobTransport[] = [];
  try {
    await new FsProjectStore(root).createProject({
      id: "room",
      name: "Room",
      ownerId: "alice",
    });
    await new FsProjectStore(root).createProject({
      id: "other",
      name: "Other",
      ownerId: "bob",
    });
    const project = new CollabProject();
    project.create("/main.typ", "durable version", human);
    const bytes = new Uint8Array(300 * 1024).map((_, i) => i % 255);
    const hash = await sha256Hex(bytes);
    project.createBinary(
      "/figure.png",
      { type: "binary", hash, size: bytes.byteLength, mime: "image/png" },
      human,
    );
    await new FsCrdtStore(root).appendUpdate(
      "room",
      Y.encodeStateAsUpdate(project.doc),
    );
    project.doc.destroy();
    const options = () => {
      const quota = new AggregateStorageQuota({
        dataDir: root,
        persistDir: root,
        policy: async () => ({
          maxBytes: 1024 * 1024,
          expiresAt: Date.now() + 60000,
        }),
      });
      return {
        crdtStore: new FsCrdtStore(root),
        storageQuota: quota,
        hostedStorage: new FsHostedStorage(root, quota),
        allowedOrigins: [origin],
        authorizeUpgrade: async ({
          room,
          req,
        }: {
          room: string;
          req: IncomingMessage;
        }) => room === "room" && req.headers.cookie === "session=alice",
      };
    };
    server = await startSyncServer(0, options());
    const open = (
      onBlob?: (blob: { bytes: Uint8Array }) => void,
      room = "room",
    ) => {
      const transport = new BlobTransport(
        () =>
          new WebSocket(
            `ws://127.0.0.1:${server!.port}/${room}`,
            HOSTED_BLOB_SUBPROTOCOL,
            { origin, headers: { cookie: "session=alice" } },
          ) as unknown as WebSocketLike,
        { reconnect: false, ...(onBlob ? { onBlob } : {}) },
      );
      clients.push(transport);
      transport.connect();
      return transport;
    };
    const sender = open();
    await sender.send(bytes, hash, "image/png").done;
    expect(
      new Uint8Array(
        await readFile(join(root, "assets", "room", `${hash}.bin`)),
      ),
    ).toEqual(bytes);
    const http = () => `http://127.0.0.1:${server!.port}/history/room`;
    expect((await fetch(http())).status).toBe(403);
    expect(
      (
        await fetch(http(), {
          method: "POST",
          headers: { cookie: "session=alice" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(http(), {
          method: "POST",
          headers: { cookie: "session=alice", origin: "https://evil.test" },
        })
      ).status,
    ).toBe(403);
    const saved = await fetch(http(), {
      method: "POST",
      headers: { cookie: "session=alice", origin },
    });
    expect(saved.status).toBe(201);
    const checkpoint = (await saved.json()) as { id: string };
    const history = await fetch(http(), {
      headers: { cookie: "session=alice", origin },
    });
    expect(history.headers.get("access-control-allow-origin")).toBe(origin);
    expect(await history.json()).toEqual([
      expect.objectContaining({ id: checkpoint.id }),
    ]);
    const update = new Uint8Array(
      await (
        await fetch(`${http()}/${checkpoint.id}`, {
          headers: { cookie: "session=alice", origin },
        })
      ).arrayBuffer(),
    );
    const restored = new CollabProject(restoreDoc(update));
    expect(restored.snapshot().binaryFiles?.[0]?.hash).toBe(hash);
    expect(restored.snapshot().files[0]?.text).toBe("durable version");
    restored.doc.destroy();
    sender.disconnect();
    await server.close();
    server = await startSyncServer(0, options());
    let received: Uint8Array | undefined;
    const reader = open((blob) => {
      received = blob.bytes;
    });
    expect(reader.request(hash, bytes.byteLength)).toBe(true);
    await vi.waitFor(() => expect(received).toEqual(bytes), { timeout: 4000 });
    let forbidden = false;
    const denied = new WebSocket(
      `ws://127.0.0.1:${server.port}/other`,
      HOSTED_BLOB_SUBPROTOCOL,
      { origin, headers: { cookie: "session=alice" } },
    );
    denied.on("error", () => undefined);
    denied.on("close", (code) => {
      forbidden = code === 1008;
    });
    await vi.waitFor(() => expect(forbidden).toBe(true));
    await server.retireRoom("room");
    await expect(
      readFile(join(root, "assets", "room", `${hash}.bin`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(root, "history", "room", `${checkpoint.id}.bin`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await fetch(http(), { headers: { cookie: "session=alice", origin } }))
        .status,
    ).toBe(403);
    await expect(
      options().hostedStorage.putAsset("room", hash, bytes),
    ).rejects.toThrow("retired");
  } finally {
    for (const client of clients) client.disconnect();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
it("rejects corrupt uploads and owner-budget overflow without acknowledging durable success", async () => {
  const root = await mkdtemp(join(tmpdir(), "hosted-deny-"));
  let server: SyncServerHandle | undefined;
  let client: BlobTransport | undefined;
  try {
    await new FsProjectStore(root).createProject({
      id: "room",
      name: "Room",
      ownerId: "alice",
    });
    const quota = new AggregateStorageQuota({
      dataDir: root,
      persistDir: root,
      policy: async () => ({ maxBytes: 10, expiresAt: Date.now() + 60000 }),
    });
    server = await startSyncServer(0, {
      crdtStore: new FsCrdtStore(root),
      hostedStorage: new FsHostedStorage(root, quota),
      storageQuota: quota,
      authorizeUpgrade: async () => true,
    });
    client = new BlobTransport(
      () =>
        new WebSocket(
          `ws://127.0.0.1:${server!.port}/room`,
          HOSTED_BLOB_SUBPROTOCOL,
        ) as unknown as WebSocketLike,
      { reconnect: false },
    );
    client.connect();
    await expect(
      client.send(new Uint8Array([1]), "0".repeat(64), "image/png").done,
    ).rejects.toThrow();
    const bytes = new Uint8Array(11);
    const hash = await sha256Hex(bytes);
    await expect(client.send(bytes, hash, "image/png").done).rejects.toThrow(
      "store-failed",
    );
    await expect(
      readFile(join(root, "assets", "room", `${hash}.bin`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    client?.disconnect();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("holds completed transfer reservations through storage, rejects id reuse and drains in-flight writes at shutdown", async () => {
  const { planTransfer, encodeFrame } = await import("@galley/collab");
  let unblock!: () => void, began!: () => void;
  const gate = new Promise<void>((r) => {
    unblock = r;
  });
  const started = new Promise<void>((r) => {
    began = r;
  });
  const putAsset = vi.fn(async () => {
    began();
    await gate;
  });
  const server = await startSyncServer(0, {
    authorizeUpgrade: async () => true,
    hostedStorage: {
      putAsset,
      getAsset: async () => undefined,
      checkpoint: async () => undefined,
      listCheckpoints: async () => [],
      getCheckpoint: async () => undefined,
      retire: async () => undefined,
    },
  });
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.port}/room`,
    HOSTED_BLOB_SUBPROTOCOL,
  );
  socket.on("error", () => undefined);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const bytes = new Uint8Array([1, 2, 3]);
    const planned = planTransfer(
      "reused",
      bytes,
      await sha256Hex(bytes),
      "image/png",
    );
    socket.send(encodeFrame(planned.header));
    for (const data of planned.data) socket.send(encodeFrame(data));
    await started;
    socket.send(encodeFrame(planned.header));
    for (const data of planned.data) socket.send(encodeFrame(data));
    await new Promise((r) => setTimeout(r, 20));
    expect(putAsset).toHaveBeenCalledTimes(1);
    let done = false;
    const closing = server.close().then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    unblock();
    await closing;
  } finally {
    unblock();
    socket.terminate();
    await server.close().catch(() => undefined);
  }
});
it("charges actual read capacity before trusting a peer's tiny declared size and retains it across disconnect", async () => {
  const { encodeFrame } = await import("@galley/collab");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0,
    active = 0,
    peak = 0;
  const server = await startSyncServer(0, {
    authorizeUpgrade: async () => true,
    hostedStorage: {
      putAsset: async () => undefined,
      getAsset: async () => {
        reads++;
        active++;
        peak = Math.max(peak, active);
        await gate;
        active--;
        return undefined;
      },
      checkpoint: async () => undefined,
      listCheckpoints: async () => [],
      getCheckpoint: async () => undefined,
      retire: async () => undefined,
    },
  });
  const sockets: WebSocket[] = [];
  try {
    for (let n = 0; n < 3; n++) {
      const socket = new WebSocket(
        `ws://127.0.0.1:${server.port}/room`,
        HOSTED_BLOB_SUBPROTOCOL,
      );
      socket.on("error", () => undefined);
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
    }
    const request = (n: number, id: string) =>
      sockets[n]!.send(
        encodeFrame({
          kind: "request",
          transferId: id,
          hash: "a".repeat(64),
          size: 1,
        }),
      );
    request(0, "one");
    request(1, "two");
    await vi.waitFor(() => expect(active).toBe(2));
    request(2, "three");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(reads).toBe(2);
    sockets[0]!.terminate();
    request(2, "after-disconnect");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(reads).toBe(2);
    release();
    await vi.waitFor(() => expect(active).toBe(0));
    request(2, "after-release");
    await vi.waitFor(() => expect(reads).toBe(3));
    expect(peak).toBe(2);
  } finally {
    release();
    for (const socket of sockets) socket.terminate();
    await server.close();
  }
});
it("uploads and retrieves four assets through bounded busy periods without edits or reconnects", async () => {
  const browserModule = "../../web/src/blob-session.js";
  const { createBlobChannelSession } = await import(browserModule);
  const { InMemoryBlobStore } = await import("@galley/collab");
  const root = await mkdtemp(join(tmpdir(), "hosted-four-assets-"));
  await new FsProjectStore(root).createProject({
    id: "room",
    name: "Room",
    ownerId: "alice",
  });
  const quota = new AggregateStorageQuota({
      dataDir: root,
      persistDir: root,
      policy: async () => ({
        maxBytes: 1000000,
        expiresAt: Date.now() + 60000,
      }),
    }),
    storage = new FsHostedStorage(root, quota);
  let releaseUploads!: () => void,
    releaseReads!: () => void,
    puts = 0,
    reads = 0;
  const uploadGate = new Promise<void>((r) => {
      releaseUploads = r;
    }),
    readGate = new Promise<void>((r) => {
      releaseReads = r;
    });
  const server = await startSyncServer(0, {
    crdtStore: new FsCrdtStore(root),
    hostedStorage: {
      putAsset: async (room, hash, bytes) => {
        if (++puts <= 2) await uploadGate;
        await storage.putAsset(room, hash, bytes);
      },
      getAsset: async (room, hash) => {
        if (++reads <= 2) await readGate;
        return storage.getAsset(room, hash);
      },
      checkpoint: (room, bytes) => storage.checkpoint(room, bytes),
      listCheckpoints: (room) => storage.listCheckpoints(room),
      getCheckpoint: (room, id) => storage.getCheckpoint(room, id),
      retire: (room) => storage.retire(room),
    },
    authorizeUpgrade: async () => true,
  });
  const source = new InMemoryBlobStore(),
    destination = new InMemoryBlobStore();
  const fixtures: Array<{
    bytes: Uint8Array;
    hash: string;
    size: number;
    mime: string;
  }> = [];
  for (let n = 0; n < 4; n++) {
    const bytes = new Uint8Array([n + 1, n + 2, n + 3]),
      asset = await source.put(bytes, { mime: "image/png" });
    await source.markServable(asset.hash);
    fixtures.push({ bytes, ...asset });
  }
  let senderOpens = 0,
    readerOpens = 0;
  const peer = (url: string) =>
    new WebSocket(url, "galley-blob-v1") as unknown as WebSocketLike;
  const sender = createBlobChannelSession(
    `ws://127.0.0.1:${server.port}`,
    "room",
    source,
    {
      hosted: true,
      socketFactory: peer,
      hostedSocketFactory: (url: string) => {
        senderOpens++;
        return new WebSocket(
          url,
          HOSTED_BLOB_SUBPROTOCOL,
        ) as unknown as WebSocketLike;
      },
    },
  );
  const receiver = createBlobChannelSession(
    `ws://127.0.0.1:${server.port}`,
    "room",
    destination,
    {
      hosted: true,
      socketFactory: peer,
      hostedSocketFactory: (url: string) => {
        readerOpens++;
        return new WebSocket(
          url,
          HOSTED_BLOB_SUBPROTOCOL,
        ) as unknown as WebSocketLike;
      },
    },
  );
  try {
    sender.connect();
    const uploads = Promise.all(
      fixtures.map((asset) =>
        sender.persist(asset.bytes, asset.hash, asset.mime),
      ),
    );
    void uploads.catch(() => undefined);
    await vi.waitFor(() => expect(puts).toBe(2));
    await new Promise((r) => setTimeout(r, 650));
    expect(puts).toBe(2);
    releaseUploads();
    await uploads;
    for (const fixture of fixtures)
      expect(await storage.getAsset("room", fixture.hash)).toEqual(
        fixture.bytes,
      );
    sender.destroy();
    receiver.connect();
    for (const fixture of fixtures)
      expect(receiver.expect(fixture.hash, fixture.size)).toBe(true);
    await vi.waitFor(() => expect(reads).toBe(2));
    await new Promise((r) => setTimeout(r, 650));
    expect(reads).toBe(2);
    releaseReads();
    await vi.waitFor(
      async () => {
        for (const fixture of fixtures)
          expect(await destination.get(fixture.hash)).toEqual(fixture.bytes);
      },
      { timeout: 4000 },
    );
    expect(senderOpens).toBe(1);
    expect(readerOpens).toBe(1);
  } finally {
    releaseUploads();
    releaseReads();
    sender.destroy();
    receiver.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
