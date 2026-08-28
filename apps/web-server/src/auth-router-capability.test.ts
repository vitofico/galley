/**
 * The capability-room HTTP routes (#1 slice 2), driven offline through Hono's
 * `app.request`. The POLICY is pinned in @galley/auth's own suite; here we pin
 * the HTTP guards the router owns: strict same-origin (Origin header ===
 * the configured public origin — derived from redirect_uri, never Host),
 * cookie-session authentication, body bounds (size/JSON/content-type), the
 * constant no-oracle response shapes, and that the routes are ABSENT when no
 * registry store is configured.
 */
import { describe, it, expect } from "vitest";
import type { Hono } from "hono";
import type {
  CapabilityRoomRecord,
  CapabilityRoomStore,
  OidcProviderConfig,
} from "@galley/shared";
import { isCapabilityRoomId } from "@galley/shared";
import {
  InMemorySessionStore,
  InMemoryOidcLoginStateStore,
  type JwksGetter,
} from "@galley/auth";
import { createAuthRouter, MAX_CAPABILITY_BODY_BYTES } from "./auth-router.js";

const ORIGIN = "https://galley.example.com";
const NOW = 1_700_000_000_000;
const SESSION_TTL = 8 * 60 * 60 * 1000;
const ROOM = "share-0123456789abcdef0123456789abcdef";

const config: OidcProviderConfig = {
  issuer: "https://idp.example.com",
  clientId: "galley",
  authorizationEndpoint: "https://idp.example.com/authorize",
  tokenEndpoint: "https://idp.example.com/token",
  jwksUri: "https://idp.example.com/jwks",
  redirectUri: `${ORIGIN}/auth/callback`,
};

class MemStore implements CapabilityRoomStore {
  readonly map = new Map<string, CapabilityRoomRecord>();
  async get(roomId: string): Promise<CapabilityRoomRecord | null> {
    if (!isCapabilityRoomId(roomId)) return null;
    return this.map.get(roomId) ?? null;
  }
  async put(record: CapabilityRoomRecord): Promise<void> {
    this.map.set(record.roomId, record);
  }
  async list(): Promise<CapabilityRoomRecord[]> {
    return [...this.map.values()];
  }
  async remove(roomId: string): Promise<void> {
    this.map.delete(roomId);
  }
}

async function setup(withStore = true) {
  const sessionStore = new InMemorySessionStore(
    () => `sid${Math.random().toString(36).slice(2)}`,
  );
  const store = new MemStore();
  const app = createAuthRouter({
    config,
    sessionStore,
    loginStateStore: new InMemoryOidcLoginStateStore(),
    jwks: (() => {
      throw new Error("jwks never used by these routes");
    }) as unknown as JwksGetter,
    now: () => NOW,
    ...(withStore ? { capabilityRooms: { store } } : {}),
  });
  const { id } = await sessionStore.create({
    userId: "alice",
    createdAtMs: NOW - 1000,
    expiresAtMs: NOW + SESSION_TTL,
  });
  return { app, store, sessionStore, sid: id };
}

function post(
  app: Hono,
  path: string,
  opts: {
    origin?: string | null;
    cookie?: string | null;
    body?: string;
    contentType?: string | null;
    /** Explicit Content-Length; null = OMIT it (the chunked/no-CL case, M1). */
    contentLength?: string | null;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.origin !== null) headers["origin"] = opts.origin ?? ORIGIN;
  if (opts.cookie) headers["cookie"] = opts.cookie;
  if (opts.contentType !== null)
    headers["content-type"] = opts.contentType ?? "application/json";
  // Default: declare the true byte length, the way a browser fetch() does for a
  // string body (direct Hono invocation does not synthesize the header itself).
  if (opts.contentLength !== null && opts.body !== undefined) {
    headers["content-length"] =
      opts.contentLength ?? String(new TextEncoder().encode(opts.body).byteLength);
  } else if (typeof opts.contentLength === "string") {
    headers["content-length"] = opts.contentLength;
  }
  return Promise.resolve(
    app.request(path, {
      method: "POST",
      headers,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    }),
  );
}

const cookieFor = (sid: string) => `__Host-galley.sid=${sid}`;
const goodBody = JSON.stringify({ roomId: ROOM, kind: "share" });

describe("POST /capability-rooms — HTTP guards", () => {
  it("registers with the right Origin + a valid session cookie; createdBy/expiry are session-derived", async () => {
    const { app, store, sid } = await setup();
    const res = await post(app, "/capability-rooms", {
      cookie: cookieFor(sid),
      body: goodBody,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(store.map.get(ROOM)).toMatchObject({
      createdBy: "alice",
      createdAtMs: NOW,
    });

    // A control room expires at the SESSION's expiry, derived server-side.
    const controlRoom = "share-control0000000000000000000000";
    const res2 = await post(app, "/capability-rooms", {
      cookie: cookieFor(sid),
      body: JSON.stringify({ roomId: controlRoom, kind: "control" }),
    });
    expect(res2.status).toBe(200);
    expect(store.map.get(controlRoom)?.expiresAtMs).toBe(NOW + SESSION_TTL);
  });

  it("rejects an ABSENT or MISMATCHED Origin with a constant 403 (CSRF wall)", async () => {
    const { app, store, sid } = await setup();
    const absent = await post(app, "/capability-rooms", {
      origin: null,
      cookie: cookieFor(sid),
      body: goodBody,
    });
    expect(absent.status).toBe(403);
    expect(await absent.json()).toEqual({ ok: false, code: "forbidden" });
    const wrong = await post(app, "/capability-rooms", {
      origin: "https://evil.example.com",
      cookie: cookieFor(sid),
      body: goodBody,
    });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({ ok: false, code: "forbidden" });
    expect(store.map.size).toBe(0);
  });

  it("rejects no/invalid/expired sessions with a constant 401", async () => {
    const { app, sessionStore } = await setup();
    const none = await post(app, "/capability-rooms", { body: goodBody });
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ ok: false, code: "unauthenticated" });
    const bogus = await post(app, "/capability-rooms", {
      cookie: cookieFor("nope"),
      body: goodBody,
    });
    expect(bogus.status).toBe(401);
    const { id: expired } = await sessionStore.create({
      userId: "old",
      createdAtMs: 0,
      expiresAtMs: NOW - 1, // lapsed
    });
    const stale = await post(app, "/capability-rooms", {
      cookie: cookieFor(expired),
      body: goodBody,
    });
    expect(stale.status).toBe(401);
  });

  it("REQUIRES Content-Length: a chunked/undeclared body is rejected 411 before any read (M1)", async () => {
    const { app, store, sid } = await setup();
    const res = await post(app, "/capability-rooms", {
      cookie: cookieFor(sid),
      body: goodBody,
      contentLength: null, // omit the header — the chunked-transfer shape
    });
    expect(res.status).toBe(411);
    expect(await res.json()).toEqual({ ok: false, code: "length-required" });
    expect(store.map.size).toBe(0);
  });

  it("rejects an over-cap or malformed Content-Length declaration with 413 (M1)", async () => {
    const { app, store, sid } = await setup();
    const declaredHuge = await post(app, "/capability-rooms", {
      cookie: cookieFor(sid),
      body: goodBody,
      contentLength: String(MAX_CAPABILITY_BODY_BYTES + 1), // lies large — rejected pre-read
    });
    expect(declaredHuge.status).toBe(413);
    expect(await declaredHuge.json()).toEqual({ ok: false, code: "too-large" });
    const malformedCl = await post(app, "/capability-rooms", {
      cookie: cookieFor(sid),
      body: goodBody,
      contentLength: "12abc",
    });
    expect(malformedCl.status).toBe(413);
    expect(store.map.size).toBe(0);
  });

  it("bounds the body: oversized → 413; non-JSON content-type / malformed JSON → 400", async () => {
    const { app, sid } = await setup();
    const big = JSON.stringify({
      roomId: ROOM,
      kind: "share",
      projectId: "p".repeat(MAX_CAPABILITY_BODY_BYTES),
    });
    const huge = await post(app, "/capability-rooms", {
      cookie: cookieFor(sid),
      body: big,
    });
    expect(huge.status).toBe(413); // true declaration → pre-read rejection
    expect(await huge.json()).toEqual({ ok: false, code: "too-large" });
    // A LYING-SMALL declaration still cannot smuggle an over-cap body past the
    // post-read BYTE check (defense-in-depth behind the CL pre-check).
    const lyingSmall = await post(app, "/capability-rooms", {
      cookie: cookieFor(sid),
      body: big,
      contentLength: "10",
    });
    expect(lyingSmall.status).toBe(413);

    const text = await post(app, "/capability-rooms", {
      cookie: cookieFor(sid),
      body: goodBody,
      contentType: "text/plain",
    });
    expect(text.status).toBe(400);

    const malformed = await post(app, "/capability-rooms", {
      cookie: cookieFor(sid),
      body: "{ nope",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ ok: false, code: "invalid" });
  });

  it("delegates policy faults to the core (invalid roomId → constant 400)", async () => {
    const { app, sid } = await setup();
    const res = await post(app, "/capability-rooms", {
      cookie: cookieFor(sid),
      body: JSON.stringify({ roomId: "share-../../etc/passwd", kind: "share" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, code: "invalid" });
  });
});

describe("POST /capability-rooms/:roomId/revoke", () => {
  it("creator revoke tombstones; unknown and foreign rooms answer identically (404)", async () => {
    const { app, store, sid, sessionStore } = await setup();
    await post(app, "/capability-rooms", {
      cookie: cookieFor(sid),
      body: goodBody,
    });

    const { id: bobSid } = await sessionStore.create({
      userId: "bob",
      createdAtMs: NOW,
      expiresAtMs: NOW + SESSION_TTL,
    });
    const foreign = await post(app, `/capability-rooms/${ROOM}/revoke`, {
      cookie: cookieFor(bobSid),
    });
    const unknown = await post(
      app,
      "/capability-rooms/share-doesnotexist000000000000000000/revoke",
      {
        cookie: cookieFor(sid),
      },
    );
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await foreign.json()).toEqual(await unknown.json()); // no ownership oracle
    expect(store.map.get(ROOM)?.revokedAtMs).toBeUndefined();

    const mine = await post(app, `/capability-rooms/${ROOM}/revoke`, {
      cookie: cookieFor(sid),
    });
    expect(mine.status).toBe(200);
    expect(store.map.get(ROOM)?.revokedAtMs).toBe(NOW); // tombstone, not a delete
  });

  it("enforces Origin and session exactly like registration", async () => {
    const { app, sid } = await setup();
    const noOrigin = await post(app, `/capability-rooms/${ROOM}/revoke`, {
      origin: null,
      cookie: cookieFor(sid),
    });
    expect(noOrigin.status).toBe(403);
    const noSession = await post(app, `/capability-rooms/${ROOM}/revoke`, {});
    expect(noSession.status).toBe(401);
  });
});

describe("router without a registry store", () => {
  it("does not mount the capability routes at all (404 fall-through)", async () => {
    const { app, sid } = await setup(false);
    const res = await post(app, "/capability-rooms", {
      cookie: cookieFor(sid),
      body: goodBody,
    });
    expect(res.status).toBe(404);
  });
});
