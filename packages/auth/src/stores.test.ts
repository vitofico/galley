/**
 * Roadmap #4 slice 4a: the in-memory session + login-state stores. Pins the
 * security-relevant behaviors: fresh session ids (no fixation), expiry reaping,
 * and ONE-TIME login-state consumption (state replay defense).
 */
import { describe, it, expect } from "vitest";
import { InMemorySessionStore, InMemoryOidcLoginStateStore } from "./index.js";
import type { OidcLoginState, SessionRecord } from "@galley/shared";

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  userId: "oidc:abc",
  createdAtMs: 1_000,
  expiresAtMs: 10_000,
  ...over,
});

describe("InMemorySessionStore", () => {
  it("mints a fresh id per create (no fixation) and reads it back", async () => {
    let n = 0;
    const store = new InMemorySessionStore(() => `sid-${n++}`);
    const a = await store.create(record());
    const b = await store.create(record());
    expect(a.id).toBe("sid-0");
    expect(b.id).toBe("sid-1"); // never reuses an id
    expect(await store.get("sid-0")).toEqual(record());
  });

  it("default ids are high-entropy and unguessable (distinct, URL-safe)", async () => {
    const store = new InMemorySessionStore();
    const a = await store.create(record());
    const b = await store.create(record());
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.id.length).toBeGreaterThanOrEqual(40); // ~256 bits
  });

  it("delete removes a session; get of an unknown id is null", async () => {
    const store = new InMemorySessionStore(() => "sid");
    await store.create(record());
    await store.delete("sid");
    expect(await store.get("sid")).toBeNull();
    expect(await store.get("nope")).toBeNull();
  });

  it("getValid enforces expiry (returns null + reaps an expired session)", async () => {
    const store = new InMemorySessionStore(() => "sid");
    await store.create(record({ expiresAtMs: 5_000 }));
    expect(await store.getValid("sid", 4_999)).not.toBeNull(); // still valid
    expect(await store.getValid("sid", 5_000)).toBeNull(); // expired (boundary inclusive)
    expect(await store.get("sid")).toBeNull(); // reaped on access
  });

  it("deleteExpired reaps only lapsed sessions (boundary inclusive)", async () => {
    let n = 0;
    const store = new InMemorySessionStore(() => `s${n++}`);
    await store.create(record({ expiresAtMs: 5_000 })); // s0 expires at 5000
    await store.create(record({ expiresAtMs: 20_000 })); // s1 later
    await store.deleteExpired(5_000); // <= now → expired
    expect(await store.get("s0")).toBeNull();
    expect(await store.get("s1")).not.toBeNull();
  });
});

describe("InMemoryOidcLoginStateStore", () => {
  const state = (s: string): OidcLoginState => ({
    state: s,
    codeVerifier: "v",
    nonce: "n",
    returnTo: "/",
    expiresAtMs: 9_999,
  });

  it("consume returns the state exactly once, then null (replay defense)", async () => {
    const store = new InMemoryOidcLoginStateStore();
    await store.put(state("xyz"));
    expect(await store.consume("xyz", 1_000)).toMatchObject({ state: "xyz", codeVerifier: "v" });
    expect(await store.consume("xyz", 1_000)).toBeNull(); // already consumed — no replay
  });

  it("consume burns an EXPIRED state too (deletes + returns null — no replay of stale states)", async () => {
    const store = new InMemoryOidcLoginStateStore();
    await store.put(state("old")); // expiresAtMs 9_999
    expect(await store.consume("old", 10_000)).toBeNull(); // expired at consume time
    // It was still burned, so even a "valid" later consume can't retrieve it.
    expect(await store.consume("old", 1_000)).toBeNull();
  });

  it("consume of an unknown state is null", async () => {
    expect(await new InMemoryOidcLoginStateStore().consume("nope", 1_000)).toBeNull();
  });
});
