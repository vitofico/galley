/**
 * Roadmap #23.2 — doc-scale performance REGRESSION TRIPWIRE (not a microbenchmark).
 *
 * Galley is local-first: a project's CRDT update log grows as the user edits, and
 * `compactUpdates` (ADR-0018) collapses that log back to a single snapshot. This
 * file pins the doc-scale PROPERTIES that make that work — so a future change that
 * silently breaks compaction (e.g. a snapshot that no longer beats the raw log, or
 * an operation that goes super-linear) trips a red test instead of shipping.
 *
 * WHY NO WALL-CLOCK BUDGETS: CI machine speed varies wildly, so absolute-time
 * assertions FLAKE. Every assertion here is over a DETERMINISTIC, BOUNDED scenario
 * and checks a STRUCTURAL property — byte size, count, ratio, or round-trip
 * equality — with a GENEROUS relative bound. None of them time anything.
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { CollabDocument } from "./collab-document.js";
import { CollabProject } from "./collab-project.js";
import {
  snapshotDoc,
  restoreDoc,
  compactUpdates,
  shouldCompact,
  compactLogIfNeeded,
  COMPACTION_MAX_LOG_ENTRIES,
} from "./crdt-snapshot.js";

const human = { kind: "human" as const, userId: "u1" };

/** Sum of a log's raw byte lengths (what an un-compacted append-only log costs). */
function totalBytes(log: Uint8Array[]): number {
  return log.reduce((n, u) => n + u.byteLength, 0);
}

/**
 * Build a single-doc edit LOG of `n` sequential small appends, capturing each
 * Yjs update frame (exactly what a persisted append-only log would accumulate).
 * Deterministic: same text every run, no randomness, no timers.
 */
function buildEditLog(n: number): { log: Uint8Array[]; finalText: string } {
  const d = new CollabDocument("");
  const log: Uint8Array[] = [];
  d.doc.on("update", (u: Uint8Array) => log.push(u));
  for (let i = 0; i < n; i++) {
    // A fixed 5-char token per edit — small ops are the common case (keystrokes /
    // short inserts) and the case where per-op framing overhead dominates a log.
    d.transact((t) => t.insert(t.length, "edit_"), human);
  }
  const finalText = d.getSource();
  d.destroy();
  return { log, finalText };
}

describe("#23.2 doc-scale perf tripwire — compaction ratio", () => {
  // BUDGET: after 2000 small edits, the compacted snapshot must be MEANINGFULLY
  // smaller than the raw append-only log. RATIONALE: the raw log keeps every op
  // frame (each insert is its own update with full framing); the snapshot keeps
  // only the reachable converged state. MEASURED on this Yjs version: raw log
  // ≈ 44 KB, snapshot ≈ 10 KB → ratio ≈ 4.4×. (The snapshot isn't a single
  // contiguous run because 2000 *separate* transactions leave block boundaries, so
  // it retains some per-block structure — still a large constant-factor win.) We
  // assert K=3, a conservative floor comfortably below the measured 4.4×, so the
  // test pins the *value* of compaction without flaking if Yjs framing constants
  // drift slightly between versions.
  const N = 2000;
  const K = 3;

  it(`compacts ${N} small edits to <1/${K} of the raw log AND round-trips byte-identical`, () => {
    const { log, finalText } = buildEditLog(N);
    expect(log.length).toBe(N);

    const raw = totalBytes(log);
    const snapshot = compactUpdates(log);

    // (a) Compaction ratio: the snapshot is at least K× smaller than the raw log.
    expect(snapshot.byteLength).toBeLessThan(raw / K);

    // (b) No data loss: restoring the snapshot reproduces the exact converged text.
    const rebuilt = new CollabDocument("", restoreDoc(snapshot));
    expect(rebuilt.getSource()).toBe(finalText);
    expect(rebuilt.getSource().length).toBe(N * "edit_".length);

    // (c) Byte-identical doc state: the snapshot encodes the SAME state as
    //     replaying the whole log (compaction is state-preserving, not lossy).
    const fromLog = restoreDoc(log);
    expect(Y.encodeStateAsUpdate(restoreDoc(snapshot))).toEqual(
      Y.encodeStateAsUpdate(fromLog),
    );
  });
});

describe("#23.2 doc-scale perf tripwire — no super-linear blowup", () => {
  // BUDGET: doubling the number of edits must NOT more-than-double the compacted
  // snapshot size beyond a generous linear factor. RATIONALE: contiguous appends
  // converge to a near-linear-in-text snapshot; a regression that made the CRDT
  // retain per-op structure would push this ratio up super-linearly. We allow ≤3×
  // for a 2× input (vs the ideal ~2×) so normal CRDT bookkeeping overhead and
  // block-split boundaries can't flake it — but 4×/quadratic growth would trip.
  it("snapshot size grows roughly linearly (≤3x for 2x edits)", () => {
    const small = compactUpdates(buildEditLog(1000).log);
    const large = compactUpdates(buildEditLog(2000).log);

    // Larger input genuinely produces a larger snapshot (no degenerate constant).
    expect(large.byteLength).toBeGreaterThan(small.byteLength);
    // ...but not super-linearly: 2x the edits ≤ 3x the snapshot bytes.
    expect(large.byteLength).toBeLessThan(small.byteLength * 3);
  });

  it("the raw (un-compacted) log itself grows only linearly (≤2.5x for 2x edits)", () => {
    // Pins that capturing the log is itself linear — a regression that made each
    // op frame grow with history (O(n^2) total) would trip here, motivating the
    // compaction policy below.
    const small = totalBytes(buildEditLog(1000).log);
    const large = totalBytes(buildEditLog(2000).log);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThan(small * 2.5);
  });
});

/** Build a CollabProject of `files` files, each seeded with `perFileText`. */
function buildProject(files: number, perFileText: string): CollabProject {
  let n = 0;
  const project = new CollabProject(new Y.Doc(), { newId: () => `f${n++}` });
  for (let i = 0; i < files; i++) {
    project.create(`/file-${i}.typ`, perFileText, human);
  }
  return project;
}

describe("#23.2 doc-scale perf tripwire — CollabProject at scale", () => {
  // BUDGET: a many-file project snapshots + restores correctly, and its snapshot
  // size scales ~linearly with file count. RATIONALE: all files share one Y.Doc;
  // we assert (a) round-trip correctness at scale and (b) doubling the file count
  // stays within a generous linear bound (≤3x), so a structural regression in the
  // multi-file doc layout surfaces here.
  const PER_FILE = "= Heading\n\nSome representative paragraph body text.\n";

  it("snapshots + restores a 200-file project byte-identically", () => {
    const project = buildProject(200, PER_FILE);
    const snap = snapshotDoc(project.doc);

    const restored = new CollabProject(restoreDoc(snap));
    const a = project.snapshot();
    const b = restored.snapshot();

    expect(b.files.length).toBe(a.files.length);
    expect(b.files.map((f) => f.path)).toEqual(a.files.map((f) => f.path));
    expect(b.mainFileId).toBe(a.mainFileId);
    // Content survives for every file (no truncation / loss at scale).
    expect(b.files.map((f) => f.text)).toEqual(a.files.map((f) => f.text));

    // Bounded size: the snapshot is on the order of the raw content, not blown up.
    // Generous 4x ceiling over the bare concatenated file text (CRDT metadata +
    // path maps + ids add real overhead, but it must stay a small constant factor).
    const rawContent = 200 * (PER_FILE.length + "/file-000.typ".length);
    expect(snap.byteLength).toBeLessThan(rawContent * 4);

    project.destroy();
  });

  it("project snapshot size scales ~linearly with file count (≤3x for 2x files)", () => {
    const small = buildProject(100, PER_FILE);
    const large = buildProject(200, PER_FILE);
    const sSmall = snapshotDoc(small.doc).byteLength;
    const sLarge = snapshotDoc(large.doc).byteLength;
    small.destroy();
    large.destroy();

    expect(sLarge).toBeGreaterThan(sSmall);
    expect(sLarge).toBeLessThan(sSmall * 3);
  });

  it("a large-text single file round-trips intact", () => {
    // One file with a large body — exercises the Y.Text large-string path.
    const big = "lorem ipsum dolor ".repeat(5000); // ~90 KB
    const project = buildProject(0, "");
    const id = project.create("/big.typ", big, human);
    const snap = snapshotDoc(project.doc);

    const restored = new CollabProject(restoreDoc(snap));
    expect(restored.getFile(id)?.text).toBe(big);
    project.destroy();
  });
});

describe("#23.2 compaction policy — shouldCompact / compactLogIfNeeded", () => {
  // These pin the POLICY contract: it triggers at the threshold, the compacted
  // result is byte-identical (no data loss), and below threshold nothing changes.

  it("does NOT trigger below the entry threshold", () => {
    const { log } = buildEditLog(COMPACTION_MAX_LOG_ENTRIES); // == max, not over
    expect(shouldCompact(log)).toBe(false);
  });

  it("triggers once the entry count exceeds the threshold", () => {
    const { log } = buildEditLog(COMPACTION_MAX_LOG_ENTRIES + 1);
    expect(shouldCompact(log)).toBe(true);
  });

  it("triggers on the byte threshold even with few entries", () => {
    // A single large op (e.g. a paste/import) trips the byte budget before count.
    const d = new CollabDocument("");
    const log: Uint8Array[] = [];
    d.doc.on("update", (u: Uint8Array) => log.push(u));
    d.transact((t) => t.insert(0, "x".repeat(2 * (1 << 20))), human); // 2 MiB paste
    expect(log.length).toBeLessThanOrEqual(2);
    expect(shouldCompact(log)).toBe(true);
    d.destroy();
  });

  it("respects custom limits", () => {
    const { log } = buildEditLog(10);
    expect(shouldCompact(log, { maxEntries: 5 })).toBe(true);
    expect(shouldCompact(log, { maxEntries: 100 })).toBe(false);
  });

  it("compactLogIfNeeded collapses a long log to ONE snapshot with no data loss", () => {
    const { log, finalText } = buildEditLog(COMPACTION_MAX_LOG_ENTRIES + 50);

    const compacted = compactLogIfNeeded(log);
    expect(compacted.length).toBe(1); // collapsed to a single snapshot entry
    expect(compacted).not.toBe(log); // a NEW array (caller swaps its accumulator)

    // No data loss: the compacted log restores to the exact converged state.
    const rebuilt = new CollabDocument("", restoreDoc(compacted));
    expect(rebuilt.getSource()).toBe(finalText);
    // Byte-identical doc state vs replaying the full original log.
    expect(Y.encodeStateAsUpdate(restoreDoc(compacted))).toEqual(
      Y.encodeStateAsUpdate(restoreDoc(log)),
    );
  });

  it("compactLogIfNeeded is a NO-OP below threshold (same array, unchanged behavior)", () => {
    const { log } = buildEditLog(10);
    const result = compactLogIfNeeded(log);
    expect(result).toBe(log); // SAME reference — nothing touched
    expect(result.length).toBe(10);
  });

  it("compacting a log that mixes inserts and deletes still round-trips exactly", () => {
    const d = new CollabDocument("");
    const log: Uint8Array[] = [];
    d.doc.on("update", (u: Uint8Array) => log.push(u));
    for (let i = 0; i < COMPACTION_MAX_LOG_ENTRIES + 20; i++) {
      d.transact((t) => {
        t.insert(t.length, "abcde");
        if (t.length > 10) t.delete(0, 2); // churn: tombstones accumulate
      }, human);
    }
    const expected = d.getSource();

    const compacted = compactLogIfNeeded(log);
    expect(compacted.length).toBe(1);
    expect(new CollabDocument("", restoreDoc(compacted)).getSource()).toBe(expected);
    d.destroy();
  });
});
