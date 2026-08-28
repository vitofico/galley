/**
 * Storage schema-migration seam (roadmap #23.4).
 *
 * Galley is local-first: project-registry rows (`idb-project-store.ts`) and
 * version rows (`idb-version-store.ts`) live in the browser's IndexedDB. Until
 * now stored rows carried NO schema-version stamp, so the first time a record
 * shape changes post-release there is no safe seam to migrate older rows —
 * they would be silently mis-read or stranded.
 *
 * This module is the seam: stamp each row with a `schemaVersion`, and on read
 * run an ordered, registered set of forward-only migrations to bring any older
 * row up to the current shape. It is PURE (no IndexedDB, no I/O) so it can be
 * exhaustively unit-tested; the stores wire it into their read path (lazy,
 * on-read migrate-and-restamp).
 *
 * FAIL-SAFE STANCE:
 *   - A missing `schemaVersion` is treated as the LEGACY BASELINE (version 0) —
 *     every pre-seam row migrates forward from there.
 *   - An UNKNOWN / FUTURE version (a row written by a NEWER build than this one)
 *     is returned UNTOUCHED and flagged `unsupported`. It is never silently
 *     downgraded or corrupted; the store decides whether to surface or skip it.
 *   - A GAP in the migration chain (no step starts at the row's version) THROWS
 *     a clear error rather than guessing.
 *
 * ADDING A FUTURE MIGRATION is a one-line registry addition: append a
 * `{ from, to, migrate }` step and bump `CURRENT_PROJECT_SCHEMA_VERSION`.
 */

/** The current project-registry record shape. v1 = today's `Project` row shape. */
export const CURRENT_PROJECT_SCHEMA_VERSION = 1;

/** The legacy baseline: a pre-seam row with no `schemaVersion` is treated as v0. */
export const LEGACY_BASELINE_VERSION = 0;

/** Any stored row — an opaque object that may carry a `schemaVersion` stamp. */
export type StorageRecord = Record<string, unknown> & { schemaVersion?: number };

/**
 * One forward-only migration step: transform a row at version `from` into the
 * shape at version `to` (`to` should be `from + 1`). `migrate` MUST be pure and
 * MUST NOT mutate its input — return a new object. The runner stamps the result
 * with `to`, so a step need not set `schemaVersion` itself.
 */
export interface Migration {
  readonly from: number;
  readonly to: number;
  migrate: (record: any) => any;
}

/** The outcome of migrating one record. */
export interface MigrateResult<T = StorageRecord> {
  /** The (possibly migrated, always version-stamped on success) record. */
  record: T;
  /** True when migrations ran and produced a different row that must be persisted. */
  changed: boolean;
  /**
   * True when the row's version is NEWER than this build understands. The record
   * is returned untouched; nothing was migrated. The store should skip writing it
   * back and may choose to surface it to the caller as-is.
   */
  unsupported: boolean;
}

/**
 * The ordered project-registry migration registry. Forward-only; the runner
 * walks it from the record's current version up to the target.
 *
 * v0 -> v1: a legacy (pre-seam) row carries today's shape but no version stamp.
 * Today the v1 shape is identical to the legacy shape, so this migration is
 * essentially "stamp the version" (plus a home for any defaulted field a future
 * v1 shape introduces). The runner stamps `schemaVersion`, so this step only
 * needs to return the row (here: a shallow copy, leaving the input untouched).
 */
export const PROJECT_MIGRATIONS: readonly Migration[] = [
  { from: 0, to: 1, migrate: (record) => ({ ...record }) },
];

/** Read a row's stored schema version, treating missing/undefined as the baseline. */
function versionOf(record: StorageRecord): number {
  const v = record.schemaVersion;
  return typeof v === "number" && Number.isFinite(v) ? v : LEGACY_BASELINE_VERSION;
}

/**
 * Run an ordered set of migrations on `record` up to `target`, stamping the
 * result's `schemaVersion`. Generic over the registry so the same runner serves
 * the project store, the version store, and unit tests of synthetic chains.
 *
 * - Identity (changed:false) when the row is already at `target`.
 * - `unsupported:true` (record untouched) when the row is NEWER than `target`.
 * - THROWS when no step starts at the row's current version (a chain gap).
 */
export function runMigrations<T extends StorageRecord = StorageRecord>(
  record: T,
  migrations: readonly Migration[],
  target: number,
): MigrateResult<T> {
  const start = versionOf(record);

  // Newer than this build understands — never downgrade or corrupt it.
  if (start > target) {
    return { record, changed: false, unsupported: true };
  }
  // Already current — identity, no rewrite.
  if (start === target) {
    return { record, changed: false, unsupported: false };
  }

  let current = record.schemaVersion === undefined ? record : { ...record };
  let at = start;
  while (at < target) {
    const step = migrations.find((m) => m.from === at);
    if (!step) {
      throw new Error(
        `storage-migrations: no migration from version ${at} (target ${target}); ` +
          `the migration chain has a gap`,
      );
    }
    current = step.migrate(current);
    at = step.to;
  }
  const migrated = { ...current, schemaVersion: target } as T;
  return { record: migrated, changed: true, unsupported: false };
}

/**
 * Migrate a project-registry row up to `CURRENT_PROJECT_SCHEMA_VERSION` using the
 * registered `PROJECT_MIGRATIONS`. This is the entry point the project store wires
 * into its read path. See `runMigrations` for the contract.
 */
export function migrateRecord<T extends StorageRecord = StorageRecord>(
  record: T,
): MigrateResult<T> {
  return runMigrations(record, PROJECT_MIGRATIONS, CURRENT_PROJECT_SCHEMA_VERSION);
}
