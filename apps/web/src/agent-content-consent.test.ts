import { describe, it, expect } from "vitest";
import {
  AGENT_CONTENT_GRANTS_KEY,
  MAX_CONTENT_GRANTS,
  MAX_GRANT_PROJECT_ID_CHARS,
  grantContentAccess,
  isContentGranted,
  readContentGrants,
  revokeAllContentGrants,
  revokeContentAccess,
  type ConsentStoreLike,
} from "./agent-content-consent.js";

/**
 * Offline tests for the per-project content-consent grant set (#1 slice 1).
 * The store is a fake sessionStorage; what these pin is the SECURITY contract:
 * default zero grants, fail-closed reads on ANY malformed state, bounded ids
 * and set size, and grant/revoke round-trips.
 */

function makeStore(): ConsentStoreLike & { _map: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    _map: m,
  };
}

describe("agent-content-consent — default zero grants", () => {
  it("a fresh store has no grants and nothing is granted", () => {
    const store = makeStore();
    expect(readContentGrants(store)).toEqual([]);
    expect(isContentGranted(store, "proj-1")).toBe(false);
  });

  it("a null store (privacy mode / Node) reads as zero grants and never throws", () => {
    expect(readContentGrants(null)).toEqual([]);
    expect(isContentGranted(null, "proj-1")).toBe(false);
    expect(grantContentAccess(null, "proj-1")).toBe(false);
    expect(() => revokeContentAccess(null, "proj-1")).not.toThrow();
    expect(() => revokeAllContentGrants(null)).not.toThrow();
  });
});

describe("agent-content-consent — grant / revoke round-trip", () => {
  it("grant makes exactly that project granted", () => {
    const store = makeStore();
    expect(grantContentAccess(store, "proj-1")).toBe(true);
    expect(isContentGranted(store, "proj-1")).toBe(true);
    expect(isContentGranted(store, "proj-2")).toBe(false);
    expect(readContentGrants(store)).toEqual(["proj-1"]);
  });

  it("grant is idempotent (no duplicate entries)", () => {
    const store = makeStore();
    grantContentAccess(store, "proj-1");
    grantContentAccess(store, "proj-1");
    expect(readContentGrants(store)).toEqual(["proj-1"]);
  });

  it("per-project revoke removes only that grant", () => {
    const store = makeStore();
    grantContentAccess(store, "proj-1");
    grantContentAccess(store, "proj-2");
    revokeContentAccess(store, "proj-1");
    expect(isContentGranted(store, "proj-1")).toBe(false);
    expect(isContentGranted(store, "proj-2")).toBe(true);
  });

  it("revokeAll clears everything and removes the key entirely", () => {
    const store = makeStore();
    grantContentAccess(store, "proj-1");
    grantContentAccess(store, "proj-2");
    revokeAllContentGrants(store);
    expect(readContentGrants(store)).toEqual([]);
    expect(store._map.has(AGENT_CONTENT_GRANTS_KEY)).toBe(false);
  });

  it("revoking the last grant removes the key (no empty-array residue)", () => {
    const store = makeStore();
    grantContentAccess(store, "proj-1");
    revokeContentAccess(store, "proj-1");
    expect(store._map.has(AGENT_CONTENT_GRANTS_KEY)).toBe(false);
  });
});

describe("agent-content-consent — fail-closed on malformed storage", () => {
  it.each([
    ["not json at all", "][{{"],
    ["a JSON object", JSON.stringify({ "proj-1": true })],
    ["a JSON string", JSON.stringify("proj-1")],
    ["a JSON number", "42"],
    ["null literal", "null"],
  ])("%s reads as zero grants", (_name, blob) => {
    const store = makeStore();
    store.setItem(AGENT_CONTENT_GRANTS_KEY, blob);
    expect(readContentGrants(store)).toEqual([]);
    expect(isContentGranted(store, "proj-1")).toBe(false);
  });

  it("ill-typed and over-length entries inside a valid array are dropped", () => {
    const store = makeStore();
    store.setItem(
      AGENT_CONTENT_GRANTS_KEY,
      JSON.stringify([42, null, "", { id: "x" }, "a".repeat(MAX_GRANT_PROJECT_ID_CHARS + 1), "proj-ok"]),
    );
    expect(readContentGrants(store)).toEqual(["proj-ok"]);
  });

  it("a throwing store reads as zero grants, never a throw", () => {
    const store: ConsentStoreLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readContentGrants(store)).toEqual([]);
    expect(isContentGranted(store, "proj-1")).toBe(false);
    expect(grantContentAccess(store, "proj-1")).toBe(false);
    expect(() => revokeAllContentGrants(store)).not.toThrow();
  });
});

describe("agent-content-consent — bounds", () => {
  it("refuses an empty or over-length projectId", () => {
    const store = makeStore();
    expect(grantContentAccess(store, "")).toBe(false);
    expect(grantContentAccess(store, "a".repeat(MAX_GRANT_PROJECT_ID_CHARS + 1))).toBe(false);
    expect(readContentGrants(store)).toEqual([]);
    // isContentGranted also bounds its input (never scans for a hostile id).
    expect(isContentGranted(store, "")).toBe(false);
    expect(isContentGranted(store, "a".repeat(MAX_GRANT_PROJECT_ID_CHARS + 1))).toBe(false);
  });

  it("the grant set is count-capped", () => {
    const store = makeStore();
    for (let i = 0; i < MAX_CONTENT_GRANTS; i++) {
      expect(grantContentAccess(store, `proj-${i}`)).toBe(true);
    }
    expect(grantContentAccess(store, "proj-overflow")).toBe(false);
    expect(isContentGranted(store, "proj-overflow")).toBe(false);
    expect(readContentGrants(store)).toHaveLength(MAX_CONTENT_GRANTS);
  });

  it("a forged oversized stored array is clamped at read time", () => {
    const store = makeStore();
    const huge = Array.from({ length: MAX_CONTENT_GRANTS + 50 }, (_v, i) => `proj-${i}`);
    store.setItem(AGENT_CONTENT_GRANTS_KEY, JSON.stringify(huge));
    expect(readContentGrants(store)).toHaveLength(MAX_CONTENT_GRANTS);
  });
});
