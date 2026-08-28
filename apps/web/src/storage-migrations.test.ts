import { describe, it, expect } from "vitest";
import {
  CURRENT_PROJECT_SCHEMA_VERSION,
  migrateRecord,
  runMigrations,
  type Migration,
} from "./storage-migrations.js";

describe("storage-migrations: CURRENT_PROJECT_SCHEMA_VERSION", () => {
  it("is the current record-shape version (1) for the project registry", () => {
    expect(CURRENT_PROJECT_SCHEMA_VERSION).toBe(1);
  });
});

describe("storage-migrations: migrateRecord (project registry chain)", () => {
  it("is the identity for a current v1 record (changed:false, no rewrite)", () => {
    const v1 = { id: "proj-0", name: "Thesis", ownerId: "alice", schemaVersion: 1 };
    const out = migrateRecord(v1);
    expect(out.unsupported).toBe(false);
    expect(out.changed).toBe(false);
    expect(out.record).toEqual(v1);
  });

  it("brings a legacy record (no schemaVersion = v0 baseline) up to v1 by stamping", () => {
    // A pre-seam row carries the v1 shape already but no version stamp.
    const legacy = { id: "proj-0", name: "Thesis", ownerId: "alice" };
    const out = migrateRecord(legacy);
    expect(out.unsupported).toBe(false);
    expect(out.changed).toBe(true);
    expect(out.record).toEqual({
      id: "proj-0",
      name: "Thesis",
      ownerId: "alice",
      schemaVersion: 1,
    });
    // The migration must not mutate the input in place.
    expect(legacy).toEqual({ id: "proj-0", name: "Thesis", ownerId: "alice" });
  });

  it("treats an explicit schemaVersion:0 the same as a missing one (legacy baseline)", () => {
    const out = migrateRecord({ id: "p", name: "n", ownerId: "o", schemaVersion: 0 });
    expect(out.changed).toBe(true);
    expect(out.record).toMatchObject({ schemaVersion: 1 });
  });

  it("preserves all extra fields of a legacy record while stamping", () => {
    const legacy = {
      id: "p",
      name: "n",
      ownerId: "o",
      tags: ["draft"],
      archived: false,
      createdAt: 10,
    };
    const out = migrateRecord(legacy);
    expect(out.record).toEqual({ ...legacy, schemaVersion: 1 });
  });

  it("returns an UNKNOWN/FUTURE version untouched, flagged unsupported (no downgrade/corruption)", () => {
    const future = { id: "p", name: "n", ownerId: "o", schemaVersion: 99, newField: "set-by-future" };
    const out = migrateRecord(future);
    expect(out.unsupported).toBe(true);
    expect(out.changed).toBe(false);
    // Byte-for-byte identical — never silently downgraded.
    expect(out.record).toEqual(future);
  });

  it("does not mutate the input for the unsupported case either", () => {
    const future = { id: "p", schemaVersion: 99 };
    migrateRecord(future);
    expect(future).toEqual({ id: "p", schemaVersion: 99 });
  });
});

describe("storage-migrations: runMigrations (generic, composable registry)", () => {
  it("chains multiple ordered steps from a legacy record up to the target", () => {
    // A synthetic v0->v1->v2 chain proves the runner composes steps in order.
    const chain: Migration[] = [
      { from: 0, to: 1, migrate: (r) => ({ ...r, a: 1 }) },
      { from: 1, to: 2, migrate: (r) => ({ ...r, b: 2 }) },
    ];
    const out = runMigrations({ id: "x" }, chain, 2);
    expect(out.unsupported).toBe(false);
    expect(out.changed).toBe(true);
    expect(out.record).toEqual({ id: "x", a: 1, b: 2, schemaVersion: 2 });
  });

  it("applies only the remaining steps for a partially-migrated record", () => {
    const chain: Migration[] = [
      { from: 0, to: 1, migrate: (r) => ({ ...r, a: 1 }) },
      { from: 1, to: 2, migrate: (r) => ({ ...r, b: 2 }) },
    ];
    // Already at v1 — only the v1->v2 step should run.
    const out = runMigrations({ id: "x", a: 1, schemaVersion: 1 }, chain, 2);
    expect(out.changed).toBe(true);
    expect(out.record).toEqual({ id: "x", a: 1, b: 2, schemaVersion: 2 });
  });

  it("is the identity when already at the target version", () => {
    const chain: Migration[] = [{ from: 0, to: 1, migrate: (r) => ({ ...r, a: 1 }) }];
    const out = runMigrations({ id: "x", a: 1, schemaVersion: 1 }, chain, 1);
    expect(out.changed).toBe(false);
    expect(out.unsupported).toBe(false);
    expect(out.record).toEqual({ id: "x", a: 1, schemaVersion: 1 });
  });

  it("flags unsupported (never downgrades) when the record is newer than the target", () => {
    const chain: Migration[] = [{ from: 0, to: 1, migrate: (r) => r }];
    const out = runMigrations({ id: "x", schemaVersion: 5 }, chain, 1);
    expect(out.unsupported).toBe(true);
    expect(out.changed).toBe(false);
    expect(out.record).toEqual({ id: "x", schemaVersion: 5 });
  });

  it("THROWS a clear error on a gap in the migration chain (rather than guessing)", () => {
    // No step starts at version 1, so a record at v1 targeting v3 cannot proceed.
    const chain: Migration[] = [
      { from: 0, to: 1, migrate: (r) => r },
      { from: 2, to: 3, migrate: (r) => r },
    ];
    expect(() => runMigrations({ id: "x", schemaVersion: 1 }, chain, 3)).toThrow(
      /no migration from version 1/i,
    );
  });
});
