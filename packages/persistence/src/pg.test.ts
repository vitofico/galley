/**
 * Conformance wiring for `PgCrdtStore` against the real Postgres in the Docker
 * `test` gate (B1.5). Guarded by `describePg`: outside Docker
 * (`PG_TEST_DATABASE_URL` unset) the whole block skips; inside the gate it runs
 * for real, including the durability (`reopen`) block — a fresh adapter over a
 * NEW pool to the SAME schema.
 *
 * Beyond the shared contract, the pg-specific block proves the compaction
 * transaction boundary: an append that is in flight while `compact()` runs is
 * NEVER lost. The deterministic test constructs the exact dangerous
 * interleaving — an uncommitted INSERT holding a LOWER seq than a later,
 * committed one, COMMITTING while the compaction is stalled between its
 * fold-read and its DELETE — which a `DELETE … WHERE seq <= max` under READ
 * COMMITTED (fresh per-statement snapshot) would destroy un-folded.
 *
 * Leak prevention: the conformance suite calls `makeStore` once per `it`, so
 * several `PgSchema`s (each owning bounded pools, plus any `reopen()` pool)
 * accumulate. We track every schema we create and `drop()` them all in
 * `afterAll` — `drop()` ends every pool the harness handed out and drops the
 * throwaway schema, so no connection is left dangling.
 */
import { afterAll, describe, expect, it } from "vitest";
import { CollabDocument, restoreDoc, snapshotDoc } from "@galley/collab";
import { crdtStoreContract } from "./crdt-store.contract.js";
import { createPgSchema, describePg, type PgSchema } from "./pg-test-harness.js";
import { PgCrdtStore } from "./pg.js";

const human = { kind: "human" as const, userId: "alice" };

describePg("PgCrdtStore", () => {
  const schemas: PgSchema[] = [];

  afterAll(async () => {
    await Promise.allSettled(schemas.splice(0).map((s) => s.drop()));
  });

  const makeHarness = async () => {
    const harness = await createPgSchema();
    schemas.push(harness);
    return harness;
  };

  crdtStoreContract("PgCrdtStore", async () => {
    const harness = await makeHarness();
    return {
      store: await PgCrdtStore.create(harness.pool),
      // Process-restart simulation: a fresh adapter over a NEW pool to the
      // SAME schema. The reopened pool is tracked by the harness and released
      // by `drop()` in afterAll.
      reopen: async () => PgCrdtStore.create(harness.reopen()),
    };
  });

  describe("PgCrdtStore compaction transaction boundary (pg-specific)", () => {
    /** Real sequential Yjs updates from one live doc, captured per transact. */
    function editStream() {
      const live = new CollabDocument("");
      const updates: Uint8Array[] = [];
      live.doc.on("update", (u: Uint8Array) => updates.push(u));
      return {
        live,
        updates,
        edit(...texts: string[]): void {
          for (const text of texts) live.transact((t) => t.insert(t.length, text), human);
        },
      };
    }

    /**
     * Wait until a session is lock-blocked on the compaction's snapshot
     * UPSERT — i.e. `compact()` has finished its fold-read and is stalled
     * right before its DELETE. Bounded so a wiring bug fails loudly.
     */
    async function waitForSnapshotUpsertBlocked(pool: import("pg").Pool): Promise<void> {
      for (let i = 0; i < 500; i++) {
        const r = await pool.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query LIKE 'INSERT INTO crdt_snapshots%'`,
        );
        if (r.rows.length > 0) return;
        await new Promise((res) => setTimeout(res, 10));
      }
      throw new Error("compact() never blocked on the snapshot upsert");
    }

    it("never loses an append that commits while compact() is mid-transaction", async () => {
      const harness = await makeHarness();
      const store = await PgCrdtStore.create(harness.pool);
      const w = editStream();
      w.edit("a", "b", "c", "d"); // c will be the in-flight append

      await store.appendUpdate("p1", w.updates[0]!); // a — committed
      await store.appendUpdate("p1", w.updates[1]!); // b — committed
      await store.compact("p1"); // seed the snapshot row so it can be lock-held below

      const blocker = await harness.pool.connect();
      const inflight = await harness.pool.connect();
      try {
        // Hold a row lock on p1's snapshot so the compaction under test
        // stalls at its UPSERT — AFTER its fold-read, BEFORE its DELETE.
        await blocker.query("BEGIN");
        await blocker.query(`SELECT 1 FROM crdt_snapshots WHERE project_id = $1 FOR UPDATE`, [
          "p1",
        ]);

        // c: an append caught mid-flight — its log row has ALLOCATED a seq
        // but its transaction has not committed when compact() reads the log.
        await inflight.query("BEGIN");
        await inflight.query(`INSERT INTO crdt_updates (project_id, bytes) VALUES ($1, $2)`, [
          "p1",
          Buffer.from(w.updates[2]!),
        ]);
        // d commits normally, with a HIGHER seq than the in-flight c — so the
        // compaction's max read seq (d's) STRADDLES c.
        await store.appendUpdate("p1", w.updates[3]!);

        // Start the compaction: it folds {snapshot, d}, then blocks upserting.
        const compacting = store.compact("p1");
        await waitForSnapshotUpsertBlocked(harness.pool);

        // The dangerous interleaving: c COMMITS between compact()'s fold-read
        // and its DELETE. A READ COMMITTED delete (fresh per-statement
        // snapshot) would now see c — seq below the fold's max — and destroy
        // it un-folded. The REPEATABLE READ transaction still cannot.
        await inflight.query("COMMIT");
        await blocker.query("ROLLBACK"); // release the lock; compact() resumes
        await compacting;
      } finally {
        inflight.release();
        blocker.release();
      }

      // Snapshot + the in-flight append — nothing lost, nothing double-folded.
      const loaded = await store.loadUpdates("p1");
      expect(loaded.length).toBe(2);
      const rebuilt = new CollabDocument("", restoreDoc(loaded));
      expect(rebuilt.getSource()).toBe("abcd");
      expect(snapshotDoc(rebuilt.doc)).toEqual(snapshotDoc(w.live.doc));
    });

    it("a burst of appends racing one compact() converges with no loss", async () => {
      const harness = await makeHarness();
      const store = await PgCrdtStore.create(harness.pool);
      const w = editStream();
      w.edit("0", "1", "2", "3"); // seed the log so compact() has work to fold
      for (const u of w.updates) await store.appendUpdate("race", u);

      // Fire the tail burst CONCURRENTLY with the compaction; whatever the
      // interleaving, the converged doc must contain every edit.
      const before = w.updates.length;
      w.edit("4", "5", "6", "7", "8", "9");
      await Promise.all([
        store.compact("race"),
        ...w.updates.slice(before).map((u) => store.appendUpdate("race", u)),
      ]);

      const rebuilt = new CollabDocument("", restoreDoc(await store.loadUpdates("race")));
      expect(rebuilt.getSource()).toBe("0123456789");
      expect(snapshotDoc(rebuilt.doc)).toEqual(snapshotDoc(w.live.doc));
    });
  });
});
