/**
 * Browser `ProjectStore` over IndexedDB (roadmap #12.1) — a lightweight project
 * REGISTRY of metadata: which projects this browser knows, their names/owners, and
 * membership. It is NOT the CRDT doc content: each project's doc lives in its own
 * per-project `y-indexeddb` database (`galley-local-project-v1-${room}`, see
 * `createProjectSession`). This registry is a SEPARATE, versioned db
 * (`galley-registry-v1`) so the two never collide.
 *
 * Implements the EXACT `@galley/shared` `ProjectStore` interface (types imported,
 * never edited). Semantics mirror the in-memory reference (`@galley/persistence`):
 * creating a project makes its owner an `owner` member; `getMembership` is null
 * when absent; `listProjectsForUser` returns projects the user owns OR is a member
 * of; `deleteProject` removes the project AND its memberships.
 *
 * TESTABILITY: factored over a tiny async `KeyValueBackend` seam. The unit gate
 * (Node, no real IndexedDB, and `fake-indexeddb` is NOT a dependency) uses the
 * `InMemoryKeyValueBackend`; the browser uses `IndexeddbKeyValueBackend`. No new
 * deps — the IndexedDB backend hand-rolls a small promise wrapper over the
 * built-in `indexedDB` global.
 */
import type {
  Project,
  ProjectId,
  ProjectMember,
  ProjectPatch,
  ProjectRole,
  ProjectStore,
  UserId,
} from "@galley/shared";
import { applyProjectPatch } from "@galley/shared";
import {
  CURRENT_PROJECT_SCHEMA_VERSION,
  migrateRecord,
  type StorageRecord,
} from "./storage-migrations.js";

/** Versioned registry db name — distinct from the per-project CRDT doc dbs. */
export const REGISTRY_DB_NAME = "galley-registry-v1";
/** Object stores inside the registry db. */
export const PROJECTS_STORE = "projects";
export const MEMBERS_STORE = "members";

/** An object store to create in the IndexedDB backend (name + its in-value key path). */
export interface ObjectStoreSpec {
  name: string;
  keyPath: string;
}

/** The registry db's stores (the backend's default — preserves prior behavior). */
export const REGISTRY_STORES: ObjectStoreSpec[] = [
  { name: PROJECTS_STORE, keyPath: "id" },
  { name: MEMBERS_STORE, keyPath: "key" },
];

/** A stored membership row, keyed by the composite `projectId\u0000userId`. */
interface MemberRow {
  key: string;
  projectId: ProjectId;
  userId: UserId;
  role: ProjectRole;
}

/** Composite key for a membership row (NUL-joined: neither id contains NUL). */
function memberKey(projectId: ProjectId, userId: UserId): string {
  return `${projectId}\u0000${userId}`;
}

/**
 * A minimal async key/value seam: named "stores", string-keyed JSON-ish values.
 * Both the in-memory (tests) and IndexedDB (browser) backends implement it.
 */
export interface KeyValueBackend {
  get<T>(store: string, key: string): Promise<T | null>;
  put(store: string, key: string, value: unknown): Promise<void>;
  getAll<T>(store: string): Promise<T[]>;
  delete(store: string, key: string): Promise<void>;
}

/** In-memory backend for the unit gate (no IndexedDB). Deep-ish copies on the edge. */
export class InMemoryKeyValueBackend implements KeyValueBackend {
  private readonly stores = new Map<string, Map<string, unknown>>();

  private bucket(store: string): Map<string, unknown> {
    let m = this.stores.get(store);
    if (!m) {
      m = new Map();
      this.stores.set(store, m);
    }
    return m;
  }

  async get<T>(store: string, key: string): Promise<T | null> {
    const v = this.bucket(store).get(key);
    return v === undefined ? null : (clone(v) as T);
  }

  async put(store: string, key: string, value: unknown): Promise<void> {
    this.bucket(store).set(key, clone(value));
  }

  async getAll<T>(store: string): Promise<T[]> {
    return [...this.bucket(store).values()].map((v) => clone(v) as T);
  }

  async delete(store: string, key: string): Promise<void> {
    this.bucket(store).delete(key);
  }
}

/** Structured-ish clone so callers can't mutate stored rows through a returned ref. */
function clone<T>(v: T): T {
  return v === undefined || v === null ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/**
 * IndexedDB backend (browser). Hand-rolled promise wrapper over the built-in
 * `indexedDB` global — no `idb` dependency. The db schema (two stores keyed by
 * an in-value key) is created lazily in `onupgradeneeded`. The factory is
 * injectable so a browser test could pass one in; it defaults to the global.
 */
export class IndexeddbKeyValueBackend implements KeyValueBackend {
  private dbPromise: Promise<IDBDatabase> | undefined;

  constructor(
    private readonly dbName: string = REGISTRY_DB_NAME,
    private readonly factory: IDBFactory = globalThis.indexedDB,
    // Which object stores this db holds. Defaults to the registry stores so
    // existing callers are unchanged; the version store passes its own.
    private readonly stores: ObjectStoreSpec[] = REGISTRY_STORES,
  ) {}

  private open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      const p = new Promise<IDBDatabase>((resolve, reject) => {
        const req = this.factory.open(this.dbName, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const s of this.stores) {
            if (!db.objectStoreNames.contains(s.name)) {
              db.createObjectStore(s.name, { keyPath: s.keyPath });
            }
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
      });
      // A transient open failure must not poison the cache forever: drop the
      // rejected promise so the next call retries instead of awaiting the same
      // rejection for the rest of the session.
      this.dbPromise = p;
      void p.catch(() => {
        if (this.dbPromise === p) this.dbPromise = undefined;
      });
    }
    return this.dbPromise;
  }

  private async tx<T>(
    store: string,
    mode: IDBTransactionMode,
    body: (s: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const req = body(transaction.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
    });
  }

  async get<T>(store: string, key: string): Promise<T | null> {
    const v = await this.tx<unknown>(store, "readonly", (s) => s.get(key));
    return v === undefined ? null : (v as T);
  }

  async put(store: string, key: string, value: unknown): Promise<void> {
    // Stores use an in-value keyPath (`id` / `key`); `value` already carries it.
    await this.tx(store, "readwrite", (s) => s.put(value));
  }

  async getAll<T>(store: string): Promise<T[]> {
    return this.tx<T[]>(store, "readonly", (s) => s.getAll());
  }

  async delete(store: string, key: string): Promise<void> {
    await this.tx(store, "readwrite", (s) => s.delete(key));
  }
}

/**
 * A STORED project row: the public `Project` plus the internal `schemaVersion`
 * stamp (roadmap #23.4). The stamp lives only on the persisted row and the read
 * path strips it before returning, so the public `Project` shape — and every
 * caller and existing test — is byte-for-byte unchanged.
 */
type ProjectRow = Project & StorageRecord;

/** Stamp the current schema version onto a project before it is written. */
function stampProject(project: Project): ProjectRow {
  return { ...project, schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION };
}

/** Project a stored row back to the public `Project` shape (drop `schemaVersion`). */
function stripProject(row: ProjectRow): Project {
  const { schemaVersion: _omit, ...project } = row;
  return project as Project;
}

/** Default id generator: a `proj-${uuid}` minted like the local profile token. */
function defaultNewId(): string {
  const c: { randomUUID?: () => string } | undefined =
    typeof globalThis !== "undefined"
      ? (globalThis.crypto as { randomUUID?: () => string } | undefined)
      : undefined;
  const token =
    c && typeof c.randomUUID === "function"
      ? c.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `proj-${token}`;
}

export interface IdbProjectStoreOptions {
  /** Storage backend (default: IndexedDB over the registry db). */
  backend?: KeyValueBackend;
  /** Id generator for `createProject` with no explicit id (default: uuid-ish). */
  newId?: () => string;
}

/**
 * `ProjectStore` over a `KeyValueBackend`. Projects live in the `projects` store
 * keyed by id; memberships live in the `members` store keyed by `projectId\0userId`.
 */
export class IdbProjectStore implements ProjectStore {
  private readonly backend: KeyValueBackend;
  private readonly newId: () => string;

  constructor(options: IdbProjectStoreOptions = {}) {
    this.backend = options.backend ?? new IndexeddbKeyValueBackend();
    this.newId = options.newId ?? defaultNewId;
  }

  async createProject(input: { id?: ProjectId; name: string; ownerId: UserId }): Promise<Project> {
    const id = input.id ?? this.newId();
    if ((await this.backend.get<Project>(PROJECTS_STORE, id)) !== null) {
      throw new Error(`project ${id} already exists`);
    }
    const project: Project = { id, name: input.name, ownerId: input.ownerId };
    // Stamp the current schema version on the stored row (read path strips it).
    await this.backend.put(PROJECTS_STORE, id, stampProject(project));
    // The owner is a member with role `owner`, so membership checks are uniform.
    await this.writeMember(id, input.ownerId, "owner");
    return project;
  }

  async getProject(id: ProjectId): Promise<Project | null> {
    return this.readProject(id);
  }

  async updateProject(id: ProjectId, patch: ProjectPatch): Promise<Project> {
    const existing = await this.readProject(id);
    if (existing === null) throw new Error(`unknown project ${id}`);
    const next = applyProjectPatch(existing, patch);
    await this.backend.put(PROJECTS_STORE, id, stampProject(next));
    return next;
  }

  async listProjectsForUser(userId: UserId): Promise<Project[]> {
    const rows = await this.backend.getAll<MemberRow>(MEMBERS_STORE);
    const ids = rows.filter((r) => r.userId === userId).map((r) => r.projectId);
    const out: Project[] = [];
    for (const pid of ids) {
      const p = await this.readProject(pid);
      if (p) out.push(p);
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * Read a project row through the schema-migration seam (roadmap #23.4): fetch
   * the stored row, migrate it forward to the current schema version, lazily
   * persist the migrated row back when it changed (so the migration is durable),
   * then strip the internal `schemaVersion` and return the public `Project`.
   *
   * A row NEWER than this build (`unsupported`) is returned untouched and is NOT
   * rewritten — it is never silently downgraded; the migrated/stripped shape is
   * still returned so the registry stays usable.
   */
  private async readProject(id: ProjectId): Promise<Project | null> {
    const stored = await this.backend.get<ProjectRow>(PROJECTS_STORE, id);
    if (stored === null) return null;
    const { record, changed } = migrateRecord<ProjectRow>(stored);
    if (changed) {
      // Lazy on-read migrate-and-restamp: persist so we migrate each row once.
      await this.backend.put(PROJECTS_STORE, id, record);
    }
    return stripProject(record);
  }

  async deleteProject(id: ProjectId): Promise<void> {
    await this.backend.delete(PROJECTS_STORE, id);
    const rows = await this.backend.getAll<MemberRow>(MEMBERS_STORE);
    for (const r of rows) {
      if (r.projectId === id) await this.backend.delete(MEMBERS_STORE, r.key);
    }
  }

  async addMember(projectId: ProjectId, userId: UserId, role: ProjectRole): Promise<void> {
    if ((await this.backend.get<Project>(PROJECTS_STORE, projectId)) === null) {
      throw new Error(`unknown project ${projectId}`);
    }
    await this.writeMember(projectId, userId, role);
  }

  async removeMember(projectId: ProjectId, userId: UserId): Promise<void> {
    await this.backend.delete(MEMBERS_STORE, memberKey(projectId, userId));
  }

  async getMembership(projectId: ProjectId, userId: UserId): Promise<ProjectRole | null> {
    const row = await this.backend.get<MemberRow>(MEMBERS_STORE, memberKey(projectId, userId));
    return row ? row.role : null;
  }

  async listMembers(projectId: ProjectId): Promise<ProjectMember[]> {
    const rows = await this.backend.getAll<MemberRow>(MEMBERS_STORE);
    return rows
      .filter((r) => r.projectId === projectId)
      .map((r) => ({ projectId: r.projectId, userId: r.userId, role: r.role }))
      .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  }

  private async writeMember(projectId: ProjectId, userId: UserId, role: ProjectRole): Promise<void> {
    const row: MemberRow = { key: memberKey(projectId, userId), projectId, userId, role };
    await this.backend.put(MEMBERS_STORE, row.key, row);
  }
}
