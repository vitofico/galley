/**
 * Filesystem adapters for the persistence seams (roadmap #4, ADR-0018 §2).
 *
 * The **zero-infra default** for self-host: projects + the CRDT update log live as
 * plain files under a root directory — no database process, no native deps (just
 * `node:fs`). SQLite remains a clean drop-in behind the SAME seam for deployments
 * that want concurrent querying (a later slice); choosing filesystem first avoids
 * a native build in the offline Docker gate (see engine.md → Field notes on the
 * dependency ritual). These must behave identically to the in-memory impls.
 *
 * Layout under `root/`:
 *   projects/<id>/project.json        { id, name, ownerId }
 *   projects/<id>/members.json        { "<userId>": "<role>" }
 *   crdt/<id>/snapshot.bin            compacted state (optional)
 *   crdt/<id>/updates/<seq>.bin       append-only update log (numeric seq)
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import type {
  CrdtStore,
  Project,
  ProjectId,
  ProjectMember,
  ProjectPatch,
  ProjectRole,
  ProjectStore,
  UserId,
} from "@galley/shared";
import { applyProjectPatch } from "@galley/shared";
import { compactUpdates } from "@galley/collab";
import type { IdGenerator } from "./in-memory.js";
import { KeyedMutex } from "./keyed-mutex.js";

/**
 * Project ids used as a path segment are UNTRUSTED under `GALLEY_SYNC_AUTH=required`
 * (the attacker-controlled ws room flows in as `projectId`). Validate before any
 * `path.join` / FS access so a value like `"../../etc"` can't escape the root.
 * Same charset as the auth stores' key guard (`fs-auth-stores.ts`); legitimate
 * UUID project ids pass.
 */
const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/;

function assertSafeId(id: string): void {
  if (!SAFE_KEY.test(id)) throw new Error(`illegal project id: ${JSON.stringify(id)}`);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Atomic JSON write: write a temp sibling then rename (no torn reads). */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}

export class FsProjectStore implements ProjectStore {
  private readonly lock = new KeyedMutex();
  constructor(
    private readonly root: string,
    private readonly newId: IdGenerator = () => randomUUID(),
  ) {}

  private dir(id: ProjectId): string {
    assertSafeId(id); // gate EVERY FS path on a validated id (no traversal)
    return join(this.root, "projects", id);
  }

  createProject(input: { id?: ProjectId; name: string; ownerId: UserId }): Promise<Project> {
    const id = input.id ?? this.newId();
    // Serialize per id so a concurrent same-id create can't both pass the
    // existence check, and so members.json is written before any member op races.
    return this.lock.run(id, async () => {
      const dir = this.dir(id);
      if ((await readJson<Project>(join(dir, "project.json"))) !== null) {
        throw new Error(`project ${id} already exists`);
      }
      await mkdir(dir, { recursive: true });
      const project: Project = { id, name: input.name, ownerId: input.ownerId };
      // Membership first, then project.json as the commit marker — so a crash
      // mid-create never leaves a readable project with no owner.
      await writeJsonAtomic(join(dir, "members.json"), { [input.ownerId]: "owner" });
      await writeJsonAtomic(join(dir, "project.json"), project);
      return project;
    });
  }

  async getProject(id: ProjectId): Promise<Project | null> {
    return readJson<Project>(join(this.dir(id), "project.json"));
  }

  updateProject(id: ProjectId, patch: ProjectPatch): Promise<Project> {
    // Serialize per id so a concurrent metadata patch can't lose a write.
    return this.lock.run(id, async () => {
      const existing = await readJson<Project>(join(this.dir(id), "project.json"));
      if (existing === null) throw new Error(`unknown project ${id}`);
      const next = applyProjectPatch(existing, patch);
      await writeJsonAtomic(join(this.dir(id), "project.json"), next);
      return next;
    });
  }

  async listProjectsForUser(userId: UserId): Promise<Project[]> {
    let ids: string[];
    try {
      ids = await readdir(join(this.root, "projects"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: Project[] = [];
    for (const id of ids.sort()) {
      const roles = await readJson<Record<UserId, ProjectRole>>(join(this.dir(id), "members.json"));
      if (roles && Object.hasOwn(roles, userId)) {
        const p = await this.getProject(id);
        if (p) out.push(p);
      }
    }
    return out;
  }

  deleteProject(id: ProjectId): Promise<void> {
    return this.lock.run(id, () => rm(this.dir(id), { recursive: true, force: true }));
  }

  private async members(id: ProjectId): Promise<Record<UserId, ProjectRole>> {
    return (await readJson<Record<UserId, ProjectRole>>(join(this.dir(id), "members.json"))) ?? {};
  }

  addMember(projectId: ProjectId, userId: UserId, role: ProjectRole): Promise<void> {
    return this.lock.run(projectId, async () => {
      if ((await this.getProject(projectId)) === null) throw new Error(`unknown project ${projectId}`);
      const roles = await this.members(projectId);
      roles[userId] = role;
      await writeJsonAtomic(join(this.dir(projectId), "members.json"), roles);
    });
  }

  removeMember(projectId: ProjectId, userId: UserId): Promise<void> {
    return this.lock.run(projectId, async () => {
      const roles = await this.members(projectId);
      if (!Object.hasOwn(roles, userId)) return; // not an own member — no-op (never an inherited key)
      delete roles[userId];
      await writeJsonAtomic(join(this.dir(projectId), "members.json"), roles);
    });
  }

  async getMembership(projectId: ProjectId, userId: UserId): Promise<ProjectRole | null> {
    const roles = await this.members(projectId);
    // OWN-property only: `roles` is parsed JSON, so a userId of `__proto__` /
    // `constructor` / `toString` / `hasOwnProperty` would otherwise resolve to an
    // inherited Object.prototype member (truthy) and forge a membership for ANY
    // project. `Object.hasOwn` (never the shadowable `roles.hasOwnProperty`) gates it.
    return Object.hasOwn(roles, userId) ? roles[userId] ?? null : null;
  }

  async listMembers(projectId: ProjectId): Promise<ProjectMember[]> {
    const roles = await this.members(projectId);
    return Object.entries(roles)
      .map(([uid, role]) => ({ projectId, userId: uid, role }))
      .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  }
}

export class FsCrdtStore implements CrdtStore {
  private readonly lock = new KeyedMutex();
  constructor(private readonly root: string) {}

  private dir(id: ProjectId): string {
    assertSafeId(id); // gate EVERY FS path on a validated id (no traversal)
    return join(this.root, "crdt", id);
  }
  private updatesDir(id: ProjectId): string {
    return join(this.dir(id), "updates");
  }

  /** Numeric sequence numbers of the update files, ascending. */
  private async seqs(id: ProjectId): Promise<number[]> {
    let names: string[];
    try {
      names = await readdir(this.updatesDir(id));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return names
      .filter((n) => n.endsWith(".bin"))
      .map((n) => Number.parseInt(n.slice(0, -4), 10))
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => a - b);
  }

  appendUpdate(projectId: ProjectId, update: Uint8Array): Promise<void> {
    // Copy NOW, before awaiting the mutex — the caller may mutate/reuse its buffer
    // before the queued write runs. `new Uint8Array(update)` copies regardless of
    // whether `update` is a Uint8Array or a (pooled) Buffer.
    const bytes = new Uint8Array(update);
    return this.lock.run(projectId, async () => {
      const dir = this.updatesDir(projectId);
      await mkdir(dir, { recursive: true });
      const seqs = await this.seqs(projectId);
      const next = (seqs.length === 0 ? -1 : seqs[seqs.length - 1]!) + 1;
      // Zero-pad for tidy listings; parsing is numeric so width is cosmetic.
      const name = `${String(next).padStart(12, "0")}.bin`;
      await writeFile(join(dir, name), bytes);
    });
  }

  loadUpdates(projectId: ProjectId): Promise<Uint8Array[]> {
    return this.lock.run(projectId, () => this.loadUpdatesUnlocked(projectId));
  }

  compact(projectId: ProjectId): Promise<void> {
    return this.lock.run(projectId, async () => {
      const all = await this.loadUpdatesUnlocked(projectId);
      if (all.length === 0) return;
      const merged = compactUpdates(all);
      const dir = this.dir(projectId);
      await mkdir(dir, { recursive: true });
      // Write the new snapshot atomically, THEN drop the now-folded-in update log.
      const snapPath = join(dir, "snapshot.bin");
      const tmp = `${snapPath}.tmp-${randomUUID()}`;
      await writeFile(tmp, merged);
      await rename(tmp, snapPath);
      await rm(this.updatesDir(projectId), { recursive: true, force: true });
    });
  }

  /** The body of loadUpdates without the lock — for use inside an already-locked op. */
  private async loadUpdatesUnlocked(projectId: ProjectId): Promise<Uint8Array[]> {
    const out: Uint8Array[] = [];
    const snap = await this.readBin(join(this.dir(projectId), "snapshot.bin"));
    if (snap) out.push(snap);
    for (const seq of await this.seqs(projectId)) {
      const u = await this.readBin(join(this.updatesDir(projectId), `${String(seq).padStart(12, "0")}.bin`));
      if (u) out.push(u);
    }
    return out;
  }

  private async readBin(path: string): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(path);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
}
