/**
 * Capability-room relay authorization (#1 slice 2) over REAL ws sockets,
 * end-to-end through the REAL durable registry: records are written the way
 * the web-server writes them (`registerCapabilityRoom` from @galley/auth into
 * an `FsCapabilityRoomRegistry`) and read by the relay's gate from a SEPARATE
 * registry instance at the same dir (the shared-volume cross-container
 * property). Pins the frozen upgrade order:
 *
 *   (b) Origin policy — non-empty allowlist: present Origin must exact-match
 *       for EVERY room; an ABSENT Origin proceeds only for a capability room
 *       (the cookie-less kernel), which is still registry-gated;
 *   (c) capability-namespace rooms: active-in-registry, NO cookie consulted
 *       (the cookie gate is provably never called); other rooms: the existing
 *       cookie path unchanged;
 *   (d) revoked/unregistered → 1008 before any doc data (fail closed).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket as WS, type ClientOptions } from "ws";
import { FsCapabilityRoomRegistry } from "@galley/persistence";
import {
  registerCapabilityRoom,
  revokeCapabilityRoom,
  authorizeCapabilityRoomUpgrade,
} from "@galley/auth";
import { isCapabilityRoomId } from "@galley/shared";
import { startSyncServer, type SyncServerHandle } from "./sync-server.js";
import { buildSyncOptions } from "./server-config.js";

const NOW = () => Date.now();
const ROOM = "share-0123456789abcdef0123456789abcdef";

interface Outcome {
  opened: boolean;
  code?: number;
}

function connectOutcome(
  port: number,
  room: string,
  wsOpts: ClientOptions = {},
): Promise<Outcome> {
  return new Promise((resolve) => {
    const ws = new WS(`ws://127.0.0.1:${port}/${room}`, wsOpts);
    let opened = false;
    ws.on("message", () => {
      opened = true;
      ws.close();
      resolve({ opened: true });
    });
    ws.on("close", (code: number) => resolve({ opened, code }));
    ws.on("error", () => {
      /* a denied upgrade surfaces as error then close */
    });
    setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve({ opened });
    }, 2000);
  });
}

let dataDir: string;
let webRegistry: FsCapabilityRoomRegistry; // the "web container" writer
let relayRegistry: FsCapabilityRoomRegistry; // the "sync container" reader
let server: SyncServerHandle | undefined;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "galley-caproom-sync-"));
  webRegistry = new FsCapabilityRoomRegistry(dataDir);
  relayRegistry = new FsCapabilityRoomRegistry(dataDir);
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(dataDir, { recursive: true, force: true });
});

/** Register a room exactly the way the web-server route does. */
async function registerAsWeb(
  roomId: string,
  kind: "share" | "control" = "share",
): Promise<void> {
  const res = await registerCapabilityRoom(webRegistry, {
    body: { roomId, kind },
    userId: "alice",
    sessionExpiresAtMs: NOW() + 60_000,
    nowMs: NOW(),
  });
  expect(res.status).toBe(200);
}

function capabilityOptions(): {
  isCapabilityRoom: (room: string) => boolean;
  authorize: (room: string) => Promise<boolean>;
} {
  return {
    isCapabilityRoom: isCapabilityRoomId,
    authorize: (room) =>
      authorizeCapabilityRoomUpgrade({
        room,
        registry: relayRegistry,
        nowMs: NOW(),
      }),
  };
}

describe("relay upgrade — capability rooms under auth=required", () => {
  it("admits an ACTIVE registered capability room with NO cookie; denies unregistered/revoked", async () => {
    let cookieGateCalls = 0;
    server = await startSyncServer(0, {
      capabilityRooms: capabilityOptions(),
      authorizeUpgrade: () => {
        cookieGateCalls += 1;
        return false; // the cookie path would deny — capability rooms must never reach it
      },
    });
    await registerAsWeb(ROOM);

    const active = await connectOutcome(server.port, ROOM);
    expect(active.opened).toBe(true); // cross-container: web wrote, relay read

    const unregistered = await connectOutcome(
      server.port,
      "share-unregistered000000000000000000",
    );
    expect(unregistered.opened).toBe(false);
    expect(unregistered.code).toBe(1008);

    await revokeCapabilityRoom(webRegistry, {
      roomId: ROOM,
      userId: "alice",
      nowMs: NOW(),
    });
    const revoked = await connectOutcome(server.port, ROOM);
    expect(revoked.opened).toBe(false); // revocation denies FUTURE joins
    expect(revoked.code).toBe(1008);

    expect(cookieGateCalls).toBe(0); // capability rooms NEVER consult the cookie gate
  });

  it("a capability room is denied even when the cookie gate would ALLOW (no fall-through)", async () => {
    server = await startSyncServer(0, {
      capabilityRooms: capabilityOptions(),
      authorizeUpgrade: () => true, // a valid member session…
    });
    // …but the capability room is NOT registered → fail closed (old links die).
    const res = await connectOutcome(server.port, ROOM);
    expect(res.opened).toBe(false);
    expect(res.code).toBe(1008);
  });

  it("NON-capability rooms keep the existing cookie→membership path unchanged", async () => {
    server = await startSyncServer(0, {
      capabilityRooms: capabilityOptions(),
      authorizeUpgrade: ({ room }) => room === "project-ok",
    });
    expect((await connectOutcome(server.port, "project-ok")).opened).toBe(true);
    const denied = await connectOutcome(server.port, "project-no");
    expect(denied.opened).toBe(false);
    expect(denied.code).toBe(1008);
  });

  it("an EXPIRED control room is denied at the upgrade", async () => {
    server = await startSyncServer(0, { capabilityRooms: capabilityOptions() });
    const controlRoom = "share-control0000000000000000000000";
    await registerCapabilityRoom(webRegistry, {
      body: { roomId: controlRoom, kind: "control" },
      userId: "alice",
      sessionExpiresAtMs: NOW() - 1, // the session already lapsed
      nowMs: NOW() - 10,
    });
    const res = await connectOutcome(server.port, controlRoom);
    expect(res.opened).toBe(false);
    expect(res.code).toBe(1008);
  });
});

describe("relay upgrade — Origin policy × capability rooms", () => {
  const ALLOWED = "https://galley.example.com";

  it("absent Origin proceeds ONLY for an ACTIVE capability room (the cookie-less kernel)", async () => {
    server = await startSyncServer(0, {
      allowedOrigins: [ALLOWED],
      capabilityRooms: capabilityOptions(),
      authorizeUpgrade: () => true,
    });
    await registerAsWeb(ROOM);

    // The kernel: no Origin, active capability room → admitted.
    expect((await connectOutcome(server.port, ROOM)).opened).toBe(true);

    // No Origin + an UNREGISTERED capability room → denied by the registry.
    const unreg = await connectOutcome(
      server.port,
      "share-unregistered000000000000000000",
    );
    expect(unreg.opened).toBe(false);

    // No Origin + a NON-capability room → today's allowlist deny, unchanged.
    const nonCap = await connectOutcome(server.port, "project-x");
    expect(nonCap.opened).toBe(false);
    expect(nonCap.code).toBe(1008);
  });

  it("a PRESENT Origin must exact-match for every room — capability rooms included", async () => {
    server = await startSyncServer(0, {
      allowedOrigins: [ALLOWED],
      capabilityRooms: capabilityOptions(),
    });
    await registerAsWeb(ROOM);
    const listed = await connectOutcome(server.port, ROOM, {
      headers: { origin: ALLOWED },
    });
    expect(listed.opened).toBe(true);
    const evil = await connectOutcome(server.port, ROOM, {
      headers: { origin: "https://evil.example.com" },
    });
    expect(evil.opened).toBe(false);
    expect(evil.code).toBe(1008);
  });

  it("WITHOUT the capability option (auth off), an absent Origin under an allowlist still denies — unchanged", async () => {
    server = await startSyncServer(0, { allowedOrigins: [ALLOWED] });
    const res = await connectOutcome(server.port, ROOM);
    expect(res.opened).toBe(false);
    expect(res.code).toBe(1008);
  });
});

describe("buildSyncOptions — capability wiring", () => {
  it("auth OFF stays byte-for-byte {} (no capability option, no registry)", () => {
    expect(buildSyncOptions({})).toEqual({});
    expect(buildSyncOptions({ GALLEY_SYNC_AUTH: "off" })).toEqual({});
  });

  it("auth REQUIRED wires the capability gate next to the cookie gate", () => {
    const opts = buildSyncOptions({
      GALLEY_SYNC_AUTH: "required",
      GALLEY_SESSION_DIR: "/data/sessions",
      GALLEY_DATA_DIR: dataDir,
      GALLEY_SYNC_ALLOWED_ORIGINS: "https://app.test", // HIGH-1: required under auth
    });
    expect(typeof opts.authorizeUpgrade).toBe("function");
    expect(opts.capabilityRooms).toBeDefined();
    expect(opts.capabilityRooms!.isCapabilityRoom(ROOM)).toBe(true);
    expect(opts.capabilityRooms!.isCapabilityRoom("project-x")).toBe(false);
  });

  it("the wired authorize answers from the REAL registry on GALLEY_DATA_DIR", async () => {
    const opts = buildSyncOptions({
      GALLEY_SYNC_AUTH: "required",
      GALLEY_SESSION_DIR: "/data/sessions",
      GALLEY_DATA_DIR: dataDir,
      GALLEY_SYNC_ALLOWED_ORIGINS: "https://app.test", // HIGH-1: required under auth
    });
    await registerAsWeb(ROOM);
    expect(await opts.capabilityRooms!.authorize(ROOM)).toBe(true);
    expect(
      await opts.capabilityRooms!.authorize(
        "share-unregistered000000000000000000",
      ),
    ).toBe(false);
  });
});
