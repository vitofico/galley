import { describe, it, expect } from "vitest";
import {
  AutoAcceptAudit,
  AUDIT_HARD_CAP,
  auditStorageKey,
  type AuditEntry,
} from "./auto-accept-audit.js";
import type { SessionStoreLike } from "./control-responder-mount.js";

/**
 * Offline tests for the durable auto-accept tombstone audit (ADR-0023 §3). The
 * store is a fake localStorage; what these pin is the replay-prevention contract:
 * tombstones persist + survive a fresh instance, list newest-first, clear empties,
 * the hard cap trips `overflowed()` (never silently drops), and a present-but-
 * unparseable blob FAILS SAFE — `corrupt()` true and `has()` blocks everything.
 */
function makeStore(): SessionStoreLike & { _map: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    _map: m,
  };
}

const GRANT = "g1";

describe("auto-accept-audit — mark / has / state", () => {
  it("mark('id','d','started') then has → true, state → 'started'", () => {
    const audit = new AutoAcceptAudit(makeStore(), GRANT);
    audit.mark("id", "d", "started");
    expect(audit.has("id", "d")).toBe(true);
    expect(audit.state("id", "d")).toBe("started");
  });

  it("an unseen (id,digest) is not present and has no state", () => {
    const audit = new AutoAcceptAudit(makeStore(), GRANT);
    expect(audit.has("id", "d")).toBe(false);
    expect(audit.state("id", "d")).toBe(null);
  });

  it("a different digest for the same id is a distinct tombstone", () => {
    const audit = new AutoAcceptAudit(makeStore(), GRANT);
    audit.mark("id", "d1", "applied");
    expect(audit.has("id", "d1")).toBe(true);
    expect(audit.has("id", "d2")).toBe(false);
    expect(audit.state("id", "d2")).toBe(null);
  });

  it("re-marking the same (id,digest) updates the state in place", () => {
    const audit = new AutoAcceptAudit(makeStore(), GRANT);
    audit.mark("id", "d", "started");
    audit.mark("id", "d", "applied", { checkpointVersionId: "v1" });
    expect(audit.state("id", "d")).toBe("applied");
    expect(audit.list()).toHaveLength(1);
    expect(audit.list()[0]?.checkpointVersionId).toBe("v1");
  });
});

describe("auto-accept-audit — list / persistence / clear", () => {
  it("list() returns entries newest-first", () => {
    const audit = new AutoAcceptAudit(makeStore(), GRANT);
    audit.mark("a", "da", "started");
    audit.mark("b", "db", "started");
    audit.mark("c", "dc", "started");
    expect(audit.list().map((e: AuditEntry) => e.id)).toEqual(["c", "b", "a"]);
  });

  it("survives a fresh AutoAcceptAudit over the same store (persistence)", () => {
    const store = makeStore();
    const a1 = new AutoAcceptAudit(store, GRANT);
    a1.mark("id", "d", "applied", { request: "do x", fileCount: 2 });
    const a2 = new AutoAcceptAudit(store, GRANT);
    expect(a2.has("id", "d")).toBe(true);
    expect(a2.state("id", "d")).toBe("applied");
    expect(a2.list()[0]?.request).toBe("do x");
    expect(a2.list()[0]?.fileCount).toBe(2);
  });

  it("clear() empties the audit", () => {
    const store = makeStore();
    const audit = new AutoAcceptAudit(store, GRANT);
    audit.mark("id", "d", "started");
    audit.clear();
    expect(audit.has("id", "d")).toBe(false);
    expect(audit.list()).toEqual([]);
    expect(store._map.has(auditStorageKey(GRANT))).toBe(false);
  });
});

describe("auto-accept-audit — meta + optional checkpoint", () => {
  it("checkpointVersionId is only set when provided (exactOptionalPropertyTypes)", () => {
    const audit = new AutoAcceptAudit(makeStore(), GRANT);
    audit.mark("id", "d", "started");
    expect("checkpointVersionId" in (audit.list()[0] ?? {})).toBe(false);
    audit.mark("id2", "d2", "applied", { checkpointVersionId: "v9", at: 123 });
    const e = audit.list()[0];
    expect(e?.checkpointVersionId).toBe("v9");
    expect(e?.at).toBe(123);
  });
});


describe("auto-accept-audit — hard safety cap (overflow, never silent drop)", () => {
  it("overflowed() trips at the hard cap and tombstones are retained", () => {
    const audit = new AutoAcceptAudit(makeStore(), GRANT);
    expect(audit.overflowed()).toBe(false);
    for (let i = 0; i < AUDIT_HARD_CAP; i++) audit.mark(`id${i}`, `d${i}`, "applied");
    expect(audit.overflowed()).toBe(true);
    expect(audit.list()).toHaveLength(AUDIT_HARD_CAP);
    // The very first tombstone is NOT dropped (no silent eviction).
    expect(audit.has("id0", "d0")).toBe(true);
  });
});

describe("auto-accept-audit — corruption fails SAFE (block everything)", () => {
  it("a present-but-unparseable blob makes has() return true and corrupt() true", () => {
    const store = makeStore();
    store.setItem(auditStorageKey(GRANT), "{not valid json");
    const audit = new AutoAcceptAudit(store, GRANT);
    expect(audit.corrupt()).toBe(true);
    // Fail-safe: every (id,digest) is treated as already-seen so auto-accept
    // never applies a proposal whose audit state is unknown.
    expect(audit.has("anything", "atall")).toBe(true);
    expect(audit.has("other", "digest")).toBe(true);
    // No concrete state is known for a corrupt blob.
    expect(audit.state("anything", "atall")).toBe(null);
  });

  it("an ABSENT blob is empty, NOT corrupt (legitimate first run)", () => {
    const audit = new AutoAcceptAudit(makeStore(), GRANT);
    expect(audit.corrupt()).toBe(false);
    expect(audit.has("id", "d")).toBe(false);
  });

  it("a read-throwing store reads empty and never throws", () => {
    const throwing: SessionStoreLike = {
      getItem: () => {
        throw new Error("privacy mode");
      },
      setItem: () => {
        throw new Error("privacy mode");
      },
      removeItem: () => {
        throw new Error("privacy mode");
      },
    };
    const audit = new AutoAcceptAudit(throwing, GRANT);
    expect(audit.corrupt()).toBe(false);
    expect(audit.has("id", "d")).toBe(false);
    expect(() => audit.mark("id", "d", "started")).not.toThrow();
    expect(() => audit.clear()).not.toThrow();
  });
});
