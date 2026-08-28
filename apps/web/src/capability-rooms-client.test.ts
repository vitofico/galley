/**
 * Browser capability-room client (#1 slice 2): the registration/revocation
 * calls + the share-registration tracker, fully offline (fake fetch). The
 * AUTH-OFF EQUIVALENCE tests are the load-bearing ones: with no served
 * `auth: true` flag, NOTHING here may touch the network — proving the default
 * local mode is byte-for-byte unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  capabilityAuthActive,
  registerCapabilityRoom,
  revokeCapabilityRoomBestEffort,
  ensureShareRoomRegistered,
  peekShareRegistration,
  shareRegistrationHandoffGate,
  subscribeShareRegistrations,
  __resetCapabilityRoomsClientForTests,
  type CapabilityFetch,
} from "./capability-rooms-client.js";
import { roomFromShareLink } from "./share.js";

const ROOM = "share-0123456789abcdef0123456789abcdef";

type Call = { url: string; init?: Parameters<CapabilityFetch>[1] };

function fakeFetch(
  status: number,
  body: unknown = status === 200 ? { ok: true } : { ok: false, code: "x" },
): { fetch: CapabilityFetch; calls: Call[] } {
  const calls: Call[] = [];
  const f: CapabilityFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  return { fetch: f, calls };
}

const g = globalThis as { __GALLEY_CONFIG__?: unknown };

beforeEach(() => {
  __resetCapabilityRoomsClientForTests();
  delete g.__GALLEY_CONFIG__;
});
afterEach(() => {
  delete g.__GALLEY_CONFIG__;
});

describe("capabilityAuthActive — strict served-flag read", () => {
  it("is true ONLY for a literal auth: true", () => {
    expect(capabilityAuthActive({ auth: true })).toBe(true);
    expect(capabilityAuthActive({ auth: "true" })).toBe(false);
    expect(capabilityAuthActive({ auth: 1 })).toBe(false);
    expect(capabilityAuthActive({})).toBe(false);
    expect(capabilityAuthActive(undefined)).toBe(false);
    expect(capabilityAuthActive(null)).toBe(false);
  });

  it("defaults to the global runtime config (absent → off)", () => {
    expect(capabilityAuthActive()).toBe(false);
    g.__GALLEY_CONFIG__ = { auth: true };
    expect(capabilityAuthActive()).toBe(true);
  });
});

describe("registerCapabilityRoom — request + error mapping", () => {
  it("POSTs the JSON body same-origin and resolves ok on 200", async () => {
    const { fetch, calls } = fakeFetch(200);
    const res = await registerCapabilityRoom(ROOM, "share", {
      projectId: "p1",
      fetchImpl: fetch,
    });
    expect(res).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/auth/capability-rooms");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.credentials).toBe("same-origin");
    expect(JSON.parse(calls[0]!.init?.body ?? "")).toEqual({
      roomId: ROOM,
      kind: "share",
      projectId: "p1",
    });
  });

  it("maps 401 to a sign-in message, 409 to a cap message, the rest to a generic one", async () => {
    const signedOut = await registerCapabilityRoom(ROOM, "control", {
      fetchImpl: fakeFetch(401, { ok: false, code: "unauthenticated" }).fetch,
    });
    expect(signedOut.ok).toBe(false);
    expect(!signedOut.ok && signedOut.error).toMatch(/not signed in/i);

    const capHit = await registerCapabilityRoom(ROOM, "share", {
      fetchImpl: fakeFetch(409, { ok: false, code: "cap-exceeded" }).fetch,
    });
    expect(!capHit.ok && capHit.error).toMatch(/too many active/i);

    const generic = await registerCapabilityRoom(ROOM, "share", {
      fetchImpl: fakeFetch(403).fetch,
    });
    expect(!generic.ok && generic.error).toMatch(/could not register/i);
  });

  it("a network failure resolves a generic error (never throws)", async () => {
    const res = await registerCapabilityRoom(ROOM, "share", {
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    expect(res.ok).toBe(false);
  });
});

describe("revokeCapabilityRoomBestEffort", () => {
  it("POSTs the revoke route with the encoded room id", async () => {
    const { fetch, calls } = fakeFetch(200);
    await revokeCapabilityRoomBestEffort(ROOM, fetch);
    expect(calls[0]!.url).toBe(`/auth/capability-rooms/${ROOM}/revoke`);
    expect(calls[0]!.init?.method).toBe("POST");
  });

  it("never throws — failures are swallowed (local teardown must proceed)", async () => {
    await expect(
      revokeCapabilityRoomBestEffort(ROOM, async () => {
        throw new Error("gone");
      }),
    ).resolves.toBeUndefined();
  });
});

describe("ensureShareRoomRegistered — the host tracker", () => {
  it("AUTH OFF: resolves ok immediately, performs ZERO network calls, tracks nothing", async () => {
    const { fetch, calls } = fakeFetch(200);
    const res = await ensureShareRoomRegistered(ROOM, { fetchImpl: fetch });
    expect(res).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
    expect(peekShareRegistration(ROOM)).toBeNull();
  });

  it("AUTH ON: pending → ok, notifying subscribers; memoized to ONE call", async () => {
    g.__GALLEY_CONFIG__ = { auth: true };
    const { fetch, calls } = fakeFetch(200);
    const seen: string[] = [];
    const unsub = subscribeShareRegistrations(() => {
      seen.push(peekShareRegistration(ROOM)?.status ?? "none");
    });
    const p1 = ensureShareRoomRegistered(ROOM, { fetchImpl: fetch });
    expect(peekShareRegistration(ROOM)).toEqual({ status: "pending" });
    const p2 = ensureShareRoomRegistered(ROOM, { fetchImpl: fetch }); // memoized
    expect(await p1).toEqual({ ok: true });
    expect(await p2).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(peekShareRegistration(ROOM)).toEqual({ status: "ok" });
    expect(seen).toContain("pending");
    expect(seen).toContain("ok");
    unsub();
  });

  it("AUTH ON: a failure is tracked with its user-facing error, and a retry re-attempts", async () => {
    g.__GALLEY_CONFIG__ = { auth: true };
    const failed = await ensureShareRoomRegistered(ROOM, {
      fetchImpl: fakeFetch(401, { ok: false, code: "unauthenticated" }).fetch,
    });
    expect(failed.ok).toBe(false);
    const tracked = peekShareRegistration(ROOM);
    expect(tracked?.status).toBe("error");
    expect(tracked?.status === "error" && tracked.error).toMatch(
      /not signed in/i,
    );
    // A later explicit retry (fresh Share after Stop sharing) may re-attempt.
    const { fetch, calls } = fakeFetch(200);
    const retried = await ensureShareRoomRegistered(ROOM, { fetchImpl: fetch });
    expect(retried).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(peekShareRegistration(ROOM)).toEqual({ status: "ok" });
  });
});

describe("shareRegistrationHandoffGate — the open_project handoff gate (M2)", () => {
  it("AUTH OFF: resolves ok immediately with zero registry calls (handoff unchanged)", async () => {
    const { fetch, calls } = fakeFetch(200);
    // The gate goes through ensureShareRoomRegistered, which is auth-gated; the
    // global fetch is untouched here, so zero calls proves the no-op path.
    void fetch;
    const res = await shareRegistrationHandoffGate(ROOM);
    expect(res).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
    expect(peekShareRegistration(ROOM)).toBeNull();
  });

  it("AUTH ON: ok once the (memoized) registration succeeded — same single POST", async () => {
    g.__GALLEY_CONFIG__ = { auth: true };
    const { fetch, calls } = fakeFetch(200);
    // The share-upgrade path kicked the registration first…
    await ensureShareRoomRegistered(ROOM, { fetchImpl: fetch });
    // …and the handoff gate consumes the SAME memoized outcome.
    const res = await shareRegistrationHandoffGate(ROOM);
    expect(res).toEqual({ ok: true });
    expect(calls).toHaveLength(1); // no second network call
  });

  it("AUTH ON: a failed registration becomes a STATIC refusal (no server detail leaks)", async () => {
    g.__GALLEY_CONFIG__ = { auth: true };
    await ensureShareRoomRegistered(ROOM, {
      fetchImpl: fakeFetch(401, { ok: false, code: "unauthenticated" }).fetch,
    });
    const res = await shareRegistrationHandoffGate(ROOM);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.refused).toBe("the share room could not be registered with the server");
      expect(res.refused).not.toMatch(/signed in|cap|401/i); // kernel-facing: static, detail-free
    }
  });
});

describe("registry fetch timeout (verification round, LOW)", () => {
  /** A fetch that never settles on its own — only an abort releases it. */
  const hangingFetch: CapabilityFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });

  it("registerCapabilityRoom aborts a hanging fetch and maps it to the generic failure", async () => {
    const res = await registerCapabilityRoom(ROOM, "share", {
      fetchImpl: hangingFetch,
      timeoutMs: 25,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/could not register/i);
  });

  it("a hanging registration cannot wedge the open_project handoff gate (static refusal)", async () => {
    g.__GALLEY_CONFIG__ = { auth: true };
    // The share-upgrade path kicked the registration against a wedged server…
    await ensureShareRoomRegistered(ROOM, { fetchImpl: hangingFetch, timeoutMs: 25 });
    expect(peekShareRegistration(ROOM)?.status).toBe("error");
    // …and the handoff gate still resolves (it would otherwise hang the
    // responder drain until the vitest timeout — the bug this pins).
    const res = await shareRegistrationHandoffGate(ROOM);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.refused).toBe("the share room could not be registered with the server");
    }
  });

  it("revokeCapabilityRoomBestEffort never hangs — the abort is swallowed", async () => {
    await expect(revokeCapabilityRoomBestEffort(ROOM, hangingFetch, 25)).resolves.toBeUndefined();
  });
});

describe("roomFromShareLink — the popover's room lookup", () => {
  it("recovers the room from relative and absolute join links", () => {
    expect(roomFromShareLink(`/join/${ROOM}`)).toBe(ROOM);
    expect(roomFromShareLink(`/join/${ROOM}?role=editor`)).toBe(ROOM);
    expect(
      roomFromShareLink(
        `https://galley.example.com/join/${ROOM}?sync=wss%3A%2F%2Fx`,
      ),
    ).toBe(ROOM);
  });

  it("is null for non-join links and malformed encodings", () => {
    expect(roomFromShareLink(null)).toBeNull();
    expect(roomFromShareLink(undefined)).toBeNull();
    expect(roomFromShareLink("")).toBeNull();
    expect(roomFromShareLink("https://galley.example.com/")).toBeNull();
    expect(roomFromShareLink("/join/%zz")).toBeNull();
  });
});
