# Doc-scale performance notes

Galley is local-first: a project lives as a Yjs CRDT, and its **update log grows as
the user edits**. `compactUpdates` (ADR-0018) collapses such a log back into one
snapshot. This note records (1) the benchmark tripwire that keeps doc-scale
performance from silently regressing, (2) the compaction ratio it measures, and
(3) where growth is already bounded vs. where the `shouldCompact` policy applies.

## Benchmark tripwire

`packages/collab/src/crdt-perf.bench.test.ts` is a **regression tripwire, not a
microbenchmark**. It runs in the normal unit gate (it is a `*.test.ts`, since the
repo uses no `vitest bench`). It asserts **structural properties over deterministic,
bounded scenarios** — byte sizes, counts, ratios, and round-trip equality — never
wall-clock milliseconds (CI machine speed varies, so absolute-time budgets flake).

| Scenario | Budget assertion | Rationale (why it can't flake) |
|---|---|---|
| **Compaction ratio** — N=2000 small sequential edits | `compactUpdates(log).length < sum(log)/3` | Raw log keeps every op frame (each insert is its own framed update); the snapshot keeps only reachable converged state. Measured raw ≈ 44 KB → snapshot ≈ 10 KB (≈4.4×). K=3 is a conservative floor below the measured ratio, so framing-constant drift between Yjs versions can't trip it. |
| **Round-trip correctness** (same scenario) | `restoreDoc(snapshot)` reproduces byte-identical text **and** an equal `encodeStateAsUpdate` to replaying the whole log | Pins **no data loss**: compaction is state-preserving. |
| **No super-linear blowup** — N vs 2N edits | larger snapshot `> smaller` **and** `< smaller * 3` | Contiguous appends converge to a near-linear snapshot; ≤3× for a 2× input absorbs CRDT bookkeeping/block-split overhead but trips on quadratic growth. Pure size ratio — no timing. |
| **Raw-log linearity** — N vs 2N edits | total raw bytes `< smaller * 2.5` | Catches a regression where each op frame grows with history (O(n²) total). |
| **CollabProject at scale** — 200 files | snapshot+restore byte-identical for every file; snapshot `< rawContent * 4` | All files share one `Y.Doc`; pins multi-file correctness + bounded size at scale. |
| **Project scaling** — 100 vs 200 files | larger snapshot `> smaller` and `< smaller * 3` | Multi-file doc layout stays ~linear in file count. |
| **Large single file** — one ~90 KB body | restores intact | Exercises the `Y.Text` large-string path. |

**Measured compaction ratio:** for 2000 small edits the compacted snapshot is
**≈4.4×** smaller than the concatenated raw log (raw ≈ 44 KB → snapshot ≈ 10 KB).
The assertion floor is a conservative 3×, so the test pins the concrete value of
running compaction without flaking on Yjs framing-constant drift. (The ratio is
"only" ~4× rather than huge because 2000 separate transactions leave per-block
structure in the snapshot; a long single-transaction edit run compacts far more.)

## Compaction policy

Where an update log actually grows unbounded:

- **Live draft / project doc persistence is ALREADY bounded.**
  `apps/web/src/collab-session.ts` and `project-session.ts` persist the live
  `Y.Doc` via `y-indexeddb` (`IndexeddbPersistence`), which performs its **own
  internal trim** at `PREFERRED_TRIM_SIZE`: once enough incremental updates
  accumulate it rewrites them into a single merged record. So the hot edit path —
  the one that grows fastest — needs no extra policy; adding one would also risk
  the delicate seed-once / server-authority persistence logic. **Left untouched.**
- **The version store does NOT accumulate a CRDT update log.**
  `apps/web/src/idb-version-store.ts` stores **materialized git-shaped trees**
  (`VersionedFile[]`) per named version, not `Uint8Array[]` updates. Each version
  is independent; there is no append-only CRDT log to compact here.
- **No other in-memory or persisted `Uint8Array[]` accumulator grows unbounded.**
  Update arrays elsewhere (e.g. the transient agent-as-peer docs in
  `applyAcceptedSourceAsAgent` / `applyAcceptedFileAsAgent`) are short-lived deltas
  merged once and discarded.

**The policy is a pure, additive seam in `packages/collab`; the live-persistence
path is left to `y-indexeddb`'s own trim (no `apps/web` wiring).**

The seam (`packages/collab/src/crdt-snapshot.ts`):

- `COMPACTION_MAX_LOG_ENTRIES = 512` and `COMPACTION_MAX_LOG_BYTES = 1 MiB` — named
  thresholds. Two independent triggers: a high op **count** (the usual cause of
  bloat — many small edits, each with framing overhead) or total **bytes** (a few
  large ops like a paste/import).
- `shouldCompact(log, limits?)` — pure predicate, true once either threshold is
  crossed.
- `compactLogIfNeeded(log, limits?)` — returns `[compactUpdates(log)]` (one
  snapshot) when over threshold, else the **same array reference** unchanged.

**No data loss, proven by tests:** the policy tests assert that a compacted log
restores to byte-identical converged text **and** an equal `encodeStateAsUpdate`
versus replaying the full original log (including a mixed insert/delete churn case
that accumulates tombstones). Below threshold, `compactLogIfNeeded` returns the
identical array reference — provably no behavior change.

**Why no call site is wired in `apps/web`:** the only persisted live-doc log is
already trimmed by `y-indexeddb`, and the version store holds trees, not logs.
A redundant compaction in the live-persistence path would touch the delicate
seed-once / server-authority code for no bound that doesn't already exist. The
policy stands as a **ready, tested seam**: any future caller that introduces its
own accumulating `Uint8Array[]` log (e.g. an offline-cache or export-snapshot
accumulator) can adopt `shouldCompact` + `compactLogIfNeeded` directly, with the
no-data-loss guarantee already pinned.

## Notes

- If a future change adds a persisted, **un-trimmed** CRDT log (outside
  `y-indexeddb`), wire `compactLogIfNeeded` at that accumulation point and extend
  the tripwire with that scenario.
- The thresholds are deliberately generous; tune only with a real workload trace.
