/**
 * Browser `VersionStore` over IndexedDB (roadmap #12.5) — persists NAMED VERSIONS:
 * each version's metadata row plus its materialized git-shaped tree. It does NOT
 * materialize the CRDT into a tree itself (that happens at the call site via the
 * existing cores); it just stores, lists, and loads what it's handed.
 *
 * Implements the EXACT `@galley/shared` `VersionStore` interface (types imported,
 * never edited). Factored over the same tiny async `KeyValueBackend` seam as the
 * sibling project registry (`idb-project-store.ts`): the unit gate (Node, no real
 * IndexedDB) injects the `InMemoryKeyValueBackend`; the browser uses
 * `IndexeddbKeyValueBackend`. No new deps.
 *
 * STORAGE LAYOUT: a separate, versioned db (`galley-versions-v1`) — distinct from
 * the project registry and the per-project CRDT doc dbs — holding two stores:
 *   - `versions`: metadata rows keyed by version id, carrying `{ ...Version, seq }`.
 *     `seq` is a monotonically increasing insertion counter (across all projects).
 *   - `trees`: tree rows keyed by version id, carrying `{ id, tree }`.
 * `listVersions(projectId)` returns that project's versions in INSERTION ORDER
 * (sorted by `seq`), stripping the internal `seq`. The returned `Version` never
 * leaks `seq` or `tree`.
 */
import type { ProjectId, Version, VersionedFile, VersionStore } from "@galley/shared";
import {
  type KeyValueBackend,
  type ObjectStoreSpec,
  IndexeddbKeyValueBackend,
  InMemoryKeyValueBackend,
} from "./idb-project-store.js";

/** Versioned versions db name — distinct from the registry and per-project CRDT dbs. */
export const VERSION_DB_NAME = "galley-versions-v1";
/** Object stores inside the versions db. */
export const VERSIONS_STORE = "versions";
export const TREES_STORE = "trees";

/** The versions db's stores — both keyed by the version id (in-value `id`). */
export const VERSION_STORES: ObjectStoreSpec[] = [
  { name: VERSIONS_STORE, keyPath: "id" },
  { name: TREES_STORE, keyPath: "id" },
];

/**
 * A stored version metadata row: the `Version` plus two STORE-INTERNAL fields,
 * neither of which is part of the shared `Version` contract:
 *   - `seq`: an insertion-order sequence (sorts `listVersions`).
 *   - `createdAt`: the version's creation time (epoch ms). Stamped on write so
 *     `list_versions` over the control surface can surface it (F2). OPTIONAL on
 *     the row so a row written by an older build (before this field) reads back
 *     cleanly — the metadata reader simply omits `createdAt` for such rows.
 */
interface VersionRow extends Version {
  seq: number;
  createdAt?: number;
}

/**
 * The public `Version` widened with the row's optional `createdAt` (epoch ms) —
 * what {@link IdbVersionStore.listVersionMetadata} returns so the control-surface
 * `list_versions` can carry creation time WITHOUT touching the shared `Version`
 * type (which deliberately has no `createdAt`). Strictly additive: `createdAt` is
 * absent for legacy rows, present for rows written since F2.
 */
export type VersionMetadata = Version & { createdAt?: number };

/** A stored tree row, keyed by version id. */
interface TreeRow {
  id: string;
  tree: VersionedFile[];
}

/** Default id generator: a `ver-${uuid}` minted like the project store's ids. */
function defaultNewId(): string {
  const c: { randomUUID?: () => string } | undefined =
    typeof globalThis !== "undefined"
      ? (globalThis.crypto as { randomUUID?: () => string } | undefined)
      : undefined;
  const token =
    c && typeof c.randomUUID === "function"
      ? c.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `ver-${token}`;
}

export interface IdbVersionStoreOptions {
  /** Storage backend (default: IndexedDB over the versions db). */
  backend?: KeyValueBackend;
  /** Id generator for `createVersion` (default: uuid-ish). */
  newId?: () => string;
  /**
   * Clock for the row's `createdAt` stamp (epoch ms; default `Date.now`).
   * Injected so the unit gate can assert a deterministic creation time.
   */
  now?: () => number;
}

/**
 * `VersionStore` over a `KeyValueBackend`. Version metadata lives in the `versions`
 * store keyed by id; the materialized tree lives in the `trees` store keyed by the
 * same id. Insertion order is preserved via a per-row `seq` counter.
 */
export class IdbVersionStore implements VersionStore {
  private readonly backend: KeyValueBackend;
  private readonly newId: () => string;
  private readonly now: () => number;

  constructor(options: IdbVersionStoreOptions = {}) {
    this.backend =
      options.backend ?? new IndexeddbKeyValueBackend(VERSION_DB_NAME, undefined, VERSION_STORES);
    this.newId = options.newId ?? defaultNewId;
    this.now = options.now ?? (() => Date.now());
  }

  async createVersion(
    projectId: ProjectId,
    // `author` (#12) is accepted for seam parity but not persisted: idb stores the
    // public `Version` shape, which carries no author (only the bare-git store does).
    input: {
      name: string;
      message?: string;
      contributors?: string[];
      author?: { name: string; email: string };
    },
    tree: VersionedFile[],
  ): Promise<Version> {
    const id = this.newId();
    const seq = await this.nextSeq();
    // exactOptionalPropertyTypes is ON: only include optional keys when given.
    // `contributors` (roadmap #11) is stored only when non-empty so older rows and
    // contributor-less saves stay byte-identical (absent, not `[]`).
    const version: Version = {
      id,
      projectId,
      name: input.name,
      ...(input.message !== undefined ? { message: input.message } : {}),
      ...(input.contributors !== undefined && input.contributors.length > 0
        ? { contributors: input.contributors }
        : {}),
    };
    // Write the TREE first, the metadata LAST. `put` is its own auto-committing
    // IDB transaction, and we await each — so a crash between the two leaves at
    // worst an orphan tree (unreachable: `listVersions` reads only the metadata
    // store), NOT a listed-but-unrestorable version whose `getVersionTree` is
    // null. Ordering keeps the invariant "a listed version always has its tree"
    // without a cross-store transaction API (2026-06-15 audit).
    const treeRow: TreeRow = { id, tree };
    await this.backend.put(TREES_STORE, id, treeRow);
    // `createdAt` is stamped onto the stored ROW only (a store-internal field,
    // like `seq`); the returned public `Version` deliberately stays the bare
    // {id, projectId, name, message?, contributors?} shape (existing callers and
    // tests depend on that exact shape).
    const row: VersionRow = { ...version, seq, createdAt: this.now() };
    await this.backend.put(VERSIONS_STORE, id, row);
    return version;
  }

  async listVersions(projectId: ProjectId): Promise<Version[]> {
    const rows = await this.backend.getAll<VersionRow>(VERSIONS_STORE);
    return rows
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => a.seq - b.seq)
      .map((r) => stripRow(r));
  }

  /**
   * Like {@link listVersions}, but each row also carries its `createdAt` (epoch
   * ms) when present — the metadata the control-surface `list_versions` surfaces
   * (F2). Same project filter + insertion-order sort; `seq`/`tree` never leak.
   * Legacy rows lacking `createdAt` (written before the field) omit it cleanly.
   */
  async listVersionMetadata(projectId: ProjectId): Promise<VersionMetadata[]> {
    const rows = await this.backend.getAll<VersionRow>(VERSIONS_STORE);
    return rows
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => a.seq - b.seq)
      .map((r) => stripMetaRow(r));
  }

  async getVersionTree(versionId: string): Promise<VersionedFile[] | null> {
    const row = await this.backend.get<TreeRow>(TREES_STORE, versionId);
    return row ? row.tree : null;
  }

  /**
   * The tree of one version, but ONLY when that version's metadata row belongs to
   * `projectId` (B4 — the control-surface version file reads). Fail-closed null
   * when the version id is unknown, owned by a DIFFERENT project (so a leaked /
   * guessed version id can never read another project's files), or has no stored
   * tree (a crash between writes — never surface a half-version). The membership
   * authority is enforced one layer up (the mount checks project membership);
   * this guarantees the version⇄project binding on top of it.
   */
  async getProjectVersionTree(
    projectId: ProjectId,
    versionId: string,
  ): Promise<VersionedFile[] | null> {
    const meta = await this.backend.get<VersionRow>(VERSIONS_STORE, versionId);
    if (meta === null || meta === undefined) return null;
    if (meta.projectId !== projectId) return null;
    return this.getVersionTree(versionId);
  }

  /** Next insertion sequence: one past the current max across all version rows. */
  private async nextSeq(): Promise<number> {
    const rows = await this.backend.getAll<VersionRow>(VERSIONS_STORE);
    let max = -1;
    for (const r of rows) if (r.seq > max) max = r.seq;
    return max + 1;
  }
}

/** Project a stored row down to the public `Version` shape (drop `seq`, no `tree`). */
function stripRow(row: VersionRow): Version {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    ...(row.message !== undefined ? { message: row.message } : {}),
    // Older rows (written before #11) lack `contributors` → stays absent; no migration.
    ...(row.contributors !== undefined && row.contributors.length > 0
      ? { contributors: row.contributors }
      : {}),
  };
}

/**
 * Project a stored row down to {@link VersionMetadata}: the public `Version`
 * (via {@link stripRow}) widened with the row's `createdAt` when present (epoch
 * ms). Legacy rows lacking the field → `createdAt` stays absent (no `: undefined`
 * slot under exactOptionalPropertyTypes; no migration).
 */
function stripMetaRow(row: VersionRow): VersionMetadata {
  return {
    ...stripRow(row),
    ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
  };
}

// Re-export so a browser entry can build the IndexedDB-backed store without
// reaching into the sibling module; keeps the version store self-contained.
export { IndexeddbKeyValueBackend, InMemoryKeyValueBackend };
