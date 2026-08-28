import { describe, it, expect, vi } from "vitest";
import {
  protectedBlobHashes,
  planBlobSweep,
  sweepOrphanBlobs,
  isSweepable,
  scheduleBlobSweep,
  type BlobSweepStore,
} from "./blob-gc.js";
import type { BinaryFileSnapshot, ProjectSnapshot } from "@galley/collab";
import { PersistentBlobStore, InMemoryBlobBackend } from "./idb-blob-store.js";

const H = (c: string) => c.repeat(64);
const bytes = (...b: number[]) => new Uint8Array(b);

const binary = (over: Partial<BinaryFileSnapshot> & { hash: string }): BinaryFileSnapshot => ({
  fileId: `f-${over.hash.slice(0, 4)}`,
  path: `/img-${over.hash.slice(0, 4)}.png`,
  size: 3,
  mime: "image/png",
  deleted: false,
  ...over,
});

const snap = (binaryFiles: BinaryFileSnapshot[]): ProjectSnapshot => ({
  files: [],
  mainFileId: null,
  duplicatePaths: [],
  ...(binaryFiles.length > 0 ? { binaryFiles } : {}),
});

/** A recording sweep store: a set of stored keys + a delete log. */
function fakeStore(keys: string[]): BlobSweepStore & { deleted: string[]; keysCalledAt: number[] } {
  const set = new Set(keys);
  const deleted: string[] = [];
  const keysCalledAt: number[] = [];
  let tick = 0;
  return {
    deleted,
    keysCalledAt,
    async keys() {
      keysCalledAt.push(tick++);
      return [...set];
    },
    async delete(hash: string) {
      set.delete(hash);
      deleted.push(hash);
    },
  };
}

describe("protectedBlobHashes", () => {
  it("protects EVERY referenced hash — INCLUDING tombstoned pointers (bytes retained for restore)", () => {
    const s = snap([
      binary({ hash: H("a"), deleted: false }),
      binary({ hash: H("b"), deleted: true }), // tombstoned — still protected
    ]);
    const set = protectedBlobHashes(s);
    expect(set.has(H("a"))).toBe(true);
    expect(set.has(H("b"))).toBe(true); // FAIL-FIRST: a non-tombstone-aware impl drops this
    expect(set.size).toBe(2);
  });

  it("is empty for a text-only snapshot (no binaryFiles)", () => {
    expect(protectedBlobHashes(snap([])).size).toBe(0);
  });
});

describe("planBlobSweep (pure)", () => {
  it("returns only unprotected keys, preserving order, never a protected one", () => {
    const orphans = planBlobSweep([H("a"), H("orphan"), H("b")], new Set([H("a"), H("b")]));
    expect(orphans).toEqual([H("orphan")]);
  });
});

describe("sweepOrphanBlobs", () => {
  it("deletes orphans and KEEPS referenced + tombstoned blobs", async () => {
    const store = fakeStore([H("a"), H("b"), H("orphan1"), H("orphan2")]);
    const s = snap([
      binary({ hash: H("a"), deleted: false }),
      binary({ hash: H("b"), deleted: true }), // tombstoned — must survive
    ]);
    const { deleted } = await sweepOrphanBlobs(store, () => s);
    expect(deleted.sort()).toEqual([H("orphan1"), H("orphan2")].sort());
    // The referenced + tombstoned hashes were NEVER handed to delete.
    expect(store.deleted).not.toContain(H("a"));
    expect(store.deleted).not.toContain(H("b"));
  });

  it("a tombstoned blob is NOT swept (fail-first: tombstone protection)", async () => {
    const store = fakeStore([H("t")]);
    const s = snap([binary({ hash: H("t"), deleted: true })]);
    const { deleted } = await sweepOrphanBlobs(store, () => s);
    expect(deleted).toEqual([]); // the tombstoned blob's bytes are retained
    expect(store.deleted).toEqual([]);
  });

  it("sweeps ALL keys when the snapshot references none (all orphans)", async () => {
    const store = fakeStore([H("x"), H("y")]);
    const { deleted } = await sweepOrphanBlobs(store, () => snap([]));
    expect(deleted.sort()).toEqual([H("x"), H("y")].sort());
  });

  it("is best-effort: a delete rejection does not strand the other orphans", async () => {
    const set = new Set([H("bad"), H("good")]);
    const store: BlobSweepStore = {
      async keys() {
        return [...set];
      },
      async delete(hash: string) {
        if (hash === H("bad")) throw new Error("idb error");
        set.delete(hash);
      },
    };
    const { deleted } = await sweepOrphanBlobs(store, () => snap([]));
    expect(deleted).toEqual([H("good")]); // the bad one is skipped, the good one lands
  });

  it("Security round #4 (TOCTOU): a hash referenced MID-SWEEP is re-validated and NOT deleted", async () => {
    // The sweep plans against an empty snapshot (both hashes look like orphans), then
    // a concurrent write references H("late") between keys() and its delete. The live
    // getSnapshot re-check must protect it — only the true orphan is deleted. Key order
    // puts the orphan FIRST so the reference lands before H("late") is processed.
    const store = fakeStore([H("orphan"), H("late")]);
    let live = snap([]); // planning snapshot: nothing referenced
    const getSnapshot = () => live;
    const origDelete = store.delete.bind(store);
    store.delete = async (hash: string) => {
      // Simulate a concurrent Accept committing a pointer for H("late") mid-sweep,
      // while the earlier orphan is being deleted (before H("late") is reached).
      if (hash === H("orphan")) live = snap([binary({ hash: H("late"), deleted: false })]);
      return origDelete(hash);
    };
    const { deleted } = await sweepOrphanBlobs(store, getSnapshot);
    expect(deleted).toEqual([H("orphan")]); // FAIL-FIRST: a stale-snapshot sweep also deletes H("late")
    expect(store.deleted).not.toContain(H("late")); // re-referenced blob survives (no dangling)
  });
});

describe("isSweepable", () => {
  it("accepts a store with keys + delete, rejects a plain put/get/has store", () => {
    expect(isSweepable({ keys: async () => [], delete: async () => {} })).toBe(true);
    expect(isSweepable({ put: async () => {}, get: async () => undefined, has: async () => false })).toBe(false);
    expect(isSweepable(undefined)).toBe(false);
    expect(isSweepable(null)).toBe(false);
  });
});

describe("scheduleBlobSweep (hydration-gated timing)", () => {
  it("does NOT sweep before `ready` resolves, then sweeps exactly once after", async () => {
    const store = fakeStore([H("orphan")]);
    let release!: () => void;
    const ready = new Promise<void>((res) => (release = res));

    scheduleBlobSweep(ready, store, () => snap([]));
    // Give the microtask queue a chance — no sweep may have run yet.
    await Promise.resolve();
    expect(store.keysCalledAt).toHaveLength(0); // sweep-before-hydration NEVER runs

    release();
    await ready;
    await Promise.resolve(); // let the .then chain settle
    await Promise.resolve();
    expect(store.keysCalledAt).toHaveLength(1); // swept exactly once, AFTER ready
    expect(store.deleted).toEqual([H("orphan")]);
  });

  it("is a no-op for a non-sweepable store (plain BlobStore) — never awaits/sweeps", async () => {
    const plain = { put: vi.fn(), get: vi.fn(), has: vi.fn() };
    const ready = Promise.resolve();
    scheduleBlobSweep(ready, plain, () => snap([]));
    await ready;
    await Promise.resolve();
    expect(plain.get).not.toHaveBeenCalled();
  });
});

describe("sweepOrphanBlobs — a swept orphan's servable marker is cleared too (no stranded marker)", () => {
  it("GC of a marked orphan drops both its bytes AND its servable:<hash> marker", async () => {
    // A locally-provenanced blob whose pointer never landed (an orphan) still carries a
    // servable marker. Sweeping it deletes the bytes; because delete drops the marker in
    // the SAME transaction, no stranded marker can survive to protect nothing / re-authorize.
    const store = new PersistentBlobStore(new InMemoryBlobBackend());
    const orphan = await store.put(bytes(1, 2, 3));
    await store.markServable(orphan.hash);
    expect(await store.isServable(orphan.hash)).toBe(true);

    // The snapshot references NOTHING → the blob is an orphan and is swept.
    const { deleted } = await sweepOrphanBlobs(store, () => snap([]));

    expect(deleted).toEqual([orphan.hash]);
    expect(await store.has(orphan.hash)).toBe(false);
    expect(await store.isServable(orphan.hash)).toBe(false); // marker cleared with the bytes
  });
});
