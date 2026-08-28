import { describe, it, expect } from "vitest";
import {
  InMemoryBlobBackend,
  IndexeddbBlobBackend,
  PersistentBlobStore,
  BlobQuotaExceededError,
  DEFAULT_BLOB_QUOTA_BYTES,
  blobDbName,
  type BlobBackend,
} from "./idb-blob-store.js";
import { sha256Hex, InMemoryBlobStore } from "@galley/collab";

const bytes = (...b: number[]) => new Uint8Array(b);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3);
const H = (c: string) => c.repeat(64);

describe("PersistentBlobStore (#7 7C-2)", () => {
  it("put returns a content-addressed pointer and stores the bytes", async () => {
    const store = new PersistentBlobStore(new InMemoryBlobBackend());
    const asset = await store.put(PNG, { filename: "x.png" });
    expect(asset).toEqual({ type: "binary", hash: await sha256Hex(PNG), size: PNG.byteLength, mime: "image/png" });
    expect(await store.has(asset.hash)).toBe(true);
    expect(await store.get(asset.hash)).toEqual(PNG);
  });

  it("dedupes identical content (stored once)", async () => {
    const backend = new InMemoryBlobBackend();
    const store = new PersistentBlobStore(backend);
    const a = await store.put(PNG);
    const b = await store.put(PNG.slice());
    expect(a.hash).toBe(b.hash);
  });

  it("get returns undefined for an unknown hash", async () => {
    const store = new PersistentBlobStore(new InMemoryBlobBackend());
    expect(await store.get("deadbeef")).toBeUndefined();
  });

  it("VERIFIES on read: a corrupted/tampered blob fails closed to undefined", async () => {
    // A backend that returns the WRONG bytes for the requested hash (tamper).
    const tampering: BlobBackend = {
      async has() {
        return true;
      },
      async get() {
        return bytes(9, 9, 9); // does not hash to the requested key
      },
      async put() {},
      async delete() {},
      async keys() {
        return [];
      },
      async totalBytes() {
        return 0;
      },
      async markServable() {},
      async isServable() {
        return false;
      },
    };
    const store = new PersistentBlobStore(tampering);
    expect(await store.get("anyhash")).toBeUndefined();
  });

  it("namespaces the blob DB per project", () => {
    expect(blobDbName("proj-1")).toBe("galley.blobs.proj-1");
    expect(blobDbName("proj-1")).not.toBe(blobDbName("proj-2"));
  });

  // A2/C1: delete removes the orphan bytes (an upload-failed/unpublished blob).
  it("delete removes the stored bytes (orphan cleanup)", async () => {
    const store = new PersistentBlobStore(new InMemoryBlobBackend());
    const asset = await store.put(PNG);
    expect(await store.has(asset.hash)).toBe(true);
    await store.delete(asset.hash);
    expect(await store.has(asset.hash)).toBe(false);
    expect(await store.get(asset.hash)).toBeUndefined();
  });

  it("delete is idempotent — a missing hash is a no-op (never throws)", async () => {
    const store = new PersistentBlobStore(new InMemoryBlobBackend());
    await expect(store.delete("deadbeef")).resolves.toBeUndefined();
  });
});

describe("InMemoryBlobBackend — keys + totalBytes (GC/quota introspection)", () => {
  it("keys() enumerates stored hashes; totalBytes() tracks the running total", async () => {
    const backend = new InMemoryBlobBackend();
    expect(await backend.keys()).toEqual([]);
    expect(await backend.totalBytes()).toBe(0);
    await backend.put(H("a"), bytes(1, 2, 3));
    await backend.put(H("b"), bytes(4, 5));
    expect((await backend.keys()).sort()).toEqual([H("a"), H("b")].sort());
    expect(await backend.totalBytes()).toBe(5);
  });

  it("dedupe does NOT double-count the byte total; delete decrements it", async () => {
    const backend = new InMemoryBlobBackend();
    await backend.put(H("a"), bytes(1, 2, 3));
    await backend.put(H("a"), bytes(1, 2, 3)); // same hash — dedup, no growth
    expect(await backend.totalBytes()).toBe(3);
    await backend.delete(H("a"));
    expect(await backend.totalBytes()).toBe(0);
    expect(await backend.keys()).toEqual([]);
  });

  it("the default cap is the documented 512 MiB", () => {
    expect(DEFAULT_BLOB_QUOTA_BYTES).toBe(512 * 1024 * 1024);
  });
});

describe("InMemoryBlobBackend — quota refusal + atomic concurrent puts (fail-first)", () => {
  it("REFUSES a put past the byte cap with a typed BlobQuotaExceededError", async () => {
    const backend = new InMemoryBlobBackend(10);
    await backend.put(H("a"), bytes(1, 2, 3, 4, 5, 6)); // 6 ≤ 10 ok
    let err: unknown;
    try {
      await backend.put(H("b"), bytes(1, 2, 3, 4, 5, 6)); // 6 + 6 = 12 > 10 → refuse
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BlobQuotaExceededError);
    expect((err as BlobQuotaExceededError).attemptedBytes).toBe(6);
    expect((err as BlobQuotaExceededError).capBytes).toBe(10);
    expect((err as BlobQuotaExceededError).currentBytes).toBe(6);
    // The refused blob was NOT stored — the total stays at the admitted 6.
    expect(await backend.totalBytes()).toBe(6);
    expect(await backend.has(H("b"))).toBe(false);
  });

  it("a re-put of an ALREADY-STORED hash past the cap still succeeds (dedupe, no growth)", async () => {
    const backend = new InMemoryBlobBackend(6);
    await backend.put(H("a"), bytes(1, 2, 3, 4, 5, 6));
    // Same hash: idempotent no-op even at the cap (adds nothing).
    await expect(backend.put(H("a"), bytes(1, 2, 3, 4, 5, 6))).resolves.toBeUndefined();
    expect(await backend.totalBytes()).toBe(6);
  });

  it("ATOMICITY: concurrent puts cannot collectively exceed the cap (exactly one admitted)", async () => {
    // FAIL-FIRST: with no quota (pre-change) BOTH puts store and the total is 12.
    const backend = new InMemoryBlobBackend(10);
    const results = await Promise.allSettled([
      backend.put(H("a"), bytes(1, 2, 3, 4, 5, 6)), // 6
      backend.put(H("b"), bytes(7, 8, 9, 10, 11, 12)), // 6
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BlobQuotaExceededError);
    // The cap held: the store never exceeded 10 bytes.
    expect(await backend.totalBytes()).toBeLessThanOrEqual(10);
    expect(await backend.totalBytes()).toBe(6);
  });
});

describe("PersistentBlobStore — quota propagates from the backend", () => {
  it("put re-throws BlobQuotaExceededError when the backend is full", async () => {
    const store = new PersistentBlobStore(new InMemoryBlobBackend(4));
    await store.put(bytes(1, 2, 3, 4)); // fills the 4-byte cap
    await expect(store.put(bytes(5, 6, 7, 8, 9))).rejects.toBeInstanceOf(BlobQuotaExceededError);
  });

  it("exposes keys() + totalBytes() (delegating to the backend) for the GC sweep", async () => {
    const store = new PersistentBlobStore(new InMemoryBlobBackend());
    const asset = await store.put(PNG);
    expect(await store.keys()).toEqual([asset.hash]);
    expect(await store.totalBytes()).toBe(PNG.byteLength);
  });
});

describe("PersistentBlobStore — servable-provenance markers (Contract A)", () => {
  it("markServable grants; isServable reads it back; unmarked stays false", async () => {
    const store = new PersistentBlobStore(new InMemoryBlobBackend());
    const asset = await store.put(PNG);
    expect(await store.isServable(asset.hash)).toBe(false); // no grant yet
    await store.markServable(asset.hash);
    expect(await store.isServable(asset.hash)).toBe(true);
    expect(await store.isServable(H("z"))).toBe(false); // a different, unmarked hash
  });

  it("markServable is idempotent — re-granting keeps it set (no throw)", async () => {
    const store = new PersistentBlobStore(new InMemoryBlobBackend());
    const asset = await store.put(PNG);
    await store.markServable(asset.hash);
    await expect(store.markServable(asset.hash)).resolves.toBeUndefined();
    expect(await store.isServable(asset.hash)).toBe(true);
  });

  it("put() stays NEUTRAL — storing bytes NEVER grants a marker (exfiltration guard)", async () => {
    // FAIL-FIRST: if put auto-granted (the parked snapshot-based bug), this would be true.
    const store = new PersistentBlobStore(new InMemoryBlobBackend());
    const asset = await store.put(PNG);
    expect(await store.has(asset.hash)).toBe(true); // bytes are a neutral cache
    expect(await store.isServable(asset.hash)).toBe(false); // but NOT servable
    // A later trusted local action is the ONLY thing that flips it.
    await store.markServable(asset.hash);
    expect(await store.isServable(asset.hash)).toBe(true);
  });

  it("delete drops the marker ATOMICALLY and keeps the byte total correct", async () => {
    const store = new PersistentBlobStore(new InMemoryBlobBackend());
    const asset = await store.put(PNG);
    await store.markServable(asset.hash);
    expect(await store.isServable(asset.hash)).toBe(true);
    expect(await store.totalBytes()).toBe(PNG.byteLength);
    await store.delete(asset.hash);
    expect(await store.isServable(asset.hash)).toBe(false); // marker never outlives its bytes
    expect(await store.has(asset.hash)).toBe(false);
    expect(await store.totalBytes()).toBe(0); // byte-total decrement stays correct
  });

  it("markServable is INDEPENDENT of whether the bytes are present", async () => {
    // A grant may precede/outlast byte presence at the API level; the marker is a pure
    // per-hash fact. (The session layer AND the bytes gate servability together.)
    const store = new PersistentBlobStore(new InMemoryBlobBackend());
    const orphanHash = H("d");
    expect(await store.has(orphanHash)).toBe(false);
    await store.markServable(orphanHash);
    expect(await store.isServable(orphanHash)).toBe(true); // marked despite no bytes
    expect(await store.has(orphanHash)).toBe(false);
  });

  it("markServable REJECTS a non-64-hex hash (no-op; nothing marked)", async () => {
    const store = new PersistentBlobStore(new InMemoryBlobBackend());
    for (const bad of ["", "deadbeef", H("a").slice(0, 63), H("a") + "0", H("A"), `${H("a").slice(0, 63)}g`]) {
      await expect(store.markServable(bad)).resolves.toBeUndefined();
      expect(await store.isServable(bad)).toBe(false); // a malformed grant never plants a marker
    }
  });
});

describe("InMemoryBlobStore — servable markers mirror the persistent semantics", () => {
  it("grants, reads, stays neutral on put, and no-ops on a bad hash", async () => {
    const store = new InMemoryBlobStore();
    const asset = await store.put(PNG);
    expect(await store.isServable(asset.hash)).toBe(false); // put is neutral
    await store.markServable(asset.hash);
    expect(await store.isServable(asset.hash)).toBe(true);
    await store.markServable("not-a-hash");
    expect(await store.isServable("not-a-hash")).toBe(false); // validation no-op
  });
});

/**
 * A compact, persistence-faithful in-memory IDBFactory. `fake-indexeddb` is NOT a
 * dependency (this module hand-rolls IDB fakes — see idb-project-store.test.ts), so this
 * provides just enough REAL IndexedDB behaviour to prove DURABILITY: the stored data lives
 * in a map the factory holds, keyed by db name, so two IndexeddbBlobBackend instances
 * sharing one factory + db name observe the same bytes and `servable:` markers across a
 * reopen. Covers exactly the surface the backend drives (getKey/get/getAllKeys/put/delete/
 * openCursor, in-line keyPath + out-of-line stores) with chained-request transactions whose
 * `oncomplete` fires only after every request settles.
 */
function memoryIdbFactory(): IDBFactory {
  interface Store {
    keyPath: string | null;
    data: Map<IDBValidKey, unknown>;
  }
  interface Db {
    version: number;
    stores: Map<string, Store>;
  }
  interface Req {
    result: unknown;
    error: unknown;
    onsuccess: (() => void) | null;
    onerror: (() => void) | null;
  }
  const disk = new Map<string, Db>();

  function makeTransaction(db: Db) {
    let pending = 0;
    let settled = false;
    let aborted = false;

    function maybeComplete(): void {
      if (settled || aborted || pending !== 0) return;
      settled = true;
      queueMicrotask(() => {
        if (!aborted) tx.oncomplete?.();
      });
    }

    function schedule(run: (req: Req) => void): Req {
      const req: Req = { result: undefined, error: null, onsuccess: null, onerror: null };
      pending++;
      queueMicrotask(() => {
        if (aborted) {
          pending--;
          return;
        }
        try {
          run(req);
          req.onsuccess?.(); // handler may enqueue further requests (pending++) before we decrement
        } catch (e) {
          req.error = e;
          tx.error = e;
          req.onerror?.();
        }
        pending--;
        maybeComplete();
      });
      return req;
    }

    function makeStore(store: Store) {
      const keyFor = (value: unknown, explicit?: IDBValidKey): IDBValidKey =>
        store.keyPath ? (value as Record<string, IDBValidKey>)[store.keyPath]! : (explicit as IDBValidKey);
      return {
        get: (key: IDBValidKey) => schedule((r) => (r.result = store.data.get(key))),
        getKey: (key: IDBValidKey) => schedule((r) => (r.result = store.data.has(key) ? key : undefined)),
        getAllKeys: () => schedule((r) => (r.result = [...store.data.keys()])),
        put: (value: unknown, key?: IDBValidKey) =>
          schedule((r) => {
            const k = keyFor(value, key);
            store.data.set(k, value);
            r.result = k;
          }),
        delete: (key: IDBValidKey) => schedule((r) => void store.data.delete(key)),
        openCursor: () => {
          const entries = [...store.data.entries()];
          let idx = 0;
          const req: Req = { result: null, error: null, onsuccess: null, onerror: null };
          const step = (): void => {
            pending++;
            queueMicrotask(() => {
              if (aborted) {
                pending--;
                return;
              }
              if (idx < entries.length) {
                const [key, value] = entries[idx++]!;
                req.result = { value, update: (v: unknown) => store.data.set(key, v), continue: () => step() };
              } else {
                req.result = null;
              }
              req.onsuccess?.();
              pending--;
              maybeComplete();
            });
          };
          step();
          return req;
        },
      };
    }

    const tx = {
      error: null as unknown,
      oncomplete: null as (() => void) | null,
      onabort: null as (() => void) | null,
      onerror: null as (() => void) | null,
      abort(): void {
        if (settled) return;
        aborted = true;
        settled = true;
        queueMicrotask(() => tx.onabort?.());
      },
      objectStore(name: string) {
        const store = db.stores.get(name);
        if (!store) throw new Error(`no object store ${name}`);
        return makeStore(store);
      },
    };
    return tx;
  }

  function makeDbHandle(db: Db) {
    return {
      objectStoreNames: { contains: (n: string) => db.stores.has(n) },
      createObjectStore: (name: string, opts?: { keyPath?: string }) => {
        db.stores.set(name, { keyPath: opts?.keyPath ?? null, data: new Map() });
        return {};
      },
      transaction: (_names: string | string[], _mode?: string) => makeTransaction(db),
    };
  }

  return {
    open(name: string, version?: number) {
      const req = {
        result: null as unknown,
        error: null as unknown,
        transaction: null as unknown,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
      };
      queueMicrotask(() => {
        let db = disk.get(name);
        const needsUpgrade = !db || (version !== undefined && version > db.version);
        if (!db) {
          db = { version: version ?? 1, stores: new Map() };
          disk.set(name, db);
        }
        req.result = makeDbHandle(db);
        if (needsUpgrade) {
          db.version = version ?? db.version;
          const vtx = makeTransaction(db);
          req.transaction = vtx;
          vtx.oncomplete = () => req.onsuccess?.();
          req.onupgradeneeded?.(); // creates the stores + issues the seed cursor/meta writes in vtx
        } else {
          req.onsuccess?.();
        }
      });
      return req;
    },
  } as unknown as IDBFactory;
}

describe("IndexeddbBlobBackend — durable servable markers across reopen (fake IDB)", () => {
  it("a marker (and its bytes) SURVIVE reopening the same DB", async () => {
    const factory = memoryIdbFactory();
    const dbName = blobDbName("reload");
    const s1 = new PersistentBlobStore(new IndexeddbBlobBackend(dbName, factory));
    const asset = await s1.put(PNG);
    await s1.markServable(asset.hash);
    expect(await s1.isServable(asset.hash)).toBe(true);

    // Reopen: a FRESH backend instance over the SAME factory + db name (a "reload").
    const s2 = new PersistentBlobStore(new IndexeddbBlobBackend(dbName, factory));
    expect(await s2.isServable(asset.hash)).toBe(true); // marker read from the durable meta store
    expect(await s2.has(asset.hash)).toBe(true); // bytes persisted too
  });

  it("delete drops the marker in the SAME [blobs,meta] tx and keeps the byte total correct", async () => {
    const store = new PersistentBlobStore(new IndexeddbBlobBackend(blobDbName("del"), memoryIdbFactory()));
    const asset = await store.put(PNG);
    await store.markServable(asset.hash);
    expect(await store.isServable(asset.hash)).toBe(true);
    expect(await store.totalBytes()).toBe(PNG.byteLength);
    await store.delete(asset.hash);
    expect(await store.isServable(asset.hash)).toBe(false); // cleared atomically with the bytes
    expect(await store.has(asset.hash)).toBe(false);
    expect(await store.totalBytes()).toBe(0);
  });

  it("put() stays NEUTRAL on the persistent path (no auto-grant)", async () => {
    const store = new PersistentBlobStore(new IndexeddbBlobBackend(blobDbName("neutral"), memoryIdbFactory()));
    const asset = await store.put(PNG);
    expect(await store.isServable(asset.hash)).toBe(false);
    await store.markServable(asset.hash);
    expect(await store.isServable(asset.hash)).toBe(true);
  });
});
