/**
 * connectProjectSession × capability registration (#1 slice 2).
 *
 * The host's Share upgrade must REGISTER the freshly minted room before the
 * socket opens when the deployment runs with auth on — and must be
 * byte-for-byte today's synchronous connect (zero registry calls) with auth
 * off. The socketFactory doubles as the "did we connect?" probe: the
 * WebSocketTransport invokes it exactly when `connection.connect()` runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createProjectSession,
  connectProjectSession,
} from "./project-session.js";
import {
  __resetCapabilityRoomsClientForTests,
  peekShareRegistration,
} from "./capability-rooms-client.js";
import type { SeedFile } from "@galley/collab";
import type { Version, VersionStore } from "@galley/shared";

const SEED: SeedFile[] = [{ path: "/main.typ", text: "= Hi" }];
const LOCAL = {
  enabled: true,
  project: true,
  syncUrl: undefined,
  room: undefined,
};
const ROOM = "share-0123456789abcdef0123456789abcdef";

const g = globalThis as { __GALLEY_CONFIG__?: unknown };

function fakeStore() {
  return {
    factory: () => ({
      whenSynced: Promise.resolve(),
      destroy: () => undefined,
    }),
  };
}

/** Inert VersionStore so the Node gate never touches the IndexedDB default. */
function fakeVersions(): VersionStore {
  return {
    createVersion: (projectId, input) =>
      Promise.resolve({ id: "v1", projectId, name: input.name } as Version),
    listVersions: () => Promise.resolve([]),
    getVersionTree: () => Promise.resolve(null),
  };
}

function makeSession() {
  return createProjectSession(SEED, "/main.typ", LOCAL, {
    draftStore: fakeStore().factory,
    versionStore: fakeVersions(),
  });
}

function probeSocketFactory() {
  const calls: string[] = [];
  const factory = (url: string) => {
    calls.push(url);
    return {
      addEventListener() {},
      removeEventListener() {},
      send() {},
      close() {},
      readyState: 0,
    } as never;
  };
  return { factory, calls };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  __resetCapabilityRoomsClientForTests();
  delete g.__GALLEY_CONFIG__;
});
afterEach(() => {
  delete g.__GALLEY_CONFIG__;
  vi.unstubAllGlobals();
});

describe("connectProjectSession — auth OFF (the default local mode)", () => {
  it("connects SYNCHRONOUSLY with zero registry calls (byte-for-byte today's path)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const session = makeSession();
    await session.whenReady;
    const probe = probeSocketFactory();
    connectProjectSession(session, "ws://localhost:1234", ROOM, {
      socketFactory: probe.factory,
    });
    expect(probe.calls).toHaveLength(1); // connected before any microtask ran
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled(); // ZERO registry traffic
    expect(peekShareRegistration(ROOM)).toBeNull();
    session.destroy();
  });
});

describe("connectProjectSession — auth ON (#1 slice 2)", () => {
  it("registers BEFORE connecting: the socket opens only after the server accepts", async () => {
    g.__GALLEY_CONFIG__ = { auth: true };
    let release!: (v: {
      ok: boolean;
      status: number;
      json(): Promise<unknown>;
    }) => void;
    const gate = new Promise<{
      ok: boolean;
      status: number;
      json(): Promise<unknown>;
    }>((res) => {
      release = res;
    });
    const fetchSpy = vi.fn(() => gate);
    vi.stubGlobal("fetch", fetchSpy);

    const session = makeSession();
    await session.whenReady;
    const probe = probeSocketFactory();
    const conn = connectProjectSession(session, "ws://localhost:1234", ROOM, {
      socketFactory: probe.factory,
    });
    expect(conn).toBeDefined();
    expect(session.connection).toBe(conn); // the upgrade is in place immediately
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // the registration POST went out…
    expect(probe.calls).toHaveLength(0); // …and the socket has NOT opened yet

    release({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await flush();
    expect(probe.calls).toHaveLength(1); // connected only after success
    expect(peekShareRegistration(ROOM)).toEqual({ status: "ok" });
    session.destroy();
  });

  it("NEVER connects when registration fails (the error is tracked for the popover)", async () => {
    g.__GALLEY_CONFIG__ = { auth: true };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({ ok: false, code: "unauthenticated" }),
      })),
    );
    const session = makeSession();
    await session.whenReady;
    const probe = probeSocketFactory();
    connectProjectSession(session, "ws://localhost:1234", ROOM, {
      socketFactory: probe.factory,
    });
    await flush();
    expect(probe.calls).toHaveLength(0); // no socket, no doc bytes
    expect(peekShareRegistration(ROOM)?.status).toBe("error");
    session.destroy();
  });

  it("does not connect a connection detached before registration resolved (Stop sharing race)", async () => {
    g.__GALLEY_CONFIG__ = { auth: true };
    let release!: (v: {
      ok: boolean;
      status: number;
      json(): Promise<unknown>;
    }) => void;
    const gate = new Promise<{
      ok: boolean;
      status: number;
      json(): Promise<unknown>;
    }>((res) => {
      release = res;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => gate),
    );
    const session = makeSession();
    await session.whenReady;
    const probe = probeSocketFactory();
    connectProjectSession(session, "ws://localhost:1234", ROOM, {
      socketFactory: probe.factory,
    });
    session.connection = undefined; // the user hit "Stop sharing" mid-registration
    release({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await flush();
    expect(probe.calls).toHaveLength(0); // a detached connection is never opened
    session.destroy();
  });
});
