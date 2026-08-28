/**
 * In-memory reference implementations of the `@galley/shared` persistence seams
 * (roadmap #4, ADR-0018 §2). These validate the interfaces, drive the
 * auth/authz/server slices in tests, and document expected semantics. The
 * default real adapters (SQLite + filesystem bare-git) land in a later slice and
 * must behave identically.
 *
 * Deterministic: ids come from an injectable generator (default: a monotonic
 * counter), never a clock/RNG — so tests are reproducible.
 */
import { compactUpdates } from "@galley/collab";
import { applyProjectPatch } from "@galley/shared";
import type {
  CrdtStore,
  Group,
  GroupId,
  GroupMember,
  GroupRole,
  GroupStore,
  Project,
  ProjectId,
  ProjectMember,
  ProjectPatch,
  ProjectRole,
  ProjectStore,
  UserId,
  Version,
  VersionedFile,
  VersionStore,
} from "@galley/shared";

/** Monotonic id generator (`${prefix}0`, `${prefix}1`, …). Injectable for tests. */
export type IdGenerator = () => string;
function counter(prefix: string): IdGenerator {
  let n = 0;
  return () => `${prefix}${n++}`;
}

export class InMemoryProjectStore implements ProjectStore {
  private readonly projects = new Map<ProjectId, Project>();
  // projectId -> (userId -> role)
  private readonly members = new Map<ProjectId, Map<UserId, ProjectRole>>();

  constructor(private readonly newId: IdGenerator = counter("proj-")) {}

  async createProject(input: { id?: ProjectId; name: string; ownerId: UserId }): Promise<Project> {
    const id = input.id ?? this.newId();
    if (this.projects.has(id)) throw new Error(`project ${id} already exists`);
    const project: Project = { id, name: input.name, ownerId: input.ownerId };
    this.projects.set(id, project);
    // The owner is a member with role `owner` (so membership checks are uniform).
    this.members.set(id, new Map([[input.ownerId, "owner"]]));
    return project;
  }

  async getProject(id: ProjectId): Promise<Project | null> {
    return this.projects.get(id) ?? null;
  }

  async updateProject(id: ProjectId, patch: ProjectPatch): Promise<Project> {
    const existing = this.projects.get(id);
    if (!existing) throw new Error(`unknown project ${id}`);
    const next = applyProjectPatch(existing, patch);
    this.projects.set(id, next);
    return next;
  }

  async listProjectsForUser(userId: UserId): Promise<Project[]> {
    const out: Project[] = [];
    for (const [pid, roles] of this.members) {
      if (roles.has(userId)) {
        const p = this.projects.get(pid);
        if (p) out.push(p);
      }
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async deleteProject(id: ProjectId): Promise<void> {
    this.projects.delete(id);
    this.members.delete(id);
  }

  async addMember(projectId: ProjectId, userId: UserId, role: ProjectRole): Promise<void> {
    if (!this.projects.has(projectId)) throw new Error(`unknown project ${projectId}`);
    let roles = this.members.get(projectId);
    if (!roles) {
      roles = new Map();
      this.members.set(projectId, roles);
    }
    roles.set(userId, role);
  }

  async removeMember(projectId: ProjectId, userId: UserId): Promise<void> {
    this.members.get(projectId)?.delete(userId);
  }

  async getMembership(projectId: ProjectId, userId: UserId): Promise<ProjectRole | null> {
    return this.members.get(projectId)?.get(userId) ?? null;
  }

  async listMembers(projectId: ProjectId): Promise<ProjectMember[]> {
    const roles = this.members.get(projectId);
    if (!roles) return [];
    return [...roles.entries()]
      .map(([userId, role]) => ({ projectId, userId, role }))
      .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  }
}

/** Count of members holding the `admin` role (the last-admin invariant hinges on this). */
function adminCount(roles: Map<string, GroupRole>): number {
  let n = 0;
  for (const role of roles.values()) if (role === "admin") n++;
  return n;
}

export class InMemoryGroupStore implements GroupStore {
  private readonly groups = new Map<GroupId, Group>();
  // groupId -> (userId -> role)
  private readonly members = new Map<GroupId, Map<string, GroupRole>>();

  constructor(private readonly newId: IdGenerator = counter("group-")) {}

  async createGroup(name: string, adminUserId: string): Promise<Group> {
    const id = this.newId();
    if (this.groups.has(id)) throw new Error(`group ${id} already exists`);
    const group: Group = { id, name };
    this.groups.set(id, group);
    // The creator is the sole admin (a group is never admin-less).
    this.members.set(id, new Map([[adminUserId, "admin"]]));
    return group;
  }

  async getGroup(id: GroupId): Promise<Group | null> {
    return this.groups.get(id) ?? null;
  }

  async addMember(groupId: GroupId, userId: string, role: GroupRole): Promise<void> {
    const roles = this.members.get(groupId);
    if (!this.groups.has(groupId) || !roles) throw new Error(`unknown group ${groupId}`);
    // The last-admin invariant: never demote the sole remaining admin to member.
    if (role === "member" && roles.get(userId) === "admin" && adminCount(roles) === 1) {
      throw new Error(`cannot demote the last admin of group ${groupId}`);
    }
    roles.set(userId, role);
  }

  async removeMember(groupId: GroupId, userId: string): Promise<void> {
    const roles = this.members.get(groupId);
    if (!roles || roles.get(userId) === undefined) return; // not a member — no-op
    // The last-admin invariant: never remove the sole remaining admin.
    if (roles.get(userId) === "admin" && adminCount(roles) === 1) {
      throw new Error(`cannot remove the last admin of group ${groupId}`);
    }
    roles.delete(userId);
  }

  async getMembership(groupId: GroupId, userId: string): Promise<GroupRole | null> {
    return this.members.get(groupId)?.get(userId) ?? null;
  }

  async listMembers(groupId: GroupId): Promise<GroupMember[]> {
    const roles = this.members.get(groupId);
    if (!roles) return [];
    return [...roles.entries()]
      .map(([userId, role]) => ({ userId, role }))
      .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  }

  async listGroupsForUser(userId: string): Promise<Group[]> {
    const out: Group[] = [];
    for (const [gid, roles] of this.members) {
      if (roles.has(userId)) {
        const g = this.groups.get(gid);
        if (g) out.push(g);
      }
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}

export class InMemoryCrdtStore implements CrdtStore {
  // projectId -> { snapshot, tail }
  private readonly logs = new Map<ProjectId, { snapshot: Uint8Array | null; tail: Uint8Array[] }>();

  private entry(projectId: ProjectId) {
    let e = this.logs.get(projectId);
    if (!e) {
      e = { snapshot: null, tail: [] };
      this.logs.set(projectId, e);
    }
    return e;
  }

  async appendUpdate(projectId: ProjectId, update: Uint8Array): Promise<void> {
    // Defensively copy so a caller mutating the buffer later can't corrupt the log.
    this.entry(projectId).tail.push(update.slice());
  }

  async loadUpdates(projectId: ProjectId): Promise<Uint8Array[]> {
    const e = this.logs.get(projectId);
    if (!e) return [];
    // Copy on the way OUT too — a caller mutating a returned buffer must not
    // corrupt the log (the fs adapter re-reads from disk, so it's immune; the
    // reference impl must match). Contract: crdt-store.contract.ts.
    const all = e.snapshot === null ? e.tail : [e.snapshot, ...e.tail];
    return all.map((u) => u.slice());
  }

  async compact(projectId: ProjectId): Promise<void> {
    const e = this.logs.get(projectId);
    if (!e) return;
    const all = e.snapshot === null ? e.tail : [e.snapshot, ...e.tail];
    if (all.length === 0) return;
    e.snapshot = compactUpdates(all);
    e.tail = [];
  }
}

export class InMemoryVersionStore implements VersionStore {
  // projectId -> versions; versionId -> tree
  private readonly versions = new Map<ProjectId, Version[]>();
  private readonly trees = new Map<string, VersionedFile[]>();

  constructor(private readonly newId: IdGenerator = counter("ver-")) {}

  async createVersion(
    projectId: ProjectId,
    // `author` (#12) is accepted for seam parity but not persisted: the in-memory
    // store keeps the public `Version` shape (no commit object to stamp).
    input: {
      name: string;
      message?: string;
      contributors?: string[];
      author?: { name: string; email: string };
    },
    tree: VersionedFile[],
  ): Promise<Version> {
    const id = this.newId();
    // Additive parity (#11): contributors stored only when non-empty (absent = unknown).
    const version: Version = {
      id,
      projectId,
      name: input.name,
      ...(input.message !== undefined ? { message: input.message } : {}),
      ...(input.contributors !== undefined && input.contributors.length > 0
        ? { contributors: input.contributors }
        : {}),
    };
    const list = this.versions.get(projectId) ?? [];
    list.push(version);
    this.versions.set(projectId, list);
    // Copy the tree so later mutation of the source can't change a stored version.
    this.trees.set(
      id,
      tree.map((f) => ({ ...f })),
    );
    return version;
  }

  async listVersions(projectId: ProjectId): Promise<Version[]> {
    return [...(this.versions.get(projectId) ?? [])];
  }

  async getVersionTree(versionId: string): Promise<VersionedFile[] | null> {
    const t = this.trees.get(versionId);
    return t ? t.map((f) => ({ ...f })) : null;
  }
}
