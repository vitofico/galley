/**
 * Roadmap #4 slice 5: the sync-upgrade authorization composition + cookie parse.
 * Offline: a real in-memory session store + an inline `Authorizer` fake. Fails
 * closed for no/invalid/expired session and non-members.
 */
import { describe, it, expect } from "vitest";
import type { Authorizer } from "@galley/shared";
import { InMemorySessionStore, authorizeSyncUpgrade, parseCookie } from "./index.js";

const COOKIE = "__Host-galley.sid";

const allowing = (pairs: string[]): Authorizer => {
  const set = new Set(pairs);
  return { canAccessProject: async (userId, projectId) => set.has(`${userId}:${projectId}`) };
};

async function withSession() {
  const sessionStore = new InMemorySessionStore(() => "sid-1");
  await sessionStore.create({ userId: "u1", createdAtMs: 0, expiresAtMs: 10_000 });
  return sessionStore;
}

describe("parseCookie", () => {
  it("extracts the named cookie among several; null when absent/headerless", () => {
    expect(parseCookie(`a=1; ${COOKIE}=xyz; b=2`, COOKIE)).toBe("xyz");
    expect(parseCookie(`a=1`, COOKIE)).toBeNull();
    expect(parseCookie(undefined, COOKIE)).toBeNull();
  });
});

describe("authorizeSyncUpgrade", () => {
  it("authorizes a valid session whose user is a project member", async () => {
    const sessionStore = await withSession();
    expect(
      await authorizeSyncUpgrade({
        cookieHeader: `${COOKIE}=sid-1`,
        room: "room1",
        sessionStore,
        authorizer: allowing(["u1:room1"]),
        nowMs: 5_000,
      }),
    ).toBe(true);
  });

  it("denies a non-member (valid session, wrong project/room)", async () => {
    const sessionStore = await withSession();
    expect(
      await authorizeSyncUpgrade({
        cookieHeader: `${COOKIE}=sid-1`,
        room: "other",
        sessionStore,
        authorizer: allowing(["u1:room1"]),
        nowMs: 5_000,
      }),
    ).toBe(false);
  });

  it("denies when there is no cookie / unknown sid", async () => {
    const sessionStore = await withSession();
    const authorizer = allowing(["u1:room1"]);
    expect(
      await authorizeSyncUpgrade({ cookieHeader: undefined, room: "room1", sessionStore, authorizer, nowMs: 5_000 }),
    ).toBe(false);
    expect(
      await authorizeSyncUpgrade({ cookieHeader: `${COOKIE}=nope`, room: "room1", sessionStore, authorizer, nowMs: 5_000 }),
    ).toBe(false);
  });

  it("denies an expired session (and reaps it)", async () => {
    const sessionStore = await withSession();
    expect(
      await authorizeSyncUpgrade({
        cookieHeader: `${COOKIE}=sid-1`,
        room: "room1",
        sessionStore,
        authorizer: allowing(["u1:room1"]),
        nowMs: 20_000,
      }),
    ).toBe(false);
  });
});
