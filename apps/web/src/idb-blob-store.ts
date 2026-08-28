/**
 * Persistent binary blob storage (#7 slice 7C-2; wave-13 GC/quota).
 *
 * Holds the BYTES of content-addressed binary files (images, …) in a DEDICATED
 * per-project IndexedDB database — NOT inside y-indexeddb's update-log DB (keeping
 * the CRDT store pure, per the Architect review). The CRDT carries only the
 * `BinaryAsset` pointer; this resolves a pointer's `hash` back to its bytes.
 *
 * `PersistentBlobStore` is the {@link BlobStore} (put/get/has) over a binary-safe
 * `BlobBackend`. Reads VERIFY the sha256 (fail-closed on corruption/tamper) so a
 * mismatched blob is never handed to the compiler. The backend is injectable:
 * `InMemoryBlobBackend` for the unit gate, `IndexeddbBlobBackend` in the browser.
 *
 * GC/quota (wave-13). Each backend enforces a per-project byte CAP: a `put` that
 * would push the total past the cap is REFUSED with a typed {@link
 * BlobQuotaExceededError} — the cap is the ONLY backpressure (GC never evicts a
 * referenced blob). The check (dedupe → total → insert) is ATOMIC within one
 * IndexedDB transaction so concurrent puts can never race past the cap. `keys()` +
 * `totalBytes()` expose the store for the orphan sweep (see blob-gc.ts).
 */

import {
  sha256Hex,
  inferMime,
  type BinaryAsset,
  type BlobStore,
} from "@galley/collab";

/** Default per-project blob byte cap (generous — a paper's images, not a media library). */
export const DEFAULT_BLOB_QUOTA_BYTES = 512 * 1024 * 1024;

/**
 * A `put` was refused because it would push the project's blob store past its byte
 * cap. Typed + honest (carries the attempted size, the cap, and the current total)
 * so a caller can surface a real "storage full" message rather than a silent drop.
 * The quota is the store's ONLY backpressure — GC reclaims orphans but NEVER evicts
 * a referenced blob, so a genuinely-full store of referenced bytes must refuse.
 */
export class BlobQuotaExceededError extends Error {
  constructor(
    readonly attemptedBytes: number,
    readonly capBytes: number,
    readonly currentBytes: number,
  ) {
    super(
      `Blob store is full: adding ${attemptedBytes} B would exceed the ${capBytes} B cap (currently ${currentBytes} B).`,
    );
    this.name = "BlobQuotaExceededError";
  }
}

/**
 * A binary-safe key→bytes store (keyed by content hash). Distinct from the
 * project registry's JSON `KeyValueBackend`, whose in-memory clone is JSON-based
 * and would corrupt a `Uint8Array`. Structured clone (IndexedDB) preserves bytes.
 */
export interface BlobBackend {
  has(hash: string): Promise<boolean>;
  get(hash: string): Promise<Uint8Array | undefined>;
  /**
   * Store bytes under `hash`. IDEMPOTENT: a present hash is left as-is (dedupe).
   * ATOMIC quota: for a NEW hash, refuses with {@link BlobQuotaExceededError} if
   * the resulting total would exceed the backend's byte cap — the dedupe check,
   * total-size check, and insert all happen in ONE transaction so concurrent puts
   * cannot collectively exceed the cap.
   */
  put(hash: string, bytes: Uint8Array): Promise<void>;
  /**
   * Remove the bytes stored under `hash` (A2/C1 orphan cleanup + GC sweep).
   * Idempotent — a missing hash is a no-op. ONLY safe to call for a hash with NO
   * live-or-tombstoned CRDT pointer; a referenced hash must never be deleted.
   */
  delete(hash: string): Promise<void>;
  /** Every stored content hash (for the orphan sweep — see blob-gc.ts). */
  keys(): Promise<string[]>;
  /** Total stored bytes (for quota accounting + introspection). */
  totalBytes(): Promise<number>;
  /**
   * Set the durable `servable:<hash>` marker (meta store). Idempotent; independent of
   * whether bytes exist. Low-level: the {@link PersistentBlobStore} validates the hash
   * shape before delegating here. NEVER called from {@link put} — grants are explicit.
   */
  markServable(hash: string): Promise<void>;
  /** Whether the `servable:<hash>` marker is set (byte presence is a separate concern). */
  isServable(hash: string): Promise<boolean>;
}

/** In-memory backend for the unit gate (no IndexedDB); copies on the edges. */
export class InMemoryBlobBackend implements BlobBackend {
  private readonly map = new Map<string, Uint8Array>();
  /** Servable-provenance markers (mirrors the persistent `servable:` meta keys). */
  private readonly servable = new Set<string>();
  /** Running total, kept O(1) and updated in lockstep with the map. */
  private total = 0;

  constructor(private readonly maxBytes: number = DEFAULT_BLOB_QUOTA_BYTES) {}

  async has(hash: string): Promise<boolean> {
    return this.map.has(hash);
  }
  async get(hash: string): Promise<Uint8Array | undefined> {
    const v = this.map.get(hash);
    return v ? v.slice() : undefined;
  }
  async put(hash: string, bytes: Uint8Array): Promise<void> {
    // ATOMICITY: the dedupe check, the cap check, and the insert run with NO
    // intervening `await`, so two concurrently-issued puts cannot both pass the cap
    // check and then both insert — the second observes the first's updated total.
    if (this.map.has(hash)) return; // dedupe: never rewrite existing content
    const size = bytes.byteLength;
    if (this.total + size > this.maxBytes) {
      throw new BlobQuotaExceededError(size, this.maxBytes, this.total);
    }
    this.map.set(hash, bytes.slice());
    this.total += size;
  }
  async delete(hash: string): Promise<void> {
    // Drop the servable marker in lockstep with the bytes — a marker must never
    // outlive its bytes (GC of an orphan clears it too). Independent of byte presence.
    this.servable.delete(hash);
    const v = this.map.get(hash);
    if (v === undefined) return;
    this.map.delete(hash);
    this.total -= v.byteLength;
  }
  async keys(): Promise<string[]> {
    return [...this.map.keys()];
  }
  async totalBytes(): Promise<number> {
    return this.total;
  }
  async markServable(hash: string): Promise<void> {
    this.servable.add(hash);
  }
  async isServable(hash: string): Promise<boolean> {
    return this.servable.has(hash);
  }
}

const BLOB_STORE = "blobs";
/** Aggregate store holding the O(1) running byte total (keyed out-of-line). */
const META_STORE = "meta";
const TOTAL_KEY = "totalBytes";
/**
 * Per-hash servable-provenance marker key in the `meta` store: `servable:<64-hex>` → 1.
 * A marker means "this device locally provenanced these bytes for room sharing" — set
 * ONLY by a trusted-local-action grant (never by inbound `put`), dropped atomically with
 * the bytes on `delete`. Reuses the EXISTING `meta` store (no schema-version bump).
 */
const SERVABLE_PREFIX = "servable:";
const servableKey = (hash: string): string => `${SERVABLE_PREFIX}${hash}`;
/** A sha256 in the shape `markServable` will grant: lowercase 64-hex (sha256Hex output). */
const SERVABLE_HASH = /^[0-9a-f]{64}$/;
/** Schema v2 adds `size` to each row + the `meta` total-bytes counter (v1 had neither). */
const SCHEMA_VERSION = 2;

/** Per-project blob DB name. Separate DB so it never touches the y-indexeddb log. */
export function blobDbName(projectId: string): string {
  return `galley.blobs.${projectId}`;
}

/** A stored blob row (keyed by `hash`; structured clone preserves the bytes). */
interface BlobRow {
  hash: string;
  bytes: Uint8Array;
  /** Byte length (schema v2). v1 rows lacked it; the upgrade backfills from `bytes`. */
  size: number;
}

/**
 * IndexedDB blob backend (browser). Hand-rolled promise wrapper over the global
 * `indexedDB` (no `idb` dep), mirroring IndexeddbKeyValueBackend. Two object
 * stores: `blobs` (keyed by `hash`) and `meta` (the O(1) byte total). Factory +
 * cap injectable for a browser test; both default sensibly.
 */
export class IndexeddbBlobBackend implements BlobBackend {
  private dbPromise: Promise<IDBDatabase> | undefined;
  private readonly maxBytes: number;

  constructor(
    private readonly dbName: string,
    private readonly factory: IDBFactory = globalThis.indexedDB,
    opts: { maxBytes?: number } = {},
  ) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_BLOB_QUOTA_BYTES;
  }

  private open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      const p = new Promise<IDBDatabase>((resolve, reject) => {
        const req = this.factory.open(this.dbName, SCHEMA_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          const tx = req.transaction!; // the versionchange transaction
          if (!db.objectStoreNames.contains(BLOB_STORE)) {
            db.createObjectStore(BLOB_STORE, { keyPath: "hash" });
          }
          if (!db.objectStoreNames.contains(META_STORE)) {
            db.createObjectStore(META_STORE);
          }
          // Backfill `size` on any pre-v2 rows and (re)seed the byte total. Runs
          // for a v1→v2 upgrade (rows lack `size`, no meta) and is a harmless no-op
          // on a fresh create (the cursor immediately yields null → total 0).
          const blobs = tx.objectStore(BLOB_STORE);
          const meta = tx.objectStore(META_STORE);
          let total = 0;
          const cursorReq = blobs.openCursor();
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor) {
              const row = cursor.value as Partial<BlobRow> & { bytes: Uint8Array };
              const size = typeof row.size === "number" ? row.size : (row.bytes?.byteLength ?? 0);
              total += size;
              if (row.size !== size) cursor.update({ ...row, size } as BlobRow);
              cursor.continue();
            } else {
              meta.put(total, TOTAL_KEY);
            }
          };
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("blob db open failed"));
      });
      // A transient open failure must not poison the cache forever: drop the
      // rejected promise so the next call retries instead of awaiting the same
      // rejection for the rest of the session.
      this.dbPromise = p;
      void p.catch(() => {
        if (this.dbPromise === p) this.dbPromise = undefined;
      });
    }
    return this.dbPromise;
  }

  private async tx<T>(
    mode: IDBTransactionMode,
    body: (s: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const req = body(db.transaction(BLOB_STORE, mode).objectStore(BLOB_STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("blob request failed"));
    });
  }

  async has(hash: string): Promise<boolean> {
    const key = await this.tx<IDBValidKey | undefined>("readonly", (s) => s.getKey(hash));
    return key !== undefined;
  }

  async get(hash: string): Promise<Uint8Array | undefined> {
    const row = await this.tx<BlobRow | undefined>("readonly", (s) => s.get(hash));
    return row?.bytes;
  }

  async put(hash: string, bytes: Uint8Array): Promise<void> {
    const db = await this.open();
    const size = bytes.byteLength;
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction([BLOB_STORE, META_STORE], "readwrite");
      const blobs = tx.objectStore(BLOB_STORE);
      const meta = tx.objectStore(META_STORE);
      let quotaError: BlobQuotaExceededError | undefined;
      // Dedupe → total → insert, all in ONE transaction (atomic against concurrent
      // puts): a NEW hash is admitted only if it keeps the total within the cap.
      const existReq = blobs.getKey(hash);
      existReq.onsuccess = () => {
        if (existReq.result !== undefined) return; // dedupe: present, no-op (commit)
        const totalReq = meta.get(TOTAL_KEY);
        totalReq.onsuccess = () => {
          const current = typeof totalReq.result === "number" ? totalReq.result : 0;
          if (current + size > this.maxBytes) {
            quotaError = new BlobQuotaExceededError(size, this.maxBytes, current);
            try {
              tx.abort();
            } catch {
              /* aborting an already-finishing tx is fine */
            }
            return;
          }
          blobs.put({ hash, bytes, size } satisfies BlobRow);
          meta.put(current + size, TOTAL_KEY);
        };
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(quotaError ?? tx.error ?? new Error("blob put aborted"));
      tx.onerror = () => reject(tx.error ?? new Error("blob put failed"));
    });
  }

  async delete(hash: string): Promise<void> {
    const db = await this.open();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction([BLOB_STORE, META_STORE], "readwrite");
      const blobs = tx.objectStore(BLOB_STORE);
      const meta = tx.objectStore(META_STORE);
      // Drop the servable marker in the SAME tx, UNCONDITIONALLY: a marker must never
      // outlive its bytes and never protect an orphan from GC. Idempotent (delete of a
      // missing meta key is a no-op) and independent of whether the bytes are present,
      // so it clears even the edge case of a marker set for not-yet-stored bytes.
      meta.delete(servableKey(hash));
      const getReq = blobs.get(hash);
      getReq.onsuccess = () => {
        const row = getReq.result as BlobRow | undefined;
        if (row === undefined) return; // idempotent: no bytes to remove (marker already dropped)
        const size = typeof row.size === "number" ? row.size : (row.bytes?.byteLength ?? 0);
        blobs.delete(hash);
        const totalReq = meta.get(TOTAL_KEY);
        totalReq.onsuccess = () => {
          const current = typeof totalReq.result === "number" ? totalReq.result : 0;
          meta.put(Math.max(0, current - size), TOTAL_KEY);
        };
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("blob delete aborted"));
      tx.onerror = () => reject(tx.error ?? new Error("blob delete failed"));
    });
  }

  async keys(): Promise<string[]> {
    const all = await this.tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys());
    return all.map((k) => String(k));
  }

  async totalBytes(): Promise<number> {
    const db = await this.open();
    return new Promise<number>((resolve, reject) => {
      const req = db.transaction(META_STORE, "readonly").objectStore(META_STORE).get(TOTAL_KEY);
      req.onsuccess = () => resolve(typeof req.result === "number" ? req.result : 0);
      req.onerror = () => reject(req.error ?? new Error("blob totalBytes failed"));
    });
  }

  async markServable(hash: string): Promise<void> {
    const db = await this.open();
    return new Promise<void>((resolve, reject) => {
      // A single durable write to the EXISTING meta store (`servable:<hash>` → 1).
      // Idempotent: re-marking overwrites the same value. Resolve on commit.
      const tx = db.transaction(META_STORE, "readwrite");
      tx.objectStore(META_STORE).put(1, servableKey(hash));
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("blob markServable aborted"));
      tx.onerror = () => reject(tx.error ?? new Error("blob markServable failed"));
    });
  }

  async isServable(hash: string): Promise<boolean> {
    const db = await this.open();
    return new Promise<boolean>((resolve, reject) => {
      const req = db.transaction(META_STORE, "readonly").objectStore(META_STORE).get(servableKey(hash));
      req.onsuccess = () => resolve(req.result === 1);
      req.onerror = () => reject(req.error ?? new Error("blob isServable failed"));
    });
  }
}

/**
 * A content-addressed {@link BlobStore} over a {@link BlobBackend}. `put` hashes
 * the bytes (dedup), `get` VERIFIES the sha256 before returning (a corrupt/tampered
 * blob fails closed to undefined — never mapped into the compiler). It also exposes
 * `keys`/`totalBytes` (delegating to the backend) so the GC sweep can enumerate it,
 * and re-throws the backend's typed {@link BlobQuotaExceededError} on a full store.
 */
export class PersistentBlobStore implements BlobStore {
  constructor(private readonly backend: BlobBackend) {}

  async put(bytes: Uint8Array, opts?: { filename?: string; mime?: string }): Promise<BinaryAsset> {
    const hash = await sha256Hex(bytes);
    // Delegate dedupe + the atomic quota check to the backend (one transaction).
    // A full store throws BlobQuotaExceededError, which propagates to the caller.
    await this.backend.put(hash, bytes);
    const mime = opts?.mime ?? inferMime(bytes, opts?.filename);
    return { type: "binary", hash, size: bytes.byteLength, mime };
  }

  async get(hash: string): Promise<Uint8Array | undefined> {
    const bytes = await this.backend.get(hash);
    if (!bytes) return undefined;
    // Verify-on-read: the bytes MUST hash to the key they were stored under.
    if ((await sha256Hex(bytes)) !== hash) return undefined;
    return bytes;
  }

  async has(hash: string): Promise<boolean> {
    return this.backend.has(hash);
  }

  /**
   * Remove the bytes for `hash` (A2/C1 orphan cleanup + the GC sweep). The CALLER
   * must guarantee NO live-OR-tombstoned CRDT pointer references `hash` — deleting
   * a referenced hash would break its file. Idempotent; never throws on a missing
   * hash. The GC sweep (blob-gc.ts) computes the protected set and calls this only
   * for true orphans.
   */
  async delete(hash: string): Promise<void> {
    await this.backend.delete(hash);
  }

  /** Every stored content hash (the GC sweep enumerates these). */
  async keys(): Promise<string[]> {
    return this.backend.keys();
  }

  /** Total stored bytes (quota accounting + introspection). */
  async totalBytes(): Promise<number> {
    return this.backend.totalBytes();
  }

  /**
   * Servable-provenance GRANT: durably mark `hash` as locally provenanced for room
   * sharing. The ONLY writer of the marker — {@link put} stays NEUTRAL so inbound
   * peer/agent bytes are never auto-granted. Validates the sha256 shape (a non-64-hex
   * hash is a no-op — a malformed grant can never plant a marker) and is idempotent +
   * independent of whether the bytes are present.
   */
  async markServable(hash: string): Promise<void> {
    if (!SERVABLE_HASH.test(hash)) return;
    await this.backend.markServable(hash);
  }

  /** True iff the `servable:<hash>` marker is set (byte presence is checked separately). */
  async isServable(hash: string): Promise<boolean> {
    return this.backend.isServable(hash);
  }
}
