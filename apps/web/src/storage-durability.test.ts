import { describe, it, expect } from "vitest";
import {
  requestPersistentStorage,
  estimateStorage,
  durabilityStatus,
  DEFAULT_PRESSURE_THRESHOLD,
  type PersistState,
  type StorageEstimateResult,
} from "./storage-durability.js";

/**
 * A minimal fake of the slice of `navigator.storage` (StorageManager) we touch.
 * Each method is independently controllable so tests can model every real-world
 * shape (granted/denied persist, present/absent/zero-quota estimate, throwers).
 */
function fakeStorage(opts: {
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
}): StorageManager {
  // Cast through unknown: we only implement the methods under test, which is
  // exactly the structural seam the module consumes.
  return opts as unknown as StorageManager;
}

describe("requestPersistentStorage (seam wrapper)", () => {
  it("returns 'persisted' when persist() grants", async () => {
    const s = fakeStorage({
      persist: async () => true,
      persisted: async () => true,
    });
    expect(await requestPersistentStorage(s)).toBe("persisted");
  });

  it("returns 'persisted' when already persisted (persist() may report false)", async () => {
    // Some browsers already-persisted return false from persist() but true from
    // persisted(); the already-durable case must still read as persisted.
    const s = fakeStorage({
      persist: async () => false,
      persisted: async () => true,
    });
    expect(await requestPersistentStorage(s)).toBe("persisted");
  });

  it("returns 'transient' when persist() is denied and not persisted", async () => {
    const s = fakeStorage({
      persist: async () => false,
      persisted: async () => false,
    });
    expect(await requestPersistentStorage(s)).toBe("transient");
  });

  it("returns 'unsupported' when there is no storage manager", async () => {
    expect(await requestPersistentStorage(undefined)).toBe("unsupported");
  });

  it("returns 'unsupported' when persist() is missing", async () => {
    const s = fakeStorage({ persisted: async () => false });
    expect(await requestPersistentStorage(s)).toBe("unsupported");
  });

  it("maps a thrown persist() to 'unsupported' (never throws)", async () => {
    const s = fakeStorage({
      persist: async () => {
        throw new Error("blocked");
      },
      persisted: async () => false,
    });
    await expect(requestPersistentStorage(s)).resolves.toBe("unsupported");
  });
});

describe("estimateStorage (seam wrapper)", () => {
  it("returns usage/quota/percent", async () => {
    const s = fakeStorage({ estimate: async () => ({ usage: 25, quota: 100 }) });
    const r = await estimateStorage(s);
    expect(r).toEqual({ usageBytes: 25, quotaBytes: 100, percent: 0.25 });
  });

  it("returns null when unsupported (no storage manager)", async () => {
    expect(await estimateStorage(undefined)).toBeNull();
  });

  it("returns null when estimate() is missing", async () => {
    const s = fakeStorage({});
    expect(await estimateStorage(s)).toBeNull();
  });

  it("returns null percent when quota is 0 (no divide-by-zero)", async () => {
    const s = fakeStorage({ estimate: async () => ({ usage: 5, quota: 0 }) });
    const r = await estimateStorage(s);
    expect(r).toEqual({ usageBytes: 5, quotaBytes: 0, percent: null });
  });

  it("returns null percent when quota is undefined", async () => {
    const s = fakeStorage({ estimate: async () => ({ usage: 5 }) });
    const r = await estimateStorage(s);
    expect(r).toEqual({ usageBytes: 5, quotaBytes: 0, percent: null });
  });

  it("maps a thrown estimate() to null (never throws)", async () => {
    const s = fakeStorage({
      estimate: async () => {
        throw new Error("nope");
      },
    });
    await expect(estimateStorage(s)).resolves.toBeNull();
  });
});

describe("durabilityStatus (pure decision)", () => {
  const lowEstimate: StorageEstimateResult = { usageBytes: 10, quotaBytes: 100, percent: 0.1 };
  const highEstimate: StorageEstimateResult = { usageBytes: 95, quotaBytes: 100, percent: 0.95 };

  it("persisted + low usage → ok, no nudge", () => {
    const r = durabilityStatus({ persistState: "persisted", estimate: lowEstimate });
    expect(r.level).toBe("ok");
    expect(r.nudgeBackup).toBe(false);
  });

  it("persisted + no estimate → ok, no nudge", () => {
    const r = durabilityStatus({ persistState: "persisted", estimate: null });
    expect(r.level).toBe("ok");
    expect(r.nudgeBackup).toBe(false);
  });

  it("transient + low usage → ok, no nudge (denied persist alone isn't a false alarm)", () => {
    // Private/incognito mode on a fresh project denies persistence but uses
    // negligible storage — nudging here would be a false alarm.
    const r = durabilityStatus({ persistState: "transient", estimate: lowEstimate });
    expect(r.level).toBe("ok");
    expect(r.nudgeBackup).toBe(false);
  });

  it("transient + no estimate → ok, no nudge (can't see pressure → don't nag)", () => {
    const r = durabilityStatus({ persistState: "transient", estimate: null });
    expect(r.level).toBe("ok");
    expect(r.nudgeBackup).toBe(false);
  });

  it("transient + high usage → at-risk, nudge (real pressure on an evictable origin)", () => {
    const r = durabilityStatus({ persistState: "transient", estimate: highEstimate });
    expect(r.level).toBe("at-risk");
    expect(r.nudgeBackup).toBe(true);
    expect(r.reason).toMatch(/evict/i);
  });

  it("unsupported → unknown, no nudge (additive: a blind env nags no one)", () => {
    const r = durabilityStatus({ persistState: "unsupported", estimate: null });
    expect(r.level).toBe("unknown");
    expect(r.nudgeBackup).toBe(false);
  });

  it("persisted but over threshold → at-risk, nudge (storage nearly full)", () => {
    const r = durabilityStatus({ persistState: "persisted", estimate: highEstimate });
    expect(r.level).toBe("at-risk");
    expect(r.nudgeBackup).toBe(true);
    expect(r.reason).toMatch(/full|nearly/i);
  });

  it("exactly at the threshold counts as over (>=)", () => {
    const atThreshold: StorageEstimateResult = {
      usageBytes: 90,
      quotaBytes: 100,
      percent: DEFAULT_PRESSURE_THRESHOLD,
    };
    const r = durabilityStatus({ persistState: "persisted", estimate: atThreshold });
    expect(r.level).toBe("at-risk");
    expect(r.nudgeBackup).toBe(true);
  });

  it("honors a custom pressureThreshold", () => {
    const e: StorageEstimateResult = { usageBytes: 60, quotaBytes: 100, percent: 0.6 };
    expect(durabilityStatus({ persistState: "persisted", estimate: e }).level).toBe("ok");
    expect(
      durabilityStatus({ persistState: "persisted", estimate: e, pressureThreshold: 0.5 }).level,
    ).toBe("at-risk");
  });

  it("DEFAULT_PRESSURE_THRESHOLD is a high-water mark (0..1)", () => {
    expect(DEFAULT_PRESSURE_THRESHOLD).toBeGreaterThan(0.5);
    expect(DEFAULT_PRESSURE_THRESHOLD).toBeLessThanOrEqual(1);
  });
});
