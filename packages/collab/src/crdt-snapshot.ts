/**
 * Roadmap #4 — the CRDT snapshot / compaction / restore core (ADR-0018 §2).
 *
 * A `CrdtStore` persists a project's Yjs state as an append-only **update log**
 * plus periodic **snapshots** (so the log doesn't grow unbounded); loading a doc
 * replays a snapshot + the tail. These are the pure, offline Yjs primitives
 * behind that — no store, no IO, framework-free. Because the CRDT is the source
 * of truth (ADR-0018 §1), `restoreDoc` is also how an import/restore rehydrates
 * state losslessly into a live doc.
 */
import * as Y from "yjs";

/** Encode a doc's entire current state as a single update ("snapshot"). */
export function snapshotDoc(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

/**
 * Apply one update or a sequence of updates (a snapshot, or snapshot + tail) into
 * a doc — a fresh empty `Y.Doc` by default — and return it. Yjs updates are
 * commutative/idempotent, so order doesn't affect the converged state.
 */
export function restoreDoc(updates: Uint8Array | Uint8Array[], into: Y.Doc = new Y.Doc()): Y.Doc {
  const list = Array.isArray(updates) ? updates : [updates];
  for (const u of list) Y.applyUpdate(into, u);
  return into;
}

/**
 * Compact an update log into a single snapshot. Implemented by replaying into a
 * throwaway doc and re-encoding its state — unambiguously correct and order-
 * independent (vs `Y.mergeUpdates`, a lower-level optimization we don't need yet).
 * The compacted snapshot keeps only reachable state (incl. tombstones), so it's
 * typically far smaller than the raw op-by-op log. An empty log yields a valid
 * empty-state update (restores to an empty doc, never throws).
 */
export function compactUpdates(updates: Uint8Array[]): Uint8Array {
  const doc = new Y.Doc();
  try {
    for (const u of updates) Y.applyUpdate(doc, u);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * Roadmap #23.2 — the compaction POLICY thresholds (the WHEN, separate from the
 * WHAT, which is `compactUpdates`). An accumulating `Uint8Array[]` update log
 * (e.g. a snapshot-store accumulator that isn't backed by `y-indexeddb`'s own
 * trim) should be compacted down to a single snapshot once it gets long or large.
 *
 * Two independent triggers — whichever trips first:
 *   - COUNT: many small ops dominate a long editing session; each op carries
 *     framing overhead, so a high op COUNT is the usual reason a log bloats well
 *     before its bytes do.
 *   - BYTES: a few large ops (e.g. a paste / file import) can blow the byte
 *     budget without hitting the count, so we also cap total accumulated bytes.
 *
 * The constants are deliberately generous: compaction replays the whole log into
 * a throwaway doc (O(total bytes)), so triggering too eagerly wastes work. These
 * values keep an accumulator from growing without bound while compacting rarely.
 */
export const COMPACTION_MAX_LOG_ENTRIES = 512;
export const COMPACTION_MAX_LOG_BYTES = 1 << 20; // 1 MiB of accumulated raw updates.

/**
 * Pure predicate: should this accumulated update log be compacted to a snapshot?
 * True once EITHER the entry count or the total byte size crosses its threshold.
 * No IO, no mutation — a tripwire a caller checks before deciding to compact.
 * Below both thresholds it returns false (caller leaves the log untouched).
 */
export function shouldCompact(
  log: Uint8Array[],
  limits: { maxEntries?: number; maxBytes?: number } = {},
): boolean {
  const maxEntries = limits.maxEntries ?? COMPACTION_MAX_LOG_ENTRIES;
  const maxBytes = limits.maxBytes ?? COMPACTION_MAX_LOG_BYTES;
  if (log.length > maxEntries) return true;
  let bytes = 0;
  for (const u of log) {
    bytes += u.byteLength;
    if (bytes > maxBytes) return true;
  }
  return false;
}

/**
 * Apply the compaction policy to an accumulated log: if it has grown past a
 * threshold (`shouldCompact`), replace it with a single equivalent snapshot;
 * otherwise return it unchanged. The result is ALWAYS a `Uint8Array[]` that
 * `restoreDoc` rebuilds to byte-identical converged state — compaction never
 * loses data (it keeps all reachable state incl. tombstones). Returns a NEW array
 * when compacted (the caller swaps its accumulator); returns the SAME array
 * reference when below threshold (no behavior change). Additive + default-safe:
 * nothing calls this until a caller opts in.
 */
export function compactLogIfNeeded(
  log: Uint8Array[],
  limits: { maxEntries?: number; maxBytes?: number } = {},
): Uint8Array[] {
  if (!shouldCompact(log, limits)) return log;
  return [compactUpdates(log)];
}
