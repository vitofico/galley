import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollabProject, restoreDoc, getFileProposals } from "@galley/collab";
import type { CrdtStore } from "@galley/shared";
import { connectDraftPublisher } from "./draft-publisher.js";
const serverModule = "../../../apps/sync/src/sync-server.js",
  fsModule = "../../persistence/src/fs.js";
interface Server {
  port: number;
  close(): Promise<void>;
}
interface Options {
  crdtStore?: CrdtStore;
  durableDelivery?: boolean;
  storageQuota?: {
    getCaps(room: string): Promise<{ maxContentBytes: number }>;
  };
}
async function start(options: Options): Promise<Server> {
  return (await import(serverModule)).startSyncServer(0, options);
}
async function makeStore(root: string): Promise<CrdtStore> {
  return new (await import(fsModule)).FsCrdtStore(root);
}
const proposal = {
  request: "durable draft",
  runId: "durable-run",
  ops: [
    {
      kind: "create" as const,
      path: "/draft.typ",
      baseText: "",
      proposedText: "= Durable\n",
      blocks: [],
    },
  ],
};
function connect(server: Server) {
  return connectDraftPublisher(
    { syncUrl: `ws://127.0.0.1:${server.port}`, room: "room" },
    { requireDurableDelivery: true },
  );
}
async function persisted(store: CrdtStore): Promise<string[]> {
  const doc = new CollabProject(restoreDoc(await store.loadUpdates("room")));
  try {
    return getFileProposals(doc).map((row) => row.id);
  } finally {
    doc.doc.destroy();
  }
}
it("acknowledges only after the filesystem flush and restores the proposal from actual bytes on a new relay", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-restart-"));
  const base = await makeStore(root);
  let flushed = false;
  const store: CrdtStore = {
    appendUpdate: (id, u) => base.appendUpdate(id, u),
    loadUpdates: (id) => base.loadUpdates(id),
    compact: (id) => base.compact(id),
    flush: async (id) => {
      await base.flush!(id);
      flushed = true;
    },
  };
  let server = await start({ crdtStore: store, durableDelivery: true });
  const publisher = connect(server);
  try {
    await publisher.whenSynced();
    const id = await publisher.publishFileProposal(proposal);
    await publisher.flush(2000);
    expect(flushed).toBe(true);
    expect(await persisted(await makeStore(root))).toEqual([id]);
    publisher.destroy();
    await server.close();
    await base.flush!("room");
    server = await start({
      crdtStore: await makeStore(root),
      durableDelivery: true,
    });
    const restarted = connect(server);
    try {
      await restarted.whenSynced();
      expect(restarted.getFileProposals().map((row) => row.id)).toEqual([id]);
      await restarted.flush(2000);
    } finally {
      restarted.destroy();
    }
  } finally {
    publisher.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("holds acknowledgement until all prior append operations settle", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-append-gate-"));
  const base = await makeStore(root);
  let release!: () => void, began!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      began = r;
    });
  const store: CrdtStore = {
    appendUpdate: async (id, u) => {
      began();
      await gate;
      await base.appendUpdate(id, u);
    },
    loadUpdates: (id) => base.loadUpdates(id),
    compact: (id) => base.compact(id),
    flush: (id) => base.flush!(id),
  };
  const server = await start({ crdtStore: store, durableDelivery: true }),
    publisher = connect(server);
  try {
    await publisher.whenSynced();
    const id = await publisher.publishFileProposal(proposal);
    let done = false;
    const pending = publisher.flush(2000).then(() => {
      done = true;
    });
    void pending.catch(() => undefined);
    await started;
    await new Promise((r) => setTimeout(r, 40));
    expect(done).toBe(false);
    release();
    await pending;
    expect(await persisted(await makeStore(root))).toEqual([id]);
  } finally {
    release();
    publisher.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("waits for the backend flush and fails closed on its deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-flush-gate-"));
  const base = await makeStore(root);
  let release!: () => void, began!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      began = r;
    });
  const store: CrdtStore = {
    appendUpdate: (id, u) => base.appendUpdate(id, u),
    loadUpdates: (id) => base.loadUpdates(id),
    compact: (id) => base.compact(id),
    flush: async (id) => {
      began();
      await gate;
      await base.flush!(id);
    },
  };
  const server = await start({ crdtStore: store, durableDelivery: true }),
    publisher = connect(server);
  try {
    await publisher.whenSynced();
    await publisher.publishFileProposal(proposal);
    const pending = publisher.flush(150);
    void pending.catch(() => undefined);
    await started;
    await expect(pending).rejects.toThrow("durable delivery timed out");
    release();
    await publisher.flush(2000);
  } finally {
    release();
    publisher.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("latches an append failure so later successful writes cannot produce a false durable ack", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-append-failure-"));
  const base = await makeStore(root);
  let fail = true,
    began!: () => void;
  const failed = new Promise<void>((r) => {
    began = r;
  });
  const flush = vi.fn((id: string) => base.flush!(id));
  const store: CrdtStore = {
    appendUpdate: async (id, u) => {
      if (fail) {
        began();
        throw new Error("synthetic append failure");
      }
      await base.appendUpdate(id, u);
    },
    loadUpdates: (id) => base.loadUpdates(id),
    compact: (id) => base.compact(id),
    flush,
  };
  const server = await start({ crdtStore: store, durableDelivery: true }),
    publisher = connect(server);
  try {
    await publisher.whenSynced();
    await failed;
    fail = false;
    await publisher.publishFileProposal(proposal);
    await expect(publisher.flush(1000)).rejects.toThrow(
      "durable delivery unavailable or refused",
    );
    expect(flush).not.toHaveBeenCalled();
  } finally {
    publisher.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
it.each([false, true])(
  "refuses required durability when relay opt-in is absent (persisted=%s)",
  async (persistedStore) => {
    const root = await mkdtemp(join(tmpdir(), "durable-unsupported-"));
    const server = await start(
        persistedStore ? { crdtStore: await makeStore(root) } : {},
      ),
      publisher = connect(server);
    try {
      await publisher.whenSynced();
      await publisher.publishFileProposal(proposal);
      await expect(publisher.close(1000)).rejects.toThrow(
        "durable delivery unavailable or refused",
      );
    } finally {
      publisher.destroy();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
it("does not acknowledge a quota-refused proposal even with durability enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-refused-"));
  const store = await makeStore(root);
  const server = await start({
      crdtStore: store,
      durableDelivery: true,
      storageQuota: { getCaps: async () => ({ maxContentBytes: 0 }) },
    }),
    publisher = connect(server);
  try {
    await publisher.whenSynced();
    await publisher.publishFileProposal(proposal);
    await expect(publisher.flush(150)).rejects.toThrow("refused growth");
    expect(await store.loadUpdates("room")).toEqual([]);
  } finally {
    publisher.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("supports delayed quota admission without retrying or duplicating the durable proposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-quota-recovery-"));
  const store = await makeStore(root);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const server = await start({
      crdtStore: store,
      durableDelivery: true,
      storageQuota: {
        getCaps: async () => {
          await gate;
          return { maxContentBytes: 1000000 };
        },
      },
    }),
    publisher = connect(server);
  try {
    await publisher.whenSynced();
    const id = await publisher.publishFileProposal(proposal);
    let done = false;
    const pending = publisher.flush(2000).then(() => {
      done = true;
    });
    void pending.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    release();
    await pending;
    expect(await persisted(await makeStore(root))).toEqual([id]);
  } finally {
    release();
    publisher.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("ignores an acknowledgement for a different token while the real filesystem flush is pending", async () => {
  const { WebSocket } = await import("ws");
  const { encodeDurableDelivery } = await import("@galley/collab");
  const root = await mkdtemp(join(tmpdir(), "durable-token-"));
  const base = await makeStore(root);
  let release!: () => void, began!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      began = r;
    });
  const server = await start({
    durableDelivery: true,
    crdtStore: {
      appendUpdate: (id, u) => base.appendUpdate(id, u),
      loadUpdates: (id) => base.loadUpdates(id),
      compact: (id) => base.compact(id),
      flush: async (id) => {
        began();
        await gate;
        await base.flush!(id);
      },
    },
  });
  const listeners = new Set<(event: unknown) => void>();
  const publisher = connectDraftPublisher(
    { syncUrl: `ws://127.0.0.1:${server.port}`, room: "room" },
    {
      requireDurableDelivery: true,
      socketFactory: (url) => {
        const socket = new WebSocket(url);
        return {
          get readyState() {
            return socket.readyState;
          },
          binaryType: "arraybuffer",
          send: (data) => socket.send(data),
          close: () => socket.close(),
          addEventListener: (type, listener) => {
            if (type === "message") listeners.add(listener);
            socket.addEventListener(type as "message", listener);
          },
          removeEventListener: (type, listener) => {
            listeners.delete(listener);
            socket.removeEventListener(type as "message", listener);
          },
        };
      },
    },
  );
  try {
    await publisher.whenSynced();
    await publisher.publishFileProposal(proposal);
    let done = false;
    const pending = publisher.flush(2000).then(() => {
      done = true;
    });
    void pending.catch(() => undefined);
    await started;
    const wrong = encodeDurableDelivery({
      kind: "complete",
      token: "wrong-token-000000000000000000000000",
    });
    for (const listener of listeners) listener({ data: wrong });
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    release();
    await pending;
  } finally {
    release();
    publisher.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("bounds probe work per socket and globally, retaining slots until delayed backend work settles after disconnect", async () => {
  const { WebSocket } = await import("ws"),
    { encodeDurableDelivery, decodeDurableDelivery } =
      await import("@galley/collab");
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0,
    active = 0,
    peak = 0;
  const replies: Array<{ kind: string; token: string }> = [];
  const server = await start({
    durableDelivery: true,
    crdtStore: {
      appendUpdate: async () => undefined,
      loadUpdates: async () => [],
      compact: async () => undefined,
      flush: async () => {
        calls++;
        active++;
        peak = Math.max(peak, active);
        await gate;
        active--;
      },
    },
  });
  const sockets: InstanceType<typeof WebSocket>[] = [];
  const open = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/room`);
    socket.on("error", () => undefined);
    socket.on("message", (data) => {
      const bytes = new Uint8Array(data as Buffer);
      if (bytes[0] === 5) replies.push(decodeDurableDelivery(bytes));
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return socket;
  };
  try {
    for (let n = 0; n < 9; n++) {
      const socket = await open();
      for (let k = 0; k < 8; k++)
        socket.send(
          encodeDurableDelivery({
            kind: "request",
            token: `probe-${String(n * 8 + k).padStart(20, "0")}`,
            stateVector: new Uint8Array([0]),
          }),
        );
    }
    await vi.waitFor(() => expect(calls).toBe(64));
    await vi.waitFor(() =>
      expect(
        replies.filter((reply) => reply.kind === "unavailable"),
      ).toHaveLength(8),
    );
    sockets[0]!.terminate();
    const extra = await open();
    extra.send(
      encodeDurableDelivery({
        kind: "request",
        token: "probe-after-disconnect-000",
        stateVector: new Uint8Array([0]),
      }),
    );
    await vi.waitFor(() =>
      expect(
        replies.some(
          (reply) =>
            reply.token === "probe-after-disconnect-000" &&
            reply.kind === "unavailable",
        ),
      ).toBe(true),
    );
    expect(calls).toBe(64);
    release();
    await vi.waitFor(() => expect(active).toBe(0));
    extra.send(
      encodeDurableDelivery({
        kind: "request",
        token: "probe-after-release-00000",
        stateVector: new Uint8Array([0]),
      }),
    );
    await vi.waitFor(() =>
      expect(
        replies.some(
          (reply) =>
            reply.token === "probe-after-release-00000" &&
            reply.kind === "complete",
        ),
      ).toBe(true),
    );
    expect(peak).toBe(64);
  } finally {
    release();
    for (const socket of sockets) socket.terminate();
    await server.close();
  }
});
it("rejects missing client clocks and oversized client counts before asking the store to flush", async () => {
  const { WebSocket } = await import("ws"),
    { encodeDurableDelivery, decodeDurableDelivery } =
      await import("@galley/collab"),
    Y = await import("yjs"),
    encoding = await import("lib0/encoding");
  const flush = vi.fn(async () => undefined),
    server = await start({
      durableDelivery: true,
      crdtStore: {
        appendUpdate: async () => undefined,
        loadUpdates: async () => [],
        compact: async () => undefined,
        flush,
      },
    });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/room`);
  socket.on("error", () => undefined);
  const replies: Array<{ kind: string; token: string }> = [];
  socket.on("message", (data) => {
    const bytes = new Uint8Array(data as Buffer);
    if (bytes[0] === 5) replies.push(decodeDurableDelivery(bytes));
  });
  const doc = new Y.Doc();
  doc.getText("source").insert(0, "not delivered");
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(
      encodeDurableDelivery({
        kind: "request",
        token: "missing-clocks-0000000000",
        stateVector: Y.encodeStateVector(doc),
      }),
    );
    const vector = encoding.createEncoder();
    encoding.writeVarUint(vector, 4097);
    socket.send(
      encodeDurableDelivery({
        kind: "request",
        token: "too-many-clients-00000000",
        stateVector: encoding.toUint8Array(vector),
      }),
    );
    // Replies correlate by token. Immediate bounded-vector rejection can precede
    // an earlier probe waiting for prior writes, so arrival order is not a contract.
    await vi.waitFor(() =>
      expect(replies).toEqual(
        expect.arrayContaining([
          { kind: "unavailable", token: "missing-clocks-0000000000" },
          { kind: "unavailable", token: "too-many-clients-00000000" },
        ]),
      ),
    );
    expect(replies).toHaveLength(2);
    expect(flush).not.toHaveBeenCalled();
  } finally {
    doc.destroy();
    socket.terminate();
    await server.close();
  }
});
