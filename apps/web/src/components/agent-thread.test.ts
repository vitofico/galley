import { describe as suite, it, expect } from "vitest";
import {
  threadKey,
  makeEntry,
  appendEntry,
  lastRequest,
  loadThread,
  saveThread,
  clearThread,
  MAX_ENTRIES,
  MAX_SUMMARY_LEN,
  THREAD_KEY_PREFIX,
  type ThreadEntry,
  type ThreadStorage,
} from "./agent-thread.js";

/**
 * Pure-core tests for the multi-turn agent THREAD history (#15, next slice).
 *
 * The render lives in AgentPanel.tsx (jsx, browser), but the model — the entry
 * shape, the bounded append, and the localStorage (de)serialization keyed per
 * project/room — is a pure module tested here in the `node` env (no jsdom), the
 * repo's test layer. Mirrors agent-trace.ts's purity discipline.
 */

// A tiny in-memory storage stand-in (mirrors the agent-trace test approach).
function memStorage(seed: Record<string, string> = {}): ThreadStorage & { dump(): Record<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
    dump: () => Object.fromEntries(map),
  };
}

suite("threadKey — per-project/room namespacing", () => {
  it("namespaces under the galley.* convention by id", () => {
    expect(threadKey("room-abc")).toBe(`${THREAD_KEY_PREFIX}room-abc`);
    expect(threadKey("proj-1")).not.toBe(threadKey("proj-2"));
  });

  it("falls back to a stable default id when none is given", () => {
    expect(threadKey()).toBe(threadKey(undefined));
    expect(threadKey()).toContain(THREAD_KEY_PREFIX);
  });
});

suite("makeEntry — derives one history entry from a finished run", () => {
  it("captures request, status, outcome, summary, timestamp, id", () => {
    const e = makeEntry({
      request: "Add a section",
      status: "finished",
      outcome: "compiled_clean",
      summary: "Applied 2 edit(s)",
      at: 1000,
    });
    expect(e.request).toBe("Add a section");
    expect(e.status).toBe("finished");
    expect(e.outcome).toBe("compiled_clean");
    expect(e.summary).toBe("Applied 2 edit(s)");
    expect(e.at).toBe(1000);
    expect(typeof e.id).toBe("string");
    expect(e.id.length).toBeGreaterThan(0);
  });

  it("trims and caps the stored summary length", () => {
    const e = makeEntry({
      request: "  spaced  ",
      status: "error",
      summary: "x".repeat(MAX_SUMMARY_LEN + 500),
      at: 5,
    });
    expect(e.request).toBe("spaced");
    expect(e.summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LEN);
  });

  it("caps the stored request length too (no unbounded growth)", () => {
    const e = makeEntry({ request: "y".repeat(MAX_SUMMARY_LEN + 999), status: "finished", at: 1 });
    expect(e.request.length).toBeLessThanOrEqual(MAX_SUMMARY_LEN);
  });

  it("generates distinct ids for separate entries", () => {
    const a = makeEntry({ request: "a", status: "finished", at: 1 });
    const b = makeEntry({ request: "b", status: "finished", at: 1 });
    expect(a.id).not.toBe(b.id);
  });
});

suite("appendEntry — bounded, newest-last", () => {
  const mk = (i: number): ThreadEntry =>
    makeEntry({ request: `r${i}`, status: "finished", at: i });

  it("appends to the end (chronological)", () => {
    const t = appendEntry(appendEntry([], mk(1)), mk(2));
    expect(t.map((e) => e.request)).toEqual(["r1", "r2"]);
  });

  it("does not mutate the input array (pure)", () => {
    const base: ThreadEntry[] = [mk(1)];
    const next = appendEntry(base, mk(2));
    expect(base).toHaveLength(1);
    expect(next).toHaveLength(2);
  });

  it("caps retention at MAX_ENTRIES, dropping the oldest", () => {
    let t: ThreadEntry[] = [];
    for (let i = 0; i < MAX_ENTRIES + 10; i++) t = appendEntry(t, mk(i));
    expect(t).toHaveLength(MAX_ENTRIES);
    // The oldest (0..9) were dropped; the newest survives at the end.
    expect(t[0]?.request).toBe(`r10`);
    expect(t[t.length - 1]?.request).toBe(`r${MAX_ENTRIES + 9}`);
  });
});

suite("lastRequest — the newest entry's request (drives Regenerate)", () => {
  it("returns the newest (last) entry's request", () => {
    const t = appendEntry(
      appendEntry([], makeEntry({ request: "first", status: "finished", at: 1 })),
      makeEntry({ request: "second", status: "finished", at: 2 }),
    );
    expect(lastRequest(t)).toBe("second");
  });

  it("ignores older entries (only the last one matters)", () => {
    let t: ThreadEntry[] = [];
    for (let i = 0; i < 5; i++) t = appendEntry(t, makeEntry({ request: `r${i}`, status: "finished", at: i }));
    expect(lastRequest(t)).toBe("r4");
  });

  it("returns null for an empty thread", () => {
    expect(lastRequest([])).toBeNull();
  });

  it("returns null when the newest entry's request is empty/whitespace", () => {
    // makeEntry trims, so a whitespace-only request becomes "" — Regenerate must
    // have no target rather than re-running an empty prompt.
    const t = appendEntry([], makeEntry({ request: "   ", status: "finished", at: 1 }));
    expect(lastRequest(t)).toBeNull();
  });
});

suite("load/save/clear — guarded localStorage round-trip per key", () => {
  it("round-trips a thread under the id's namespaced key", () => {
    const s = memStorage();
    const t = appendEntry([], makeEntry({ request: "hi", status: "finished", at: 7 }));
    saveThread(s, "room-1", t);
    expect(s.dump()[threadKey("room-1")]).toBeDefined();
    expect(loadThread(s, "room-1")).toEqual(t);
  });

  it("isolates threads per project/room id", () => {
    const s = memStorage();
    saveThread(s, "room-1", appendEntry([], makeEntry({ request: "one", status: "finished", at: 1 })));
    saveThread(s, "room-2", appendEntry([], makeEntry({ request: "two", status: "finished", at: 2 })));
    expect(loadThread(s, "room-1").map((e) => e.request)).toEqual(["one"]);
    expect(loadThread(s, "room-2").map((e) => e.request)).toEqual(["two"]);
  });

  it("defaults to an EMPTY thread when unset or storage missing", () => {
    expect(loadThread(memStorage(), "nope")).toEqual([]);
    expect(loadThread(null, "nope")).toEqual([]);
  });

  it("treats corrupt / non-array / wrong-shape JSON as empty (never throws)", () => {
    expect(loadThread(memStorage({ [threadKey("x")]: "{not json" }), "x")).toEqual([]);
    expect(loadThread(memStorage({ [threadKey("x")]: "42" }), "x")).toEqual([]);
    expect(loadThread(memStorage({ [threadKey("x")]: '{"a":1}' }), "x")).toEqual([]);
    // An array whose items aren't valid entries is dropped item-by-item.
    expect(loadThread(memStorage({ [threadKey("x")]: '[{"junk":true},null,7]' }), "x")).toEqual([]);
  });

  it("filters out malformed entries but keeps the valid ones", () => {
    const good = makeEntry({ request: "ok", status: "finished", at: 1 });
    const raw = JSON.stringify([good, { request: "bad" }, { id: "z" }]);
    expect(loadThread(memStorage({ [threadKey("x")]: raw }), "x")).toEqual([good]);
  });

  it("enforces the retention cap on load (defends against a hand-edited oversized store)", () => {
    const many = [];
    for (let i = 0; i < MAX_ENTRIES + 20; i++) many.push(makeEntry({ request: `r${i}`, status: "finished", at: i }));
    const loaded = loadThread(memStorage({ [threadKey("x")]: JSON.stringify(many) }), "x");
    expect(loaded).toHaveLength(MAX_ENTRIES);
    expect(loaded[loaded.length - 1]?.request).toBe(`r${MAX_ENTRIES + 19}`);
  });

  it("clears only the target id's thread", () => {
    const s = memStorage();
    saveThread(s, "room-1", appendEntry([], makeEntry({ request: "a", status: "finished", at: 1 })));
    saveThread(s, "room-2", appendEntry([], makeEntry({ request: "b", status: "finished", at: 1 })));
    clearThread(s, "room-1");
    expect(loadThread(s, "room-1")).toEqual([]);
    expect(loadThread(s, "room-2").map((e) => e.request)).toEqual(["b"]);
  });

  it("swallows storage failures on every operation (fail-safe to empty)", () => {
    const throwing: ThreadStorage = {
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
    expect(loadThread(throwing, "x")).toEqual([]);
    expect(() => saveThread(throwing, "x", [])).not.toThrow();
    expect(() => clearThread(throwing, "x")).not.toThrow();
  });

  it("saving an empty thread removes the key (no empty residue)", () => {
    const s = memStorage();
    saveThread(s, "room-1", appendEntry([], makeEntry({ request: "a", status: "finished", at: 1 })));
    saveThread(s, "room-1", []);
    expect(s.dump()[threadKey("room-1")]).toBeUndefined();
    expect(loadThread(s, "room-1")).toEqual([]);
  });
});
