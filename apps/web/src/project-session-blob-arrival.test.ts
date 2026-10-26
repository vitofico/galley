import { describe, expect, it, vi } from "vitest";
import {
  BLOB_WANTS_FIELD,
  InMemoryBlobStore,
  encodeFrame,
  sha256Hex,
  type BlobFrame,
  type BlobStore,
  type WebSocketLike,
} from "@galley/collab";
import {
  connectProjectSession,
  createProjectSession,
  ensureAuthenticatedBlobChannel,
} from "./project-session.js";

/** A real BlobTransport consumes these frames, without a network dependency. */
function socket() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const ws: WebSocketLike = {
    readyState: 1,
    binaryType: "arraybuffer",
    send() {},
    close() {},
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };
  return {
    ws,
    receive(frame: BlobFrame) {
      const data = encodeFrame(frame);
      for (const listener of listeners.get("message") ?? []) listener({ data });
    },
    listenerCount() {
      return [...listeners.values()].reduce(
        (count, set) => count + set.size,
        0,
      );
    },
  };
}

describe.each(["connected", "live Share"] as const)(
  "%s verified-byte arrival",
  (mode) => {
    async function fixture() {
      const sync = socket(),
        blob = socket();
      const backing = new InMemoryBlobStore();
      let release!: () => void;
      const stored = new Promise<void>((resolve) => {
        release = resolve;
      });
      let writing = false;
      const store: BlobStore = {
        put: async (bytes, opts) => {
          writing = true;
          await stored;
          return backing.put(bytes, opts);
        },
        get: (hash) => backing.get(hash),
        has: (hash) => backing.has(hash),
        markServable: (hash) => backing.markServable(hash),
        isServable: (hash) => backing.isServable(hash),
      };
      const arrivals: {
        hash: string;
        size: number;
        readable: Promise<Uint8Array | undefined>;
      }[] = [];
      const onInboundStored = (hash: string, size: number) => {
        arrivals.push({ hash, size, readable: store.get(hash) });
      };
      const connected = mode === "connected";
      const session = createProjectSession(
        [],
        "/main.typ",
        {
          enabled: true,
          project: true,
          room: "late-bytes",
          syncUrl: connected ? "ws://test" : undefined,
        },
        {
          draftStore: () => ({ whenSynced: Promise.resolve(), destroy() {} }),
          socketFactory: () => sync.ws,
          ...(connected
            ? {
                blobStore: store,
                blobSocketFactory: () => blob.ws,
                onInboundStored,
              }
            : {}),
        },
      );
      await session.whenReady;
      if (!connected)
        connectProjectSession(
          session,
          "ws://test",
          "late-bytes",
          { socketFactory: () => sync.ws },
          "editor",
          {
            store,
            socketFactory: () => blob.ws,
            onInboundStored,
          },
        );
      const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
      const hash = await sha256Hex(bytes);
      session.project.createBinary(
        "/late.png",
        { type: "binary", hash, size: bytes.length, mime: "image/png" },
        session.author,
      );
      await vi.waitFor(() =>
        expect(
          session.connection!.awareness.getLocalState()?.[BLOB_WANTS_FIELD],
        ).toBeTruthy(),
      );
      // The compile consumer has already read a pointer whose bytes are absent.
      expect(await store.get(hash)).toBeUndefined();
      const updates = vi.fn();
      session.project.doc.on("update", updates);
      blob.receive({
        kind: "header",
        transferId: "late-transfer",
        hash,
        size: bytes.length,
        mime: "image/png",
        totalChunks: 1,
      });
      blob.receive({
        kind: "data",
        transferId: "late-transfer",
        index: 0,
        bytes,
      });
      await vi.waitFor(() => expect(writing).toBe(true));
      return {
        session,
        blob,
        store,
        backing,
        release,
        arrivals,
        updates,
        bytes,
        hash,
        onInboundStored,
      };
    }

    it("notifies the byte consumer after verified storage, without mutating the document", async () => {
      const f = await fixture();
      try {
        expect(f.arrivals).toEqual([]);
        f.release();
        await vi.waitFor(() => expect(f.arrivals).toHaveLength(1));
        expect(f.arrivals[0]).toMatchObject({
          hash: f.hash,
          size: f.bytes.length,
        });
        expect(await f.arrivals[0]!.readable).toEqual(f.bytes);
        expect(f.updates).not.toHaveBeenCalled();
        expect(await f.backing.isServable(f.hash)).toBe(false);
        // Demand tracking still runs alongside the consumer callback.
        await vi.waitFor(() =>
          expect(
            f.session.connection!.awareness.getLocalState()?.[BLOB_WANTS_FIELD],
          ).toBeNull(),
        );
      } finally {
        f.session.destroy();
      }
      expect(f.blob.listenerCount()).toBe(0);
    });

    it("closes a replaced channel and suppresses late consumer notifications after session teardown", async () => {
      const f = await fixture();
      const replacement = socket();
      ensureAuthenticatedBlobChannel(f.session, "ws://test", "late-bytes", {
        store: f.store,
        socketFactory: () => replacement.ws,
        terminalVerifier: async () => true,
        terminalScopeId: "replacement",
        onInboundStored: f.onInboundStored,
      });
      expect(f.blob.listenerCount()).toBe(0);
      expect(replacement.listenerCount()).toBeGreaterThan(0);
      f.session.destroy();
      expect(f.blob.listenerCount()).toBe(0);
      expect(replacement.listenerCount()).toBe(0);
      f.release();
      await vi.waitFor(async () =>
        expect(await f.backing.has(f.hash)).toBe(true),
      );
      expect(f.arrivals).toEqual([]);
      expect(f.updates).not.toHaveBeenCalled();
    });
  },
);
