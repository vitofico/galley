import { describe, it, expect } from "vitest";
import {
  AUTO_SNAPSHOT_KEY,
  DEFAULT_EDIT_THRESHOLD,
  DEFAULT_INTERVAL_MS,
  defaultAutoSnapshotPolicy,
  enabledAutoSnapshotPolicy,
  loadAutoSnapshotPolicy,
  saveAutoSnapshotPolicy,
  shouldSnapshot,
  type AutoSnapshotPolicy,
  type AutoSnapshotState,
  type AutoSnapshotStorage,
} from "./auto-snapshot.js";

/** Map-backed fake of the storage slice (the Node gate has no localStorage). */
function fakeStorage(
  seed?: Record<string, string>,
): AutoSnapshotStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed ?? {}));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

const STATE = (over: Partial<AutoSnapshotState> = {}): AutoSnapshotState => ({
  lastSnapshotTime: 0,
  editsSinceLast: 0,
  ...over,
});

describe("auto-snapshot key", () => {
  it("is the galley.* namespaced localStorage key", () => {
    expect(AUTO_SNAPSHOT_KEY).toBe("galley.autoSnapshot");
  });
});

describe("shouldSnapshot — disabled (default-OFF guarantee)", () => {
  it("is always false when the policy is disabled, whatever the state", () => {
    const policy: AutoSnapshotPolicy = { enabled: false, intervalMs: 1, editThreshold: 1 };
    expect(shouldSnapshot(STATE({ editsSinceLast: 1_000 }), 1_000_000, policy)).toBe(false);
  });

  it("the default policy never fires", () => {
    expect(
      shouldSnapshot(STATE({ editsSinceLast: 999 }), 999_999, defaultAutoSnapshotPolicy()),
    ).toBe(false);
  });

  it("an enabled policy with NEITHER cadence set never fires (no spam)", () => {
    expect(shouldSnapshot(STATE({ editsSinceLast: 999 }), 999_999, { enabled: true })).toBe(false);
  });
});

describe("shouldSnapshot — interval cadence", () => {
  const policy: AutoSnapshotPolicy = { enabled: true, intervalMs: 1_000 };

  it("false before the interval elapses", () => {
    expect(shouldSnapshot(STATE({ lastSnapshotTime: 0 }), 999, policy)).toBe(false);
  });

  it("true exactly at the interval boundary (>=)", () => {
    expect(shouldSnapshot(STATE({ lastSnapshotTime: 0 }), 1_000, policy)).toBe(true);
  });

  it("true past the interval", () => {
    expect(shouldSnapshot(STATE({ lastSnapshotTime: 5_000 }), 6_500, policy)).toBe(true);
  });

  it("ignores a zero/undefined interval", () => {
    expect(shouldSnapshot(STATE(), 1_000_000, { enabled: true, intervalMs: 0 })).toBe(false);
    // intervalMs simply absent (the property omitted) — the disable case in practice.
    expect(shouldSnapshot(STATE(), 1_000_000, { enabled: true })).toBe(false);
  });
});

describe("shouldSnapshot — edit-count cadence", () => {
  const policy: AutoSnapshotPolicy = { enabled: true, editThreshold: 30 };

  it("false below the threshold", () => {
    expect(shouldSnapshot(STATE({ editsSinceLast: 29 }), 0, policy)).toBe(false);
  });

  it("true exactly at the threshold boundary (>=)", () => {
    expect(shouldSnapshot(STATE({ editsSinceLast: 30 }), 0, policy)).toBe(true);
  });

  it("true above the threshold", () => {
    expect(shouldSnapshot(STATE({ editsSinceLast: 31 }), 0, policy)).toBe(true);
  });

  it("ignores a zero/undefined threshold", () => {
    expect(
      shouldSnapshot(STATE({ editsSinceLast: 999 }), 0, { enabled: true, editThreshold: 0 }),
    ).toBe(false);
  });
});

describe("shouldSnapshot — OR of both cadences", () => {
  const policy: AutoSnapshotPolicy = { enabled: true, intervalMs: 1_000, editThreshold: 30 };

  it("fires on the interval even with few edits", () => {
    expect(shouldSnapshot(STATE({ lastSnapshotTime: 0, editsSinceLast: 1 }), 2_000, policy)).toBe(
      true,
    );
  });

  it("fires on the edit count even within the interval", () => {
    expect(shouldSnapshot(STATE({ lastSnapshotTime: 0, editsSinceLast: 40 }), 10, policy)).toBe(
      true,
    );
  });

  it("does not fire when neither cadence is met", () => {
    expect(shouldSnapshot(STATE({ lastSnapshotTime: 0, editsSinceLast: 5 }), 500, policy)).toBe(
      false,
    );
  });
});

describe("load/save round-trip", () => {
  it("returns the disabled default when nothing is stored", () => {
    expect(loadAutoSnapshotPolicy(fakeStorage())).toEqual({ enabled: false });
  });

  it("round-trips an enabled policy with both cadences", () => {
    const store = fakeStorage();
    const policy = enabledAutoSnapshotPolicy();
    saveAutoSnapshotPolicy(policy, store);
    expect(loadAutoSnapshotPolicy(store)).toEqual(policy);
  });

  it("the enabled defaults carry the module cadences but enabled=true", () => {
    const p = enabledAutoSnapshotPolicy();
    expect(p).toEqual({
      enabled: true,
      intervalMs: DEFAULT_INTERVAL_MS,
      editThreshold: DEFAULT_EDIT_THRESHOLD,
    });
  });

  it("falls back to default on corrupt JSON (never silently enables)", () => {
    expect(loadAutoSnapshotPolicy(fakeStorage({ [AUTO_SNAPSHOT_KEY]: "{not json" }))).toEqual({
      enabled: false,
    });
  });

  it("falls back to default on a non-object payload", () => {
    expect(loadAutoSnapshotPolicy(fakeStorage({ [AUTO_SNAPSHOT_KEY]: "42" }))).toEqual({
      enabled: false,
    });
    expect(loadAutoSnapshotPolicy(fakeStorage({ [AUTO_SNAPSHOT_KEY]: "null" }))).toEqual({
      enabled: false,
    });
  });

  it("reads enabled=false for any non-true enabled value", () => {
    expect(
      loadAutoSnapshotPolicy(fakeStorage({ [AUTO_SNAPSHOT_KEY]: '{"enabled":"yes"}' })),
    ).toEqual({ enabled: false });
  });

  it("drops invalid cadences but keeps enabled", () => {
    const stored = '{"enabled":true,"intervalMs":-5,"editThreshold":"x"}';
    expect(loadAutoSnapshotPolicy(fakeStorage({ [AUTO_SNAPSHOT_KEY]: stored }))).toEqual({
      enabled: true,
    });
  });

  it("returns the default when storage is unavailable (null)", () => {
    expect(loadAutoSnapshotPolicy(null)).toEqual({ enabled: false });
  });

  it("swallows setItem failures", () => {
    const throwing: AutoSnapshotStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => saveAutoSnapshotPolicy(enabledAutoSnapshotPolicy(), throwing)).not.toThrow();
  });

  it("save is a no-op (no throw) when storage is null", () => {
    expect(() => saveAutoSnapshotPolicy(enabledAutoSnapshotPolicy(), null)).not.toThrow();
  });
});
