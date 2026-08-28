/**
 * Canary for the Postgres test harness (B1.5). Proves the gate wiring
 * end-to-end: a real connection, schema isolation, round-trip, and that a
 * `reopen()` pool sees committed data (the shape the conformance durability
 * block relies on). Skips automatically outside Docker (no
 * `PG_TEST_DATABASE_URL`) — and the UNGUARDED block below proves that skip
 * machinery is real, not an accident of a suite silently passing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createPgSchema, describePg, PG_TEST_URL, type PgSchema } from "./pg-test-harness.js";

// Behavioral probe for the gate: a `describePg`-guarded test that records
// whether it actually EXECUTED. Declared first so it has run (or been
// skipped) by the time the unguarded gating block below asserts on it.
let guardedSuiteRan = false;
describePg("pg gating probe", () => {
  it("marks the guarded block as executed", () => {
    guardedSuiteRan = true;
  });
});

// Deliberately NOT guarded by `describePg`: this block runs everywhere and
// pins the gating doctrine itself — URL unset ⇒ suites skip and the harness
// refuses to run; URL set ⇒ suites run for real (and an unreachable server
// FAILS them via the harness's bounded connect timeout, never a silent skip).
describe("pg harness gating", () => {
  it("runs describePg suites exactly when PG_TEST_DATABASE_URL is set", () => {
    expect(guardedSuiteRan).toBe(PG_TEST_URL !== undefined);
  });

  it("createPgSchema refuses to run without PG_TEST_DATABASE_URL", async (ctx) => {
    if (PG_TEST_URL !== undefined) return ctx.skip();
    await expect(createPgSchema()).rejects.toThrow(/PG_TEST_DATABASE_URL/);
  });
});

describePg("pg test harness", () => {
  let schema: PgSchema | undefined;
  afterEach(async () => {
    await schema?.drop();
    schema = undefined;
  });

  it("connects, isolates a schema, round-trips, and survives reopen", async () => {
    schema = await createPgSchema();
    await schema.pool.query("CREATE TABLE canary (id text PRIMARY KEY, n int NOT NULL)");
    await schema.pool.query("INSERT INTO canary (id, n) VALUES ($1, $2)", ["a", 7]);

    const read = await schema.pool.query<{ n: number }>("SELECT n FROM canary WHERE id = $1", [
      "a",
    ]);
    expect(read.rows[0]?.n).toBe(7);

    // A fresh pool over the same schema (a "restart") sees the committed row.
    const reopened = schema.reopen();
    const afterReopen = await reopened.query<{ n: number }>("SELECT n FROM canary WHERE id = $1", [
      "a",
    ]);
    expect(afterReopen.rows[0]?.n).toBe(7);
  });

  it("gives each schema an independent namespace", async () => {
    const a = await createPgSchema();
    const b = await createPgSchema();
    try {
      expect(a.schema).not.toBe(b.schema);
      await a.pool.query("CREATE TABLE only_in_a (id text)");
      // `b`'s search_path can't see `a`'s table.
      await expect(b.pool.query("SELECT * FROM only_in_a")).rejects.toThrow();
    } finally {
      await a.drop();
      await b.drop();
    }
  });
});
