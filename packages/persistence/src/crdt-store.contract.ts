/**
 * Conformance contract for `CrdtStore` (roadmap #4, ADR-0018 §2).
 *
 * Every adapter — the in-memory reference impl, the filesystem store, SQLite/
 * Postgres later — must pass the exact same blocks: append→load replays into a
 * doc equal to the live one, compact folds the log to a snapshot that restores
 * identically, appends after a compaction land after the snapshot, buffers are
 * defensively copied in BOTH directions, concurrent appends lose nothing, and
 * projects are isolated. Call it from a `*.test.ts` file with a factory for the
 * implementation under test.
 *
 * Test-only: imports `vitest`. NEVER re-export from the package index (a
 * production import must not link test modules) — import it from test files.
 *
 * The factory returns the store plus an optional `reopen` hook. Adapters with a
 * durable backing (filesystem, SQLite) provide `reopen` — it must simulate a
 * process restart (new store instance over the same backing) — and get the
 * durability block; pure in-memory adapters omit it and that block is skipped.
 */
import { describe, expect, it } from "vitest";
import { CollabDocument, restoreDoc, snapshotDoc } from "@galley/collab";
import type { CrdtStore } from "@galley/shared";

export interface CrdtStoreHarness {
  store: CrdtStore;
  /**
   * Re-create the store over the same persistent backing, as a process
   * restart would. Omit for in-memory implementations.
   */
  reopen?: () => Promise<CrdtStore>;
}

const human = { kind: "human" as const, userId: "alice" };

/**
 * A live doc wired to append every emitted Yjs update to the store (the exact
 * wiring the sync server uses — ONE listener for the doc's lifetime). `insert`
 * runs an append-at-end transaction and resolves once every append so far has
 * been persisted: fs-style adapters write asynchronously, so loads must not
 * race the appends.
 */
function liveAppender(store: CrdtStore, projectId: string) {
  const live = new CollabDocument("");
  const pending: Promise<void>[] = [];
  live.doc.on("update", (u: Uint8Array) => pending.push(store.appendUpdate(projectId, u)));
  return {
    live,
    async insert(...texts: string[]): Promise<void> {
      for (const text of texts) live.transact((t) => t.insert(t.length, text), human);
      await Promise.all(pending);
    },
  };
}

export function crdtStoreContract(name: string, makeStore: () => Promise<CrdtStoreHarness>): void {
  describe(`CrdtStore conformance: ${name}`, () => {
    it("loads an unknown project as empty and compacts it without throwing", async () => {
      const { store } = await makeStore();
      expect(await store.loadUpdates("missing")).toEqual([]);
      await store.compact("missing"); // no throw, still empty after
      expect(await store.loadUpdates("missing")).toEqual([]);
    });

    it("append → load replays into a doc equal to the live one", async () => {
      const { store } = await makeStore();
      const w = liveAppender(store, "p1");
      await w.insert("persisted ", "text");

      const rebuilt = new CollabDocument("", restoreDoc(await store.loadUpdates("p1")));
      expect(rebuilt.getSource()).toBe("persisted text");
      // Full Y.Doc equivalence, not just the text projection: the restored
      // doc's encoded state is byte-identical to the live one's.
      expect(snapshotDoc(rebuilt.doc)).toEqual(snapshotDoc(w.live.doc));
    });

    it("compact folds the log to a snapshot that still restores identical state", async () => {
      const { store } = await makeStore();
      const w = liveAppender(store, "p1");
      await w.insert("0", "1", "2", "3", "4", "5");

      const before = await store.loadUpdates("p1");
      await store.compact("p1");
      const after = await store.loadUpdates("p1");
      expect(after.length).toBe(1); // one snapshot, tail cleared
      expect(after.length).toBeLessThan(before.length);

      const rebuilt = new CollabDocument("", restoreDoc(after));
      expect(rebuilt.getSource()).toBe("012345");
      expect(snapshotDoc(rebuilt.doc)).toEqual(snapshotDoc(w.live.doc));
    });

    it("appends after a compaction land after the snapshot (apply order)", async () => {
      const { store } = await makeStore();
      const w = liveAppender(store, "p1");
      await w.insert("0", "1", "2");
      await store.compact("p1");
      const [snapshot] = await store.loadUpdates("p1");

      // New updates go into a fresh tail; loadUpdates yields snapshot-then-tail.
      await w.insert("!");
      const loaded = await store.loadUpdates("p1");
      expect(loaded.length).toBe(2);
      expect(loaded[0]).toEqual(snapshot); // snapshot first, tail after
      expect(new CollabDocument("", restoreDoc(loaded)).getSource()).toBe("012!");

      // Compacting again folds snapshot + tail into one snapshot, losslessly.
      await store.compact("p1");
      const recompacted = await store.loadUpdates("p1");
      expect(recompacted.length).toBe(1);
      expect(new CollabDocument("", restoreDoc(recompacted)).getSource()).toBe("012!");
    });

    it("defensively copies appended updates (caller can't corrupt the log later)", async () => {
      const { store } = await makeStore();
      const u = new Uint8Array([1, 2, 3]);
      await store.appendUpdate("p", u);
      u[0] = 99; // mutate the caller's buffer after the append resolved
      const [stored] = await store.loadUpdates("p");
      expect([...stored!]).toEqual([1, 2, 3]);
    });

    it("mutating a returned update can't corrupt the store", async () => {
      const { store } = await makeStore();
      await store.appendUpdate("p", new Uint8Array([1, 2, 3]));
      const [out] = await store.loadUpdates("p");
      out![0] = 99; // scribble on the returned buffer
      const [stored] = await store.loadUpdates("p");
      expect([...stored!]).toEqual([1, 2, 3]);
    });

    it("does not lose updates under concurrent appends", async () => {
      // Rapid CRDT updates arrive from a synchronous Yjs listener, firing many
      // appendUpdate()s at once; without per-project serialization they can race
      // (e.g. on a seq number) and clobber each other. Fire 25 concurrently and
      // assert every one is persisted as a distinct entry.
      const { store } = await makeStore();
      const updates = Array.from({ length: 25 }, (_, i) => new Uint8Array([i]));
      await Promise.all(updates.map((u) => store.appendUpdate("p", u)));
      const loaded = await store.loadUpdates("p");
      expect(loaded.length).toBe(25);
      expect(loaded.map((u) => u[0]).sort((a, b) => a! - b!)).toEqual(updates.map((u) => u[0]));
    });

    it("isolates projects (appends to one never leak into another)", async () => {
      const { store } = await makeStore();
      await liveAppender(store, "a").insert("A");
      expect(await store.loadUpdates("b")).toEqual([]);
      expect((await store.loadUpdates("a")).length).toBeGreaterThan(0);
      // Compacting a sibling project leaves this one untouched.
      await store.compact("b");
      expect(await store.loadUpdates("b")).toEqual([]);
      expect(new CollabDocument("", restoreDoc(await store.loadUpdates("a"))).getSource()).toBe("A");
    });

    it("retains snapshot + tail across a close/reopen cycle (durability)", async (ctx) => {
      const harness = await makeStore();
      if (!harness.reopen) return ctx.skip();
      // Snapshot AND a post-compaction tail must both survive a restart, in order.
      const w = liveAppender(harness.store, "p1");
      await w.insert("0", "1", "2");
      await harness.store.compact("p1");
      await w.insert("!");

      const reopened = await harness.reopen();
      const loaded = await reopened.loadUpdates("p1");
      expect(loaded.length).toBe(2); // snapshot + one tail update, not refolded
      const rebuilt = new CollabDocument("", restoreDoc(loaded));
      expect(rebuilt.getSource()).toBe("012!");
      expect(snapshotDoc(rebuilt.doc)).toEqual(snapshotDoc(w.live.doc));
      expect(await reopened.loadUpdates("missing")).toEqual([]);
    });
  });
}
