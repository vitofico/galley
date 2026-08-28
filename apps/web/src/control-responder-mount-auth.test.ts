/**
 * Agent Access × capability registration (#1 slice 2). With auth ON, enable()
 * must REGISTER the freshly minted control room with the server and await
 * SUCCESS before joining the relay or surfacing the pairing command; failures
 * leave the manager disabled with a user-facing error; disable() revokes the
 * registered room best-effort. With auth OFF (the Node-gate default — no
 * served config), enable() is byte-for-byte the historical synchronous path
 * with ZERO registry calls — the existing control-responder-mount.test.ts
 * suite continues to pin that path untouched; here we additionally prove the
 * registration seam is never consulted.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";
import { bytesToBase64Url, type DocHost } from "@galley/collab";
import {
  __resetControlResponderManagerForTests,
  getControlResponderManager,
  AGENT_ACCESS_SESSION_KEY,
  type ControlResponderMountDeps,
  type ControlLink,
} from "./control-responder-mount.js";
import type { RegisterCapabilityRoomResult } from "./capability-rooms-client.js";

function makeMemoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

interface Harness {
  deps: ControlResponderMountDeps;
  joins: string[];
  registered: string[];
  revoked: string[];
}

function makeHarness(over: Partial<ControlResponderMountDeps> = {}): Harness {
  const doc = new Y.Doc();
  const host: DocHost = { doc };
  const joins: string[] = [];
  const registered: string[] = [];
  const revoked: string[] = [];
  const deps: ControlResponderMountDeps = {
    mintControlRoom: () =>
      `share-room${String(joins.length + registered.length).padStart(20, "0")}`,
    resolveSyncUrl: () => "ws://127.0.0.1:1234",
    currentUserId: () => "local-user",
    listProjects: async () => [],
    listVersions: async () => null,
    createProject: async (name) => ({ projectId: "proj-new", name }),
    openProjectForControl: async () => ({ refused: "nothing open" }),
    joinControlRoom: (room): ControlLink => {
      joins.push(room);
      return { host, destroy: () => undefined };
    },
    // B2 (ADR-0026): a fake pairing room + deterministic code so the surfaced
    // command appears (a fresh enable() always offers a one-time code).
    joinPairingRoom: (): ControlLink => ({ host: { doc: new Y.Doc() }, destroy: () => undefined }),
    mintPairingCode: () => "pairCodeAAAAAAAAAAAAAA",
    sessionStore: makeMemoryStore(),
    registerControlRoom: async (room) => {
      registered.push(room);
      return { ok: true };
    },
    revokeControlRoom: async (room) => {
      revoked.push(room);
    },
    ...over,
  };
  return { deps, joins, registered, revoked };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  __resetControlResponderManagerForTests();
});

describe("auth OFF — the registration seam is never consulted", () => {
  it("enable() is synchronous, registers nothing, and exposes no pending/error", () => {
    const h = makeHarness(); // no authActive → Node default (no served config) → off
    const mgr = getControlResponderManager(h.deps);
    mgr.enable();
    expect(mgr.isEnabled()).toBe(true); // synchronously live, as today
    expect(h.registered).toHaveLength(0); // ZERO registry calls
    const s = mgr.getState();
    expect(s.pending).toBe(false);
    expect(s.error).toBeNull();
    mgr.disable();
    expect(h.revoked).toHaveLength(0); // nothing registered → nothing revoked
  });
});

describe("auth ON — register BEFORE join", () => {
  it("awaits registration success, THEN joins; the pairing command appears only after", async () => {
    let release!: (r: RegisterCapabilityRoomResult) => void;
    const gate = new Promise<RegisterCapabilityRoomResult>((res) => {
      release = res;
    });
    const h = makeHarness({
      authActive: () => true,
      registerControlRoom: () => gate,
    });
    const mgr = getControlResponderManager(h.deps);
    mgr.enable();
    expect(mgr.isEnabled()).toBe(false); // not live yet
    expect(mgr.getState().pending).toBe(true);
    expect(mgr.getState().pairingCommand).toBeNull(); // the capability is NOT shown
    expect(h.joins).toHaveLength(0); // and the relay is NOT joined
    release({ ok: true });
    await flush();
    expect(mgr.isEnabled()).toBe(true);
    expect(h.joins).toHaveLength(1);
    expect(mgr.getState().pending).toBe(false);
    expect(mgr.getState().pairingCommand).toContain("galley-mcp");
    expect(mgr.getState().controlRoom).toBe(h.joins[0]);
  });

  it("registers the SAME control room it later joins (plus the B2 pairing room)", async () => {
    const h = makeHarness({ authActive: () => true });
    const mgr = getControlResponderManager(h.deps);
    mgr.enable();
    await flush();
    // The control room is registered AND joined (joinControlRoom only sees it).
    expect(h.joins).toHaveLength(1);
    expect(h.registered).toContain(h.joins[0]);
    // B2 (#3): the transient pairing room is ALSO registered under auth-on (a
    // `share-` capability the cookie-less kernel must be admitted to). So two
    // registrations: the control room + the pairing room.
    expect(h.registered).toHaveLength(2);
    expect(h.registered.some((r) => /^share-[0-9a-f]{32}$/.test(r))).toBe(true); // the pairing room
  });

  it("a registration failure surfaces the error, never joins, and a retry works", async () => {
    let attempt = 0;
    const h = makeHarness({
      authActive: () => true,
      registerControlRoom: async () => {
        attempt += 1;
        return attempt === 1
          ? { ok: false, error: "cap hit — revoke one first" }
          : { ok: true };
      },
    });
    const mgr = getControlResponderManager(h.deps);
    mgr.enable();
    await flush();
    expect(mgr.isEnabled()).toBe(false);
    expect(h.joins).toHaveLength(0);
    expect(mgr.getState().error).toBe("cap hit — revoke one first");
    mgr.enable(); // user retries after revoking elsewhere
    expect(mgr.getState().error).toBeNull(); // cleared by the fresh attempt
    await flush();
    expect(mgr.isEnabled()).toBe(true);
    expect(h.joins).toHaveLength(1);
  });

  it("a THROWING registration seam fails closed with a generic error", async () => {
    const h = makeHarness({
      authActive: () => true,
      registerControlRoom: async () => {
        throw new Error("network down");
      },
    });
    const mgr = getControlResponderManager(h.deps);
    mgr.enable();
    await flush();
    expect(mgr.isEnabled()).toBe(false);
    expect(mgr.getState().error).toMatch(/could not register/i);
  });

  it("auth on but NO registration seam → fail closed (never joins unregistered)", async () => {
    const h = makeHarness({ authActive: () => true });
    delete (h.deps as { registerControlRoom?: unknown }).registerControlRoom;
    const mgr = getControlResponderManager(h.deps);
    mgr.enable();
    await flush();
    expect(mgr.isEnabled()).toBe(false);
    expect(h.joins).toHaveLength(0);
    expect(mgr.getState().error).toMatch(/unavailable/i);
  });

  it("enable() is idempotent while a registration is pending (one register, one join)", async () => {
    let release!: (r: RegisterCapabilityRoomResult) => void;
    const gate = new Promise<RegisterCapabilityRoomResult>((res) => {
      release = res;
    });
    let calls = 0;
    const h = makeHarness({
      authActive: () => true,
      registerControlRoom: () => {
        calls += 1;
        return gate;
      },
    });
    const mgr = getControlResponderManager(h.deps);
    mgr.enable();
    mgr.enable(); // double-click / StrictMode
    release({ ok: true });
    await flush();
    // One CONTROL-room registration + join (idempotent across the double-enable).
    // The B2 pairing room adds a second registration (it shares the seam), but the
    // control-room lifecycle is still single: exactly one join.
    expect(h.joins).toHaveLength(1);
    expect(calls).toBe(2); // control room + pairing room (both via the registry seam)
  });

  it("disable() during a pending registration CANCELS it — never enables afterwards", async () => {
    let release!: (r: RegisterCapabilityRoomResult) => void;
    const gate = new Promise<RegisterCapabilityRoomResult>((res) => {
      release = res;
    });
    const h = makeHarness({
      authActive: () => true,
      registerControlRoom: () => gate,
    });
    const mgr = getControlResponderManager(h.deps);
    mgr.enable();
    expect(mgr.getState().pending).toBe(true);
    mgr.disable(); // revoke while "Enabling…"
    expect(mgr.getState().pending).toBe(false);
    release({ ok: true }); // the server said yes — too late
    await flush();
    expect(mgr.isEnabled()).toBe(false);
    expect(h.joins).toHaveLength(0);
  });

  it("disable() of a live session revokes the registered room (best-effort)", async () => {
    const h = makeHarness({ authActive: () => true });
    const mgr = getControlResponderManager(h.deps);
    mgr.enable();
    await flush();
    expect(mgr.isEnabled()).toBe(true);
    // The pairing room is registered then revoked as soon as the code is consumed /
    // TTL / teardown — by the time we disable, it may already be revoked. The
    // control room is registered for the whole session; disable revokes it too. So
    // every registered room ends up revoked (set equality, order-independent).
    mgr.disable();
    expect(mgr.isEnabled()).toBe(false);
    expect([...h.revoked].sort()).toEqual([...h.registered].sort());
  });

  it("a THROWING revoke seam never blocks the local teardown", async () => {
    const h = makeHarness({
      authActive: () => true,
      revokeControlRoom: () => {
        throw new Error("offline");
      },
    });
    const mgr = getControlResponderManager(h.deps);
    mgr.enable();
    await flush();
    expect(() => mgr.disable()).not.toThrow();
    expect(mgr.isEnabled()).toBe(false);
  });
});

describe("auth ON — resume re-registers the persisted room before re-joining", () => {
  const RESUME_ROOM = "share-resume0000000000000000";
  function seed(store: { setItem: (k: string, v: string) => void }): void {
    store.setItem(
      AGENT_ACCESS_SESSION_KEY,
      JSON.stringify({ controlRoom: RESUME_ROOM, responseKey: bytesToBase64Url(new Uint8Array(32).fill(9)) }),
    );
  }

  it("on construction, RE-REGISTERS the stored room, then re-joins THAT room", async () => {
    const store = makeMemoryStore();
    seed(store);
    const h = makeHarness({ authActive: () => true, sessionStore: store });
    const mgr = getControlResponderManager(h.deps); // construction triggers resume
    expect(mgr.isEnabled()).toBe(false); // pending re-registration first
    await flush();
    expect(mgr.isEnabled()).toBe(true);
    expect(h.registered).toEqual([RESUME_ROOM]); // re-registered the SAME room
    expect(h.joins).toEqual([RESUME_ROOM]); // …then joined it (never minted a new one)
    expect(mgr.getState().controlRoom).toBe(RESUME_ROOM);
  });

  it("a failed re-registration leaves it disabled and KEEPS the blob for a later retry", async () => {
    const store = makeMemoryStore();
    seed(store);
    const h = makeHarness({
      authActive: () => true,
      sessionStore: store,
      registerControlRoom: async () => ({ ok: false, error: "server said no" }),
    });
    const mgr = getControlResponderManager(h.deps);
    await flush();
    expect(mgr.isEnabled()).toBe(false);
    expect(h.joins).toHaveLength(0); // never joined an unregistered room
    expect(store.getItem(AGENT_ACCESS_SESSION_KEY)).not.toBeNull(); // kept for next load
  });
});
