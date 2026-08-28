/**
 * TEST-ONLY Postgres harness for the persistence conformance suites (roadmap
 * S2, B1.5). It imports `pg` and `vitest`, so it is TEST-ONLY and is never
 * re-exported from `index.ts` (a production import must not link the driver's
 * test scaffolding or vitest).
 *
 * Isolation model: each call to `createPgSchema()` creates a freshly-named
 * schema and pins every pooled connection's `search_path` to it, so parallel
 * test files (and the durability `reopen()` block) never collide.
 *
 * Outside Docker `PG_TEST_DATABASE_URL` is unset and the pg suites skip
 * (`describePg`); inside the gate it is set by docker-compose.test.yml and the
 * suites run for real. Adapters that need the DB but find no URL must FAIL the
 * suite in Docker — they only skip via `describePg` when the URL is absent.
 * When the URL is set but the server is unreachable, `createPgSchema` throws
 * (bounded connect timeout) and the suite FAILS — never a silent skip.
 */
import { randomBytes } from "node:crypto";
import { describe } from "vitest";
import { Pool, type PoolConfig } from "pg";

/** The gate-provided connection string, or `undefined` outside Docker. */
export const PG_TEST_URL: string | undefined = process.env.PG_TEST_DATABASE_URL;

/**
 * `describe` when a test Postgres is configured, `describe.skip` otherwise.
 * Use it to guard every pg conformance/integration block so the host runner
 * stays green by skipping, while the Docker `test` gate (which sets
 * `PG_TEST_DATABASE_URL`) runs them for real.
 */
export const describePg: (name: string, fn: () => void) => void = PG_TEST_URL
  ? describe
  : describe.skip;

/** A throwaway schema plus pooled access to it, with restart + teardown hooks. */
export interface PgSchema {
  /** Pool whose connections are pinned to this schema's `search_path`. */
  readonly pool: Pool;
  /** The unique schema name (also the default `search_path`). */
  readonly schema: string;
  /**
   * A NEW pool over the SAME schema — simulates a process restart for the
   * conformance durability block. The caller owns it and must `end()` it
   * (or rely on `drop()`, which ends every pool this harness handed out).
   */
  reopen(): Pool;
  /** Drop the schema (CASCADE) and end every pool created for it. */
  drop(): Promise<void>;
}

function poolConfig(schema: string): PoolConfig {
  return {
    connectionString: PG_TEST_URL,
    // Pin DDL/DML to the throwaway schema; `public` kept as a fallback only
    // for built-ins. Quoted to tolerate the generated name verbatim.
    options: `-c search_path="${schema}",public`,
    // Bounded so a hung connection can never wedge an unattended gate.
    max: 4,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 1_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
  };
}

/**
 * Create a uniquely-named schema and return pooled access pinned to it.
 * Throws if `PG_TEST_URL` is unset — always guard call sites with `describePg`.
 */
export async function createPgSchema(): Promise<PgSchema> {
  if (!PG_TEST_URL) {
    throw new Error("PG_TEST_DATABASE_URL is not set — guard pg suites with `describePg`");
  }
  // Schema names can't be parameterized; derive a safe identifier ourselves
  // (lowercase hex, leading letter) so no untrusted input ever reaches the DDL.
  const schema = `t_${randomBytes(16).toString("hex")}`;

  const admin = new Pool({
    connectionString: PG_TEST_URL,
    connectionTimeoutMillis: 5_000,
    max: 1,
  });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await admin.end();
  }

  const pools: Pool[] = [];
  const make = (): Pool => {
    const pool = new Pool(poolConfig(schema));
    pools.push(pool);
    return pool;
  };
  const pool = make();

  return {
    pool,
    schema,
    reopen: make,
    async drop(): Promise<void> {
      await Promise.allSettled(pools.map((p) => p.end()));
      const admin2 = new Pool({
        connectionString: PG_TEST_URL,
        connectionTimeoutMillis: 5_000,
        max: 1,
      });
      try {
        await admin2.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin2.end();
      }
    },
  };
}
