/**
 * Postgres-backed `CrdtStore` (roadmap S2, B1.5) — a single-replica adapter
 * behind the SAME seam as the in-memory and filesystem stores, passing the
 * exact same conformance contract (`crdt-store.contract.ts`) INCLUDING the
 * durability (`reopen`) block: durability is just the database — a fresh
 * adapter over a new pool to the same database sees prior writes.
 *
 * Layout — a project-scoped append-only log plus one folded snapshot:
 *   crdt_updates(project_id, seq bigserial, bytes)   the tail, in seq order
 *   crdt_snapshots(project_id PRIMARY KEY, bytes)    compacted state (optional)
 *
 * `appendUpdate` is a single INSERT — `bigserial` hands out seqs atomically,
 * so concurrent appends never race on a sequence number. `loadUpdates` reads
 * snapshot-then-tail in ONE statement (one MVCC snapshot — a compact landing
 * between two separate queries could otherwise double- or under-count rows).
 *
 * `compact` runs in ONE transaction at REPEATABLE READ, so every statement in
 * it shares a single MVCC snapshot: the DELETE removes exactly the rows the
 * SELECT folded, and no more. That isolation level is load-bearing — under
 * READ COMMITTED an append that allocated a low seq before the fold-read but
 * committed before the DELETE would be destroyed WITHOUT ever being folded
 * (`DELETE … WHERE seq <= max` would see it; the fold didn't). Concurrent
 * `compact()`s of the SAME project may abort with a serialization failure —
 * the sync server compacts serially per project, so that is out of scope for
 * the single-replica slice.
 *
 * Safety:
 *  - Parameterized queries ($1,$2,…) ONLY; no value is ever string-interpolated
 *    (so project ids need no path-style charset gate here).
 *  - UNQUALIFIED table names, so the pool's `search_path` controls placement
 *    (the test harness pins a throwaway schema; production uses the
 *    connection's default schema).
 *  - DDL is idempotent (`CREATE TABLE IF NOT EXISTS`) and runs once in the
 *    static `create` factory, so callers never touch an unmigrated table.
 *
 * Runtime-only: imports `pg` + workspace types ONLY — never vitest or the
 * test harness, so a production import never links test scaffolding.
 */
import { Pool } from "pg";
import { compactUpdates } from "@galley/collab";
import type { CrdtStore, ProjectId } from "@galley/shared";

interface BytesRow {
  bytes: Buffer;
}

interface TailRow {
  seq: string; // bigint comes back as a string from node-postgres
  bytes: Buffer;
}

export class PgCrdtStore implements CrdtStore {
  private constructor(private readonly pool: Pool) {}

  /**
   * Build a store over `pool`, running idempotent DDL first. Safe to call
   * repeatedly (including over a reopened pool) — the tables are created only
   * if they do not already exist.
   */
  static async create(pool: Pool): Promise<PgCrdtStore> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crdt_updates (
        project_id text      NOT NULL,
        seq        bigserial NOT NULL,
        bytes      bytea     NOT NULL,
        PRIMARY KEY (project_id, seq)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crdt_snapshots (
        project_id text  PRIMARY KEY,
        bytes      bytea NOT NULL
      )
    `);
    return new PgCrdtStore(pool);
  }

  async appendUpdate(projectId: ProjectId, update: Uint8Array): Promise<void> {
    // `Buffer.from(update)` copies SYNCHRONOUSLY, before any await — the
    // caller may mutate/reuse its buffer the moment this returns control.
    await this.pool.query(`INSERT INTO crdt_updates (project_id, bytes) VALUES ($1, $2)`, [
      projectId,
      Buffer.from(update),
    ]);
  }

  async loadUpdates(projectId: ProjectId): Promise<Uint8Array[]> {
    // ONE statement = ONE MVCC snapshot: the snapshot row and the tail are a
    // consistent pair even while a concurrent compact() folds the log.
    const result = await this.pool.query<BytesRow>(
      `SELECT bytes FROM (
         SELECT 0 AS ord, 0::bigint AS seq, bytes FROM crdt_snapshots WHERE project_id = $1
         UNION ALL
         SELECT 1 AS ord, seq, bytes FROM crdt_updates WHERE project_id = $1
       ) AS log
       ORDER BY ord, seq`,
      [projectId],
    );
    // Copy on the way OUT (contract): a caller scribbling on a returned
    // buffer must never alias driver-internal memory.
    return result.rows.map((r) => new Uint8Array(r.bytes));
  }

  async compact(projectId: ProjectId): Promise<void> {
    const client = await this.pool.connect();
    try {
      // REPEATABLE READ: one MVCC snapshot for the whole transaction, so the
      // DELETE below removes EXACTLY the rows the SELECT folded. An append
      // committing at any point during this transaction is invisible to both
      // statements and survives in the tail (see the header comment for why
      // READ COMMITTED would lose it).
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const tail = await client.query<TailRow>(
        `SELECT seq, bytes FROM crdt_updates WHERE project_id = $1 ORDER BY seq`,
        [projectId],
      );
      if (tail.rows.length === 0) {
        // Nothing to fold: no log (and any existing snapshot is already
        // compact). Matches the contract: compacting an unknown project is a
        // no-op, not an error.
        await client.query("COMMIT");
        return;
      }
      const snap = await client.query<BytesRow>(
        `SELECT bytes FROM crdt_snapshots WHERE project_id = $1`,
        [projectId],
      );
      const merged = compactUpdates([
        ...snap.rows.map((r) => new Uint8Array(r.bytes)),
        ...tail.rows.map((r) => new Uint8Array(r.bytes)),
      ]);
      await client.query(
        `INSERT INTO crdt_snapshots (project_id, bytes) VALUES ($1, $2)
         ON CONFLICT (project_id) DO UPDATE SET bytes = EXCLUDED.bytes`,
        [projectId, Buffer.from(merged)],
      );
      // Delete ONLY the rows read above — never a blanket per-project DELETE,
      // which would destroy appends that landed after the fold-read.
      await client.query(`DELETE FROM crdt_updates WHERE project_id = $1 AND seq <= $2`, [
        projectId,
        tail.rows[tail.rows.length - 1]!.seq,
      ]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {
        /* the throw below already carries the root cause */
      });
      throw err;
    } finally {
      client.release();
    }
  }
}
