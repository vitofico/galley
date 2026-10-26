import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import {
  CollabProject,
  CollabConnection,
  WebSocketTransport,
  restoreDoc,
  type WebSocketLike,
} from "@galley/collab";
import type { CrdtStore } from "@galley/shared";
import { connectDraftPublisher } from "./draft-publisher.js";
const serverModule = "../../../apps/sync/src/sync-server.js";
const fsModule = "../../persistence/src/fs.js";
interface Server {
  port: number;
  close(): Promise<void>;
}
interface Options {
  crdtStore: CrdtStore;
  storageQuota?: {
    getCaps(room: string): Promise<{ maxContentBytes: number }>;
  };
}
async function start(options: Options): Promise<Server> {
  return (await import(serverModule)).startSyncServer(0, options);
}
async function makeStore(root: string): Promise<CrdtStore> {
  const { FsCrdtStore } = await import(fsModule);
  return new FsCrdtStore(root);
}
const human = { kind: "human", userId: "owner" } as const;
it("re-offers all initial peer state when a delayed quota becomes available without another local edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "delayed-quota-peer-"));
  const store = await makeStore(root);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const server = await start({
    crdtStore: store,
    storageQuota: {
      getCaps: async () => {
        await gate;
        return { maxContentBytes: 1000000 };
      },
    },
  });
  const project = new CollabProject();
  project.create("/main.typ", "= Full initial state\n", human);
  project.create("/other.typ", "extra", human);
  const connection = new CollabConnection(
    project,
    new WebSocketTransport(
      () =>
        new WebSocket(
          `ws://127.0.0.1:${server.port}/room`,
        ) as unknown as WebSocketLike,
    ),
    { author: human },
  );
  const refusals: string[] = [];
  connection.onStorageFull((info) => {
    refusals.push(info.reason);
  });
  try {
    connection.connect();
    await vi.waitFor(() => expect(refusals).toContain("quota-unavailable"));
    expect(await store.loadUpdates("room")).toEqual([]);
    release();
    await vi.waitFor(
      async () => {
        const doc = new CollabProject(
          restoreDoc(await store.loadUpdates("room")),
        );
        try {
          expect(
            doc
              .snapshot()
              .files.filter((f) => !f.deleted)
              .map((f) => [f.path, f.text]),
          ).toEqual([
            ["/main.typ", "= Full initial state\n"],
            ["/other.typ", "extra"],
          ]);
        } finally {
          doc.doc.destroy();
        }
      },
      { timeout: 2000 },
    );
  } finally {
    release();
    connection.destroy();
    project.doc.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("preserves early headless handshake probes across a delayed room load so a real draft flush confirms delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "delayed-load-flush-"));
  const base = await makeStore(root);
  let release!: () => void, began!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const loaded = new Promise<void>((r) => {
    began = r;
  });
  const store: CrdtStore = {
    appendUpdate: (id, u) => base.appendUpdate(id, u),
    compact: (id) => base.compact(id),
    loadUpdates: async (id) => {
      began();
      await gate;
      return base.loadUpdates(id);
    },
  };
  const server = await start({ crdtStore: store });
  const publisher = connectDraftPublisher({
    syncUrl: `ws://127.0.0.1:${server.port}`,
    room: "room",
  });
  try {
    await loaded;
    await new Promise((r) => setTimeout(r, 30));
    release();
    await publisher.whenSynced(1000);
    const id = await publisher.publishFileProposal({
      request: "draft",
      runId: "one-run",
      ops: [
        {
          kind: "create",
          path: "/draft.typ",
          baseText: "",
          proposedText: "new draft",
          blocks: [],
        },
      ],
    });
    await publisher.flush(500);
    const doc = new CollabProject(restoreDoc(await base.loadUpdates("room")));
    try {
      const { getFileProposals } = await import("@galley/collab");
      expect(getFileProposals(doc).map((p) => p.id)).toContain(id);
    } finally {
      doc.doc.destroy();
    }
  } finally {
    release();
    publisher.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("does not report a draft delivered while growth is refused; a quota recovery replays the same draft and confirms a fresh probe", async () => {
  const root = await mkdtemp(join(tmpdir(), "delayed-quota-flush-"));
  const store = await makeStore(root);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const server = await start({
    crdtStore: store,
    storageQuota: {
      getCaps: async () => {
        await gate;
        return { maxContentBytes: 1000000 };
      },
    },
  });
  const publisher = connectDraftPublisher({
    syncUrl: `ws://127.0.0.1:${server.port}`,
    room: "room",
  });
  try {
    await publisher.whenSynced(1000);
    const id = await publisher.publishFileProposal({
      request: "draft",
      runId: "one-run",
      ops: [
        {
          kind: "create",
          path: "/draft.typ",
          baseText: "",
          proposedText: "new draft",
          blocks: [],
        },
      ],
    });
    let done = false;
    const flush = publisher.flush(1500).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(done).toBe(false);
    release();
    await flush;
    const doc = new CollabProject(restoreDoc(await store.loadUpdates("room")));
    try {
      const { getFileProposals } = await import("@galley/collab");
      expect(getFileProposals(doc).map((p) => p.id)).toEqual([id]);
    } finally {
      doc.doc.destroy();
    }
  } finally {
    release();
    publisher.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("keeps reads available during policy failure and recovers existing local state after a read-triggered refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "failed-quota-recovery-"));
  const store = await makeStore(root);
  let calls = 0;
  const server = await start({
    crdtStore: store,
    storageQuota: {
      getCaps: async () => {
        if (++calls === 1) throw new Error("offline");
        return { maxContentBytes: 1000000 };
      },
    },
  });
  const project = new CollabProject();
  project.create("/main.typ", "recover original", human);
  let socket!: WebSocket;
  const connection = new CollabConnection(
    project,
    new WebSocketTransport(() => {
      socket = new WebSocket(`ws://127.0.0.1:${server.port}/room`);
      return socket as unknown as WebSocketLike;
    }),
    { author: human },
  );
  let refused = false;
  connection.onStorageFull(() => {
    refused = true;
  });
  try {
    connection.connect();
    await vi.waitFor(() => expect(refused).toBe(true));
    await vi.waitFor(() => expect(connection.synced).toBe(true));
    expect(await store.loadUpdates("room")).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 5050));
    const encoding = await import("lib0/encoding"),
      sync = await import("y-protocols/sync");
    const probe = encoding.createEncoder();
    encoding.writeVarUint(probe, 0);
    sync.writeSyncStep1(probe, project.doc);
    socket.send(encoding.toUint8Array(probe));
    await vi.waitFor(
      async () => {
        const restored = new CollabProject(
          restoreDoc(await store.loadUpdates("room")),
        );
        try {
          expect(restored.snapshot().files[0]?.text).toBe("recover original");
        } finally {
          restored.doc.destroy();
        }
      },
      { timeout: 2000 },
    );
    expect(calls).toBe(2);
  } finally {
    connection.destroy();
    project.doc.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
it("never acknowledges a quota-refused draft from an unrelated read reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "refused-quota-flush-"));
  const store = await makeStore(root);
  const server = await start({
    crdtStore: store,
    storageQuota: { getCaps: async () => ({ maxContentBytes: 0 }) },
  });
  const publisher = connectDraftPublisher({
    syncUrl: `ws://127.0.0.1:${server.port}`,
    room: "room",
  });
  try {
    await publisher.whenSynced(1000);
    await publisher.publishFileProposal({
      request: "blocked",
      runId: "blocked-run",
      ops: [
        {
          kind: "create",
          path: "/blocked.typ",
          baseText: "",
          proposedText: "blocked",
          blocks: [],
        },
      ],
    });
    await expect(publisher.flush(150)).rejects.toThrow("flush timed out");
    expect(await store.loadUpdates("room")).toEqual([]);
  } finally {
    publisher.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("retains early probes behind the actual required session/membership gate during delayed authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "required-auth-flush-"));
  const configModule = "../../../apps/sync/src/server-config.js",
    authModule = "../../persistence/src/fs-auth-stores.js";
  const { FsProjectStore } = await import(fsModule);
  await new FsProjectStore(root).createProject({
    id: "room",
    name: "Room",
    ownerId: "alice",
  });
  const { FsSessionStore } = await import(authModule);
  const session = await new FsSessionStore(root).create({
    userId: "alice",
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60000,
  });
  const options = (await import(configModule)).buildSyncOptions({
    GALLEY_SYNC_AUTH: "required",
    GALLEY_SESSION_DIR: root,
    GALLEY_DATA_DIR: root,
    GALLEY_SYNC_PERSIST_DIR: root,
    GALLEY_SYNC_ALLOWED_ORIGINS: "https://editor.test",
    GALLEY_INSECURE_COOKIES: "1",
    GALLEY_SYNC_DURABLE_DELIVERY: "1",
  });
  const realAuthorize = options.authorizeUpgrade;
  let release!: () => void, began!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    authorizing = new Promise<void>((r) => {
      began = r;
    });
  options.authorizeUpgrade = async (context: unknown) => {
    began();
    await gate;
    return realAuthorize(context);
  };
  const server = await start(options);
  const publisher = connectDraftPublisher(
    { syncUrl: `ws://127.0.0.1:${server.port}`, room: "room" },
    {
      requireDurableDelivery: true,
      socketFactory: (url) =>
        new WebSocket(url, {
          origin: "https://editor.test",
          headers: { cookie: `galley.sid=${session.id}` },
        }) as unknown as WebSocketLike,
    },
  );
  try {
    let synced = false;
    const ready = publisher.whenSynced(1500).then(() => {
      synced = true;
    });
    void ready.catch(() => undefined);
    await authorizing;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(synced).toBe(false);
    release();
    await ready;
    const id = await publisher.publishFileProposal({
      request: "authorized draft",
      runId: "authorized-run",
      ops: [
        {
          kind: "create",
          path: "/draft.typ",
          baseText: "",
          proposedText: "authorized",
          blocks: [],
        },
      ],
    });
    await publisher.flush(700);
    const restored = new CollabProject(
      restoreDoc(await options.crdtStore.loadUpdates("room")),
    );
    try {
      const { getFileProposals } = await import("@galley/collab");
      expect(getFileProposals(restored).map((proposal) => proposal.id)).toEqual(
        [id],
      );
    } finally {
      restored.doc.destroy();
    }
  } finally {
    release();
    publisher.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
