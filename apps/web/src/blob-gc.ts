/**
 * Blob garbage collection (wave-13 GC/quota prerequisite).
 *
 * A stored blob is PROTECTED iff some binary-file pointer in the project snapshot
 * references its content hash — INCLUDING tombstoned (soft-deleted) pointers, whose
 * bytes are deliberately RETAINED so a delete stays restorable. This is the exact
 * set `blobHashIsReferenced` (file-proposal-accept.ts) honors. Everything else in
 * the store is an ORPHAN (an upload whose proposal never published, bytes left by a
 * since-removed pointer) and is safe to sweep.
 *
 * A sweep NEVER evicts a referenced blob under any pressure — the per-project byte
 * quota (idb-blob-store.ts) is the ONLY backpressure. GC reclaims true orphans only.
 *
 * TIMING (Architect-mandated). A sweep may run ONLY after the CRDT is hydrated: a
 * local session after `whenReady`, a CONNECTED session additionally after the first
 * `onSynced`. Sweeping a joiner's store against its EMPTY pre-sync snapshot would
 * delete every blob it holds. There is NO background/interval GC — sweep-on-ready
 * (wired in project-session.ts) plus the exported {@link sweepOrphanBlobs} call are
 * the only triggers. The `keys → protected → delete` planning is pure and unit-pinned.
 */
import type { ProjectSnapshot } from "@galley/collab";

/** The minimal store surface a sweep needs: enumerate keys + delete an orphan. */
export interface BlobSweepStore {
  keys(): Promise<string[]>;
  delete(hash: string): Promise<void>;
}

/**
 * Every content hash referenced by a binary pointer in `snapshot`, INCLUDING
 * tombstoned pointers (their bytes are retained for restore — never sweepable).
 * Pure. Mirrors the reference set `blobHashIsReferenced` enforces.
 */
export function protectedBlobHashes(snapshot: ProjectSnapshot): Set<string> {
  return new Set((snapshot.binaryFiles ?? []).map((f) => f.hash));
}

/**
 * Pure planning: which of `storedKeys` are orphans (not in `protectedHashes`) and
 * therefore sweepable. Input order is preserved; never returns a protected hash.
 */
export function planBlobSweep(
  storedKeys: readonly string[],
  protectedHashes: ReadonlySet<string>,
): string[] {
  return storedKeys.filter((h) => !protectedHashes.has(h));
}

/**
 * Sweep orphan blobs from `store`: delete every stored key NOT protected by the
 * snapshot from `getSnapshot()`. Returns the hashes actually deleted. The CALLER
 * guarantees the CRDT is HYDRATED (see TIMING) and authoritative — for GALLEY this
 * means LOCAL/OFFLINE (solo) only (Security round #4). `getSnapshot` is a live getter,
 * NOT a captured value: the sweep re-derives protection from a FRESH snapshot right
 * before each delete, so a pointer added mid-sweep protects its blob. Best-effort per
 * key: a `delete` rejection is swallowed so one bad key never strands the rest (delete
 * is idempotent; a missed orphan is reclaimed on the next sweep).
 */
export async function sweepOrphanBlobs(
  store: BlobSweepStore,
  getSnapshot: () => ProjectSnapshot,
): Promise<{ deleted: string[] }> {
  const keys = await store.keys();
  const orphans = planBlobSweep(keys, protectedBlobHashes(getSnapshot()));
  const deleted: string[] = [];
  for (const hash of orphans) {
    // Security round #4 (TOCTOU): the sweep is async — `keys()` then per-key
    // `delete()`. A concurrent local write (e.g. an Accept committing a create-binary
    // pointer) may have referenced `hash` since we planned. Re-derive the protected
    // set from a FRESH snapshot immediately before each delete and SKIP a
    // now-referenced hash — a blob a concurrent write just referenced must never be
    // deleted (no dangling pointer). A missed orphan is reclaimed on the next sweep.
    if (protectedBlobHashes(getSnapshot()).has(hash)) continue;
    try {
      await store.delete(hash);
      deleted.push(hash);
    } catch {
      /* best-effort: a failed delete is retried on the next sweep */
    }
  }
  return { deleted };
}

/** Runtime guard: whether `store` exposes the sweep surface (keys + delete). */
export function isSweepable(store: unknown): store is BlobSweepStore {
  return (
    typeof store === "object" &&
    store !== null &&
    typeof (store as BlobSweepStore).keys === "function" &&
    typeof (store as BlobSweepStore).delete === "function"
  );
}

/**
 * Wire a HYDRATION-GATED orphan sweep: run exactly one sweep after `ready` resolves.
 * Only a LOCAL/OFFLINE (solo) session wires this (passing `whenReady`) — a CONNECTED
 * session NEVER sweeps (Security round #4): its doc is peer-writable and hydrates
 * asynchronously, so no client-side reference set is authoritative. A no-op when
 * `store` is absent or not sweepable (a plain BlobStore with no keys/delete).
 * Fail-soft: a sweep error never escapes. No interval — nothing to tear down. The
 * `getSnapshot` getter is passed through (not resolved) so the sweep re-validates
 * each delete against a fresh snapshot.
 */
export function scheduleBlobSweep(
  ready: Promise<unknown>,
  store: unknown,
  getSnapshot: () => ProjectSnapshot,
): void {
  if (!isSweepable(store)) return;
  void ready.then(() => sweepOrphanBlobs(store, getSnapshot)).catch(() => undefined);
}
