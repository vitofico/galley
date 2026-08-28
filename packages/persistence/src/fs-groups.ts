/**
 * Filesystem adapter for the `GroupStore` seam (ADR-0029).
 *
 * Mirrors `FsProjectStore` (fs.ts) exactly: one JSON directory per group under a
 * root, a `members.json` role map, a per-id `KeyedMutex` so concurrent same-group
 * mutations can't clobber each other, atomic temp+rename writes, and the shared
 * `SAFE_KEY` traversal gate on every id-keyed path. Must behave identically to
 * `InMemoryGroupStore`; the shared `groupStoreContract` proves that (incl. the
 * reopen durability block over the same root).
 *
 * Layout under `root/`:
 *   groups/<id>/group.json     { id, name }
 *   groups/<id>/members.json   { "<userId>": "<role>" }
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Group, GroupId, GroupMember, GroupRole, GroupStore } from "@galley/shared";
import type { IdGenerator } from "./in-memory.js";
import { KeyedMutex } from "./keyed-mutex.js";

/**
 * Group ids are used as a path segment, so validate before any `path.join` / FS
 * access (same gate + charset as `FsProjectStore`, so a value like `"../../etc"`
 * can't escape the root). Generated ids (`randomUUID`) pass.
 */
const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/;

function assertSafeId(id: string): void {
  if (!SAFE_KEY.test(id)) throw new Error(`illegal group id: ${JSON.stringify(id)}`);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err; // corrupted/unparseable JSON propagates (mirrors FsProjectStore)
  }
}

/** Atomic JSON write: write a temp sibling then rename (no torn reads). */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}

/** Count of members holding the `admin` role (the last-admin invariant hinges on this). */
function adminCount(roles: Record<string, GroupRole>): number {
  let n = 0;
  for (const role of Object.values(roles)) if (role === "admin") n++;
  return n;
}

export class FsGroupStore implements GroupStore {
  private readonly lock = new KeyedMutex();
  constructor(
    private readonly root: string,
    private readonly newId: IdGenerator = () => randomUUID(),
  ) {}

  private dir(id: GroupId): string {
    assertSafeId(id); // gate EVERY FS path on a validated id (no traversal)
    return join(this.root, "groups", id);
  }

  createGroup(name: string, adminUserId: string): Promise<Group> {
    const id = this.newId();
    // Serialize per id so a concurrent same-id create can't both pass the
    // existence check, and so members.json is written before any member op races.
    return this.lock.run(id, async () => {
      const dir = this.dir(id);
      if ((await readJson<Group>(join(dir, "group.json"))) !== null) {
        throw new Error(`group ${id} already exists`);
      }
      await mkdir(dir, { recursive: true });
      const group: Group = { id, name };
      // Membership first, then group.json as the commit marker — so a crash
      // mid-create never leaves a readable group with no admin.
      await writeJsonAtomic(join(dir, "members.json"), { [adminUserId]: "admin" });
      await writeJsonAtomic(join(dir, "group.json"), group);
      return group;
    });
  }

  async getGroup(id: GroupId): Promise<Group | null> {
    return readJson<Group>(join(this.dir(id), "group.json"));
  }

  private async members(id: GroupId): Promise<Record<string, GroupRole>> {
    return (await readJson<Record<string, GroupRole>>(join(this.dir(id), "members.json"))) ?? {};
  }

  addMember(groupId: GroupId, userId: string, role: GroupRole): Promise<void> {
    return this.lock.run(groupId, async () => {
      if ((await this.getGroup(groupId)) === null) throw new Error(`unknown group ${groupId}`);
      const roles = await this.members(groupId);
      // The last-admin invariant: never demote the sole remaining admin to member.
      // OWN-property only (roles is parsed JSON) so a magic userId can't read an
      // inherited value here either.
      if (
        role === "member" &&
        Object.hasOwn(roles, userId) &&
        roles[userId] === "admin" &&
        adminCount(roles) === 1
      ) {
        throw new Error(`cannot demote the last admin of group ${groupId}`);
      }
      roles[userId] = role;
      await writeJsonAtomic(join(this.dir(groupId), "members.json"), roles);
    });
  }

  removeMember(groupId: GroupId, userId: string): Promise<void> {
    return this.lock.run(groupId, async () => {
      const roles = await this.members(groupId);
      if (!Object.hasOwn(roles, userId)) return; // not an own member — no-op (never an inherited key)
      // The last-admin invariant: never remove the sole remaining admin.
      if (roles[userId] === "admin" && adminCount(roles) === 1) {
        throw new Error(`cannot remove the last admin of group ${groupId}`);
      }
      delete roles[userId];
      await writeJsonAtomic(join(this.dir(groupId), "members.json"), roles);
    });
  }

  async getMembership(groupId: GroupId, userId: string): Promise<GroupRole | null> {
    const roles = await this.members(groupId);
    // OWN-property only — see FsProjectStore.getMembership: a magic userId
    // (`__proto__`/`constructor`/`toString`/…) must never resolve an inherited
    // Object.prototype member and forge group access.
    return Object.hasOwn(roles, userId) ? roles[userId] ?? null : null;
  }

  async listMembers(groupId: GroupId): Promise<GroupMember[]> {
    const roles = await this.members(groupId);
    return Object.entries(roles)
      .map(([userId, role]) => ({ userId, role }))
      .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  }

  async listGroupsForUser(userId: string): Promise<Group[]> {
    let ids: string[];
    try {
      ids = await readdir(join(this.root, "groups"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: Group[] = [];
    for (const id of ids.sort()) {
      const roles = await readJson<Record<string, GroupRole>>(join(this.dir(id), "members.json"));
      if (roles && Object.hasOwn(roles, userId)) {
        const g = await this.getGroup(id);
        if (g) out.push(g);
      }
    }
    return out;
  }
}
