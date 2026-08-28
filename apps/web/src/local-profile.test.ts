import { describe, it, expect } from "vitest";
import {
  loadLocalProfile,
  updateLocalProfile,
  LOCAL_PROFILE_KEY,
  type LocalProfile,
} from "./local-profile.js";

/** A tiny Map-backed Storage-like fake (just the two methods we use). */
function fakeStore(seed?: Record<string, string>) {
  const m = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    map: m,
    getItem: (k: string): string | null => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string): void => void m.set(k, v),
  };
}

describe("loadLocalProfile", () => {
  it("mints a stable id and persists it when absent", () => {
    const store = fakeStore();
    const p = loadLocalProfile(store);
    expect(typeof p.userId).toBe("string");
    expect(p.userId.length).toBeGreaterThan(0);
    expect(p.userId.startsWith("local-")).toBe(true);
    // It persisted to the documented key.
    expect(store.getItem(LOCAL_PROFILE_KEY)).not.toBeNull();
    expect(store.getItem(LOCAL_PROFILE_KEY)).toContain(p.userId);
  });

  it("is idempotent: a second load returns the same id", () => {
    const store = fakeStore();
    const first = loadLocalProfile(store);
    const second = loadLocalProfile(store);
    expect(second.userId).toBe(first.userId);
  });

  it("returns the stored profile when one is pre-seeded", () => {
    const existing: LocalProfile = { userId: "local-deadbeef", displayName: "Ada", color: "#ff0000" };
    const store = fakeStore({ [LOCAL_PROFILE_KEY]: JSON.stringify(existing) });
    const p = loadLocalProfile(store);
    expect(p.userId).toBe("local-deadbeef");
    expect(p.displayName).toBe("Ada");
    expect(p.color).toBe("#ff0000");
    // No churn: it did not overwrite the stored value.
    expect(JSON.parse(store.getItem(LOCAL_PROFILE_KEY) as string).userId).toBe("local-deadbeef");
  });

  it("re-mints (and persists) when the stored value is corrupt JSON", () => {
    const store = fakeStore({ [LOCAL_PROFILE_KEY]: "{not json" });
    const p = loadLocalProfile(store);
    expect(p.userId.startsWith("local-")).toBe(true);
    // The corrupt value was replaced with a valid, parseable profile.
    expect(JSON.parse(store.getItem(LOCAL_PROFILE_KEY) as string).userId).toBe(p.userId);
  });

  it("re-mints when the stored object lacks a userId", () => {
    const store = fakeStore({ [LOCAL_PROFILE_KEY]: JSON.stringify({ displayName: "x" }) });
    const p = loadLocalProfile(store);
    expect(p.userId.startsWith("local-")).toBe(true);
    expect(JSON.parse(store.getItem(LOCAL_PROFILE_KEY) as string).userId).toBe(p.userId);
  });

  it("mints distinct ids for distinct stores", () => {
    const a = loadLocalProfile(fakeStore());
    const b = loadLocalProfile(fakeStore());
    expect(a.userId).not.toBe(b.userId);
  });
});

describe("updateLocalProfile (#19.4 join identity)", () => {
  it("merges a patch and persists it, keeping the stable userId", () => {
    const store = fakeStore();
    const minted = loadLocalProfile(store);
    const next = updateLocalProfile({ displayName: "Bobbie", namePromptSeen: true }, store);
    expect(next.userId).toBe(minted.userId);
    expect(next.displayName).toBe("Bobbie");
    expect(next.namePromptSeen).toBe(true);
    const stored = JSON.parse(store.getItem(LOCAL_PROFILE_KEY) as string) as LocalProfile;
    expect(stored).toEqual(next);
  });

  it("a skip persists namePromptSeen without inventing a displayName", () => {
    const store = fakeStore();
    const next = updateLocalProfile({ namePromptSeen: true }, store);
    expect(next.namePromptSeen).toBe(true);
    expect(next.displayName).toBeUndefined();
    // A later load sees the flag → the prompt never re-appears.
    expect(loadLocalProfile(store).namePromptSeen).toBe(true);
  });

  it("mints a profile first when none exists yet", () => {
    const store = fakeStore();
    const next = updateLocalProfile({ displayName: "Ada" }, store);
    expect(next.userId.startsWith("local-")).toBe(true);
    expect(loadLocalProfile(store).displayName).toBe("Ada");
  });

  it("a patch can never clobber the userId", () => {
    const store = fakeStore({
      [LOCAL_PROFILE_KEY]: JSON.stringify({ userId: "local-keep" } satisfies LocalProfile),
    });
    const next = updateLocalProfile({ displayName: "X" }, store);
    expect(next.userId).toBe("local-keep");
  });
});
