# Storage schema-migration seam

Galley is local-first: the project **registry** (`galley-registry-v1`) and named
**versions** (`galley-versions-v1`) live in the browser's IndexedDB, behind the
hand-rolled `KeyValueBackend` seam (`apps/web/src/idb-project-store.ts`,
`idb-version-store.ts`). Those rows are written by whatever app build the user
last ran, and the app updates independently of stored data — a newer build can
load *older* rows. Stored records therefore carry a versioning + migration
story, so a record-shape change can never strand or mis-read user data.

## How records are versioned

Each stored row carries an internal `schemaVersion: number` stamp. The current
project-registry shape is **version 1** (`CURRENT_PROJECT_SCHEMA_VERSION`).

- The stamp lives **only on the persisted row**. The read path strips it before
  returning, so the public `Project` type and every caller/test see the exact
  same shape as before (no `schemaVersion` leaks out).
- A row written before this seam existed has no stamp. A missing/undefined
  `schemaVersion` is treated as the **legacy baseline, version 0**, and migrates
  forward from there.

## The migration runner (`apps/web/src/storage-migrations.ts`)

Pure, dependency-free, exhaustively unit-tested (`storage-migrations.test.ts`).

```ts
type Migration = { from: number; to: number; migrate: (record: any) => any };

// Ordered, forward-only registry. v0 -> v1 = stamp the legacy row to v1.
const PROJECT_MIGRATIONS: readonly Migration[] = [
  { from: 0, to: 1, migrate: (record) => ({ ...record }) },
];

migrateRecord(record): { record, changed, unsupported }
```

`migrateRecord` reads the row's version, walks `PROJECT_MIGRATIONS` in order up
to `CURRENT_PROJECT_SCHEMA_VERSION`, stamps the result, and reports whether it
changed.

### Fail-safe contract

| Case | Behavior |
| --- | --- |
| Row already at current version | identity — `changed:false`, no rewrite |
| Row at legacy baseline (no stamp / v0) | migrate forward, `changed:true`, stamp current version |
| Row **newer** than this build (future version) | returned **untouched**, `unsupported:true` — never silently downgraded or corrupted; the store skips rewriting it |
| **Gap** in the chain (no step starts at the row's version) | **throws** a clear error rather than guessing |

Migrations must be **pure** and must **not mutate** their input (return a new
object); the runner stamps `schemaVersion` for you, so a step need not set it.

## How it is wired into the read path

The project store migrates **lazily, on read** (`IdbProjectStore.readProject`):

1. fetch the stored row;
2. `migrateRecord` it forward to the current version;
3. if `changed`, **persist the migrated row back** (`put`) so each row is
   migrated at most once and the migration is durable;
4. strip `schemaVersion` and return the public `Project`.

Writes (`createProject`, `updateProject`) stamp the current version on the
stored row, so freshly-written rows are already current and read back as
`changed:false` (no rewrite). A fresh app boot is byte-for-byte unchanged.

## Adding a future migration

When the registry row shape changes, the seam makes the change safe in **two
one-line edits**:

1. append a step to `PROJECT_MIGRATIONS`, e.g.
   `{ from: 1, to: 2, migrate: (r) => ({ ...r, newField: defaultValue }) }`;
2. bump `CURRENT_PROJECT_SCHEMA_VERSION` to `2`.

The runner composes the steps in order, so a legacy (v0) row jumps straight
through `v0 -> v1 -> v2` on its next read, and a v1 row picks up only `v1 -> v2`.

## Scope

- **Project registry** (`idb-project-store.ts`) is wired through the runner.
- **Version store** (`idb-version-store.ts`) shares the same `KeyValueBackend`
  seam and `runMigrations` is generic enough to serve it (pass its own registry
  + target), but it is **not yet routed** through the runner: its rows have
  never changed shape, so there is no migration to run. When the `Version` or
  tree-row shape first changes, add a `VERSION_MIGRATIONS` registry and route
  `listVersions`/`getVersionTree` through `runMigrations` the same way.
- The per-project `y-indexeddb` doc dbs are owned by Yjs's own upgrade path and
  are out of scope for this record-level seam.
