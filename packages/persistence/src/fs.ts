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
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  rename,
  open,
} from "node:fs/promises";
import { join, dirname, resolve, sep } from "node:path";
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
import { FsSessionStore } from "./fs-auth-stores.js";

/**
 * Project ids used as a path segment are UNTRUSTED under `GALLEY_SYNC_AUTH=required`
 * (the attacker-controlled ws room flows in as `projectId`). Validate before any
 * `path.join` / FS access so a value like `"../../etc"` can't escape the root.
 * Same charset as the auth stores' key guard (`fs-auth-stores.ts`); legitimate
 * UUID project ids pass.
 */
const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/;

function assertSafeId(id: string): void {
  if (!SAFE_KEY.test(id))
    throw new Error(`illegal project id: ${JSON.stringify(id)}`);
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
  try {
    const file = await open(tmp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value, null, 2));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, path);
    const dir = await open(dirname(path), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

export class FsProjectStore implements ProjectStore {
  private static readonly locks = new KeyedMutex();
  private readonly lock = FsProjectStore.locks;
  private async assertOwnerActive(owner: string): Promise<void> {
    if (await new FsSessionStore(this.root).isUserClosed(owner))
      throw new Error("Account is closed");
  }
  constructor(
    private readonly root: string,
    private readonly newId: IdGenerator = () => randomUUID(),
  ) {}

  private dir(id: ProjectId): string {
    assertSafeId(id); // gate EVERY FS path on a validated id (no traversal)
    return join(this.root, "projects", id);
  }

  createProject(input: {
    id?: ProjectId;
    name: string;
    ownerId: UserId;
  }): Promise<Project> {
    const id = input.id ?? this.newId();
    // Serialize per id so a concurrent same-id create can't both pass the
    // existence check, and so members.json is written before any member op races.
    return this.lock.run(id, async () => {
      const dir = this.dir(id);
      await this.assertOwnerActive(input.ownerId);
      if ((await readJson<Project>(join(dir, "project.json"))) !== null) {
        throw new Error(`project ${id} already exists`);
      }
      await mkdir(dir, { recursive: true });
      const project: Project = { id, name: input.name, ownerId: input.ownerId };
      // Membership first, then project.json as the commit marker — so a crash
      // mid-create never leaves a readable project with no owner.
      await writeJsonAtomic(join(dir, "members.json"), {
        [input.ownerId]: "owner",
      });
      await writeJsonAtomic(join(dir, "project.json"), project);
      if (await new FsSessionStore(this.root).isUserClosed(input.ownerId)) {
        await rm(dir, { recursive: true, force: true });
        throw new Error("Account is closed");
      }
      return project;
    });
  }

  async getProject(id: ProjectId): Promise<Project | null> {
    return readJson<Project>(join(this.dir(id), "project.json"));
  }

  updateProject(id: ProjectId, patch: ProjectPatch): Promise<Project> {
    // Serialize per id so a concurrent metadata patch can't lose a write.
    return this.lock.run(id, async () => {
      const existing = await readJson<Project>(
        join(this.dir(id), "project.json"),
      );
      if (existing === null) throw new Error(`unknown project ${id}`);
      if (!existing.ownerGroupId)
        await this.assertOwnerActive(existing.ownerId);
      const next = applyProjectPatch(existing, patch);
      if (!next.ownerGroupId) await this.assertOwnerActive(next.ownerId);
      await writeJsonAtomic(join(this.dir(id), "project.json"), next);
      if (
        (!existing.ownerGroupId || !next.ownerGroupId) &&
        (await new FsSessionStore(this.root).isUserClosed(existing.ownerId))
      ) {
        await writeJsonAtomic(join(this.dir(id), "project.json"), existing);
        throw new Error("Account is closed");
      }
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
      const roles = await readJson<Record<UserId, ProjectRole>>(
        join(this.dir(id), "members.json"),
      );
      if (roles && Object.hasOwn(roles, userId)) {
        const p = await this.getProject(id);
        if (p) out.push(p);
      }
    }
    return out;
  }

  deleteProject(id: ProjectId): Promise<void> {
    return this.lock.run(id, () =>
      rm(this.dir(id), { recursive: true, force: true }),
    );
  }
  /** Recheck ownership and sharing under the same writer lock before retiring content. */
  purgeOwnedProject(
    id: ProjectId,
    ownerId: string,
    allowShared: boolean,
    retire: () => Promise<void>,
  ): Promise<boolean> {
    return this.lock.run(id, async () => {
      const project = await this.getProject(id);
      if (project && (project.ownerId !== ownerId || project.ownerGroupId))
        return false;
      if (
        !allowShared &&
        (await this.listMembers(id)).some((member) => member.userId !== ownerId)
      )
        throw new Error("Shared project requires explicit consent");
      await retire();
      await rm(this.dir(id), { recursive: true, force: true });
      return true;
    });
  }

  private async members(id: ProjectId): Promise<Record<UserId, ProjectRole>> {
    return (
      (await readJson<Record<UserId, ProjectRole>>(
        join(this.dir(id), "members.json"),
      )) ?? {}
    );
  }

  addMember(
    projectId: ProjectId,
    userId: UserId,
    role: ProjectRole,
  ): Promise<void> {
    return this.lock.run(projectId, async () => {
      const project = await this.getProject(projectId);
      if (project === null) throw new Error(`unknown project ${projectId}`);
      if (!project.ownerGroupId) await this.assertOwnerActive(project.ownerId);
      await this.assertOwnerActive(userId);
      const roles = await this.members(projectId);
      const previous = { ...roles };
      roles[userId] = role;
      await writeJsonAtomic(join(this.dir(projectId), "members.json"), roles);
      if (
        (!project.ownerGroupId &&
          (await new FsSessionStore(this.root).isUserClosed(
            project.ownerId,
          ))) ||
        (await new FsSessionStore(this.root).isUserClosed(userId))
      ) {
        await writeJsonAtomic(
          join(this.dir(projectId), "members.json"),
          previous,
        );
        throw new Error("Account is closed");
      }
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

  async getMembership(
    projectId: ProjectId,
    userId: UserId,
  ): Promise<ProjectRole | null> {
    const roles = await this.members(projectId);
    // OWN-property only: `roles` is parsed JSON, so a userId of `__proto__` /
    // `constructor` / `toString` / `hasOwnProperty` would otherwise resolve to an
    // inherited Object.prototype member (truthy) and forge a membership for ANY
    // project. `Object.hasOwn` (never the shadowable `roles.hasOwnProperty`) gates it.
    return Object.hasOwn(roles, userId) ? (roles[userId] ?? null) : null;
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
  private async assertLive(id: ProjectId): Promise<void> {
    assertSafeId(id);
    if (await readJson(join(this.root, "retired-rooms", `${id}.json`)))
      throw new Error("Room is retired");
  }
  retire(projectId: ProjectId): Promise<void> {
    assertSafeId(projectId);
    return this.lock.run(projectId, async () => {
      await mkdir(join(this.root, "retired-rooms"), {
        recursive: true,
        mode: 0o700,
      });
      await writeJsonAtomic(
        join(this.root, "retired-rooms", `${projectId}.json`),
        { version: 1, retired: true },
      );
      const rootHandle = await open(this.root, "r");
      try {
        await rootHandle.sync();
      } finally {
        await rootHandle.close();
      }
      await rm(this.dir(projectId), { recursive: true, force: true });
      // A retired room erases optional hosted data even when that feature is now disabled.
      for (const kind of ["crdt", "assets", "history"]) {
        await rm(join(this.root, kind, projectId), {
          recursive: true,
          force: true,
        });
        try {
          const dir = await open(join(this.root, kind), "r");
          try {
            await dir.sync();
          } finally {
            await dir.close();
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    });
  }

  private dir(id: ProjectId): string {
    assertSafeId(id); // gate EVERY FS path on a validated id (no traversal)
    return join(this.root, "crdt", id);
  }
  private updatesDir(id: ProjectId): string {
    return join(this.dir(id), "updates");
  }

  private async syncParents(path: string): Promise<void> {
    const root = resolve(this.root);
    let dir = resolve(dirname(path));
    for (;;) {
      if (dir !== root && !dir.startsWith(root + sep))
        throw new Error("CRDT path outside root");
      const handle = await open(dir, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (dir === root) return;
      const parent = dirname(dir);
      if (parent === dir) throw new Error("CRDT path outside root");
      dir = parent;
    }
  }
  private async atomicBytes(path: string, bytes: Uint8Array): Promise<void> {
    const tmp = `${path}.tmp-${randomUUID()}`;
    try {
      const file = await open(tmp, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tmp, path);
      await this.syncParents(path);
    } finally {
      await rm(tmp, { force: true });
    }
  }
  flush(projectId: ProjectId): Promise<void> {
    return this.lock.run(projectId, async () => {
      await this.assertLive(projectId);
      const dir = this.dir(projectId);
      await mkdir(dir, { recursive: true });
      // Include logs written by older adapters before this stronger barrier existed.
      const paths = [
        join(dir, "snapshot.bin"),
        ...(await this.seqs(projectId)).map((seq) =>
          join(
            this.updatesDir(projectId),
            `${String(seq).padStart(12, "0")}.bin`,
          ),
        ),
      ];
      for (const path of paths) {
        let file;
        try {
          file = await open(path, "r");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        try {
          await file.sync();
        } finally {
          await file.close();
        }
        await this.syncParents(path);
      }
      await this.syncParents(join(dir, "barrier"));
    });
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
      await this.assertLive(projectId);
      const dir = this.updatesDir(projectId);
      await mkdir(dir, { recursive: true });
      const seqs = await this.seqs(projectId);
      const next = (seqs.length === 0 ? -1 : seqs[seqs.length - 1]!) + 1;
      // Zero-pad for tidy listings; parsing is numeric so width is cosmetic.
      const name = `${String(next).padStart(12, "0")}.bin`;
      await this.atomicBytes(join(dir, name), bytes);
    });
  }

  loadUpdates(projectId: ProjectId): Promise<Uint8Array[]> {
    return this.lock.run(projectId, async () => {
      await this.assertLive(projectId);
      return this.loadUpdatesUnlocked(projectId);
    });
  }

  compact(projectId: ProjectId): Promise<void> {
    return this.lock.run(projectId, async () => {
      await this.assertLive(projectId);
      const all = await this.loadUpdatesUnlocked(projectId);
      if (all.length === 0) return;
      const merged = compactUpdates(all);
      const dir = this.dir(projectId);
      await mkdir(dir, { recursive: true });
      // Write the new snapshot atomically, THEN drop the now-folded-in update log.
      const snapPath = join(dir, "snapshot.bin");
      await this.atomicBytes(snapPath, merged);
      await rm(this.updatesDir(projectId), { recursive: true, force: true });
      await this.syncParents(snapPath);
    });
  }

  /** The body of loadUpdates without the lock — for use inside an already-locked op. */
  private async loadUpdatesUnlocked(
    projectId: ProjectId,
  ): Promise<Uint8Array[]> {
    const out: Uint8Array[] = [];
    const snap = await this.readBin(join(this.dir(projectId), "snapshot.bin"));
    if (snap) out.push(snap);
    for (const seq of await this.seqs(projectId)) {
      const u = await this.readBin(
        join(
          this.updatesDir(projectId),
          `${String(seq).padStart(12, "0")}.bin`,
        ),
      );
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
