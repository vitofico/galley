import { describe, it, expect } from "vitest";
import {
  appendInAppAudit,
  readInAppAudit,
  inAppAuditStorageKey,
  IN_APP_AUDIT_CAP,
  type InAppAuditStorage,
  type InAppAuditEntry,
} from "./in-app-audit.js";

/**
 * Offline tests for the LOCAL in-app auto-apply audit (ADR-0025 §4). The store is
 * a fake localStorage; what these pin: append/read round-trips, read is
 * newest-first, the ring drops the oldest past the cap, and two projects keep
 * isolated trails.
 */
function makeStore(): InAppAuditStorage & { _map: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    _map: m,
  };
}

function entry(runId: string, at: number, state: InAppAuditEntry["state"] = "applied"): InAppAuditEntry {
  return { runId, request: `req-${runId}`, fileCount: 1, at, state, checkpointVersionId: `v-${runId}` };
}

const P = "proj-1";

describe("in-app-audit — append / read round-trip", () => {
  it("appends an entry and reads it back", () => {
    const store = makeStore();
    appendInAppAudit(P, entry("r1", 100), store);
    const list = readInAppAudit(P, store);
    expect(list).toHaveLength(1);
    expect(list[0]?.runId).toBe("r1");
    expect(list[0]?.state).toBe("applied");
    expect(list[0]?.checkpointVersionId).toBe("v-r1");
  });

  it("persists under the per-project key and survives a fresh read", () => {
    const store = makeStore();
    appendInAppAudit(P, entry("r1", 100), store);
    expect(store._map.has(inAppAuditStorageKey(P))).toBe(true);
    // a second read (no shared instance state) still sees it
    expect(readInAppAudit(P, store)).toHaveLength(1);
  });

  it("a 'failed' entry round-trips (no checkpointVersionId)", () => {
    const store = makeStore();
    appendInAppAudit(P, { runId: "rf", request: "x", fileCount: 1, at: 5, state: "failed" }, store);
    const list = readInAppAudit(P, store);
    expect(list[0]?.state).toBe("failed");
    expect("checkpointVersionId" in (list[0] ?? {})).toBe(false);
  });
});

describe("in-app-audit — newest-first", () => {
  it("read returns entries newest-first", () => {
    const store = makeStore();
    appendInAppAudit(P, entry("r1", 100), store);
    appendInAppAudit(P, entry("r2", 200), store);
    appendInAppAudit(P, entry("r3", 300), store);
    expect(readInAppAudit(P, store).map((e) => e.runId)).toEqual(["r3", "r2", "r1"]);
  });
});

describe("in-app-audit — cap enforced", () => {
  it("drops the oldest past the cap, keeping the newest IN_APP_AUDIT_CAP", () => {
    const store = makeStore();
    for (let i = 0; i < IN_APP_AUDIT_CAP + 5; i++) {
      appendInAppAudit(P, entry(`r${i}`, i), store);
    }
    const list = readInAppAudit(P, store);
    expect(list).toHaveLength(IN_APP_AUDIT_CAP);
    // newest-first: the very newest is the last appended; the oldest 5 dropped
    expect(list[0]?.runId).toBe(`r${IN_APP_AUDIT_CAP + 4}`);
    expect(list[list.length - 1]?.runId).toBe("r5");
    expect(list.some((e) => e.runId === "r0")).toBe(false);
  });
});

describe("in-app-audit — per-project isolation", () => {
  it("two projects keep separate trails", () => {
    const store = makeStore();
    appendInAppAudit("a", entry("ra", 1), store);
    appendInAppAudit("b", entry("rb", 2), store);
    expect(readInAppAudit("a", store).map((e) => e.runId)).toEqual(["ra"]);
    expect(readInAppAudit("b", store).map((e) => e.runId)).toEqual(["rb"]);
  });
});

describe("in-app-audit — fail-safe", () => {
  it("a missing storage reads empty and append is a no-op", () => {
    expect(readInAppAudit(P, null)).toEqual([]);
    expect(() => appendInAppAudit(P, entry("r1", 1), null)).not.toThrow();
  });

  it("a corrupt blob reads as empty history (no throw)", () => {
    const store = makeStore();
    store._map.set(inAppAuditStorageKey(P), "{not json");
    expect(readInAppAudit(P, store)).toEqual([]);
  });
});
