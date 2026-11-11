/**
 * Hosted connector, relay side (ADR-0033 §1): a project a person connected has
 * a server replica, and nothing else does.
 *
 *   - `GALLEY_SYNC_PERSIST_ROOMS=connector` keeps ONLY connector rooms on disk;
 *     a share room on the same relay stays ephemeral;
 *   - the replica survives every peer leaving, and a later joiner gets it back;
 *   - disconnecting (revoking the room) erases the stored state.
 *
 * Driven through `buildSyncOptions`, so the env parsing, the registry glue and
 * the relay's persistence seam are exercised together over real sockets.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket as WS } from "ws";
import type { Author, CapabilityRoomRecord } from "@galley/shared";
import {
  CollabDocument,
  CollabConnection,
  WebSocketTransport,
  restoreDoc,
  type WebSocketLike,
} from "@galley/collab";
import { FsCapabilityRoomRegistry, FsCrdtStore } from "@galley/persistence";
import { startSyncServer, type SyncServerHandle } from "./index.js";
import {
  buildSyncOptions,
  persistsOnlyConnectorRooms,
} from "./server-config.js";

const HUMAN: Author = { kind: "human", userId: "alice" };
const settle = { timeout: 4000, interval: 20 };
const CONNECTED = "share-connected0000000000000000000";
const SHARED = "share-justshared0000000000000000000";

const record = (
  roomId: string,
  kind: CapabilityRoomRecord["kind"],
): CapabilityRoomRecord => ({
  version: 1,
  roomId,
  kind,
  createdBy: "alice",
  createdAtMs: Date.now(),
  ...(kind === "connector" ? { projectId: "proj-1", reviewMode: "ask" } : {}),
});

/** A native ws peer: it sends no Origin, like the connector service will. */
function client(handle: SyncServerHandle, room: string, doc: CollabDocument) {
  const url = `ws://127.0.0.1:${handle.port}/${room}`;
  return new CollabConnection(
    doc,
    new WebSocketTransport(() => new WS(url) as unknown as WebSocketLike),
    { author: HUMAN },
  );
}

const storedSource = async (dir: string, room: string) =>
  new CollabDocument(
    "",
    restoreDoc(await new FsCrdtStore(dir).loadUpdates(room)),
  ).getSource();

describe("GALLEY_SYNC_PERSIST_ROOMS", () => {
  const ready = {
    GALLEY_SYNC_AUTH: "required",
    GALLEY_SYNC_PERSIST_DIR: "/data/crdt",
  };

  it("defaults to every room, and accepts connector", () => {
    expect(persistsOnlyConnectorRooms({})).toBe(false);
    expect(
      persistsOnlyConnectorRooms({
        ...ready,
        GALLEY_SYNC_PERSIST_ROOMS: "all",
      }),
    ).toBe(false);
    expect(
      persistsOnlyConnectorRooms({
        ...ready,
        GALLEY_SYNC_PERSIST_ROOMS: "connector",
      }),
    ).toBe(true);
  });

  it("refuses a typo, and connector without a persist dir or required auth", () => {
    expect(() =>
      persistsOnlyConnectorRooms({
        ...ready,
        GALLEY_SYNC_PERSIST_ROOMS: "conector",
      }),
    ).toThrow(/must be all or connector/);
    expect(() =>
      persistsOnlyConnectorRooms({
        GALLEY_SYNC_AUTH: "required",
        GALLEY_SYNC_PERSIST_ROOMS: "connector",
      }),
    ).toThrow(/requires/);
    expect(() =>
      persistsOnlyConnectorRooms({
        GALLEY_SYNC_PERSIST_DIR: "/data/crdt",
        GALLEY_SYNC_PERSIST_ROOMS: "connector",
      }),
    ).toThrow(/requires/);
  });
});

describe("connected projects on the relay", () => {
  it("keeps a replica of a connected project only, and erases it on disconnect", async () => {
    const root = await mkdtemp(join(tmpdir(), "galley-connector-rooms-"));
    const dataDir = join(root, "data");
    const persistDir = join(root, "crdt");
    const registry = new FsCapabilityRoomRegistry(dataDir);
    await registry.put(record(CONNECTED, "connector"));
    await registry.put(record(SHARED, "share"));

    const options = {
      ...buildSyncOptions({
        GALLEY_SYNC_AUTH: "required",
        GALLEY_SESSION_DIR: join(root, "sessions"),
        GALLEY_DATA_DIR: dataDir,
        GALLEY_SYNC_ALLOWED_ORIGINS: "https://galley.test",
        GALLEY_SYNC_PERSIST_DIR: persistDir,
        GALLEY_SYNC_PERSIST_ROOMS: "connector",
      }),
      retireSweepMs: 25,
    };
    const server = await startSyncServer(0, options);
    try {
      // The browser: one project synced into its connector room, another just shared.
      const connectedDoc = new CollabDocument("= Chapter one\n");
      const sharedDoc = new CollabDocument("private draft\n");
      const browser = client(server, CONNECTED, connectedDoc);
      const sharer = client(server, SHARED, sharedDoc);
      browser.connect();
      sharer.connect();
      await vi.waitFor(
        async () =>
          expect(await storedSource(persistDir, CONNECTED)).toBe(
            "= Chapter one\n",
          ),
        settle,
      );

      // The tab closes. The connected project is still on the server…
      browser.destroy();
      sharer.destroy();
      await vi.waitFor(() => expect(server.roomCount()).toBe(0), settle);
      const later = new CollabDocument();
      const connector = client(server, CONNECTED, later);
      connector.connect();
      await vi.waitFor(
        () => expect(later.getSource()).toBe("= Chapter one\n"),
        settle,
      );
      // …and the merely shared one never was.
      expect(await storedSource(persistDir, SHARED)).toBe("");

      // Disconnect: the grant is revoked, and the replica goes with it.
      await registry.put({
        ...record(CONNECTED, "connector"),
        revokedAtMs: Date.now(),
        revokedBy: "alice",
      });
      await vi.waitFor(
        () =>
          expect(
            new FsCrdtStore(persistDir).loadUpdates(CONNECTED),
          ).rejects.toThrow(/retired/),
        settle,
      );
      connector.destroy();
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
