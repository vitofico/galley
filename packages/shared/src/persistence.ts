/**
 * Persistence seam contracts (roadmap #4, ADR-0018 §2).
 *
 * Types only — the adapters (in-memory for tests, SQLite + filesystem bare-git by
 * default, Postgres later) live in `@galley/persistence`, never here. The CRDT is
 * the source of truth; these stores persist its update log + snapshots, the
 * projects/membership around it, and named versions materialized to a git tree.
 */
import type { GroupId, GroupRole } from "./groups.js";

/** A user identity. In no-auth local mode this is a stable local-profile id; under OIDC it's the subject. */
export type UserId = string;
export type ProjectId = string;

/** Membership role at a project (the `Authorizer` seam checks this). */
export type ProjectRole = "owner" | "editor" | "viewer";

/**
 * Authorization decision at a service edge (the sync ws upgrade, later proxy/
 * compile). Cores stay auth-agnostic; an adapter implements this against
 * `ProjectStore` membership. Roadmap #4, ADR-0018 §4.
 */
export interface Authorizer {
  canAccessProject(userId: UserId, projectId: ProjectId): Promise<boolean>;
}

/**
 * The result of a service-authenticated membership read (Wave 13 cloud enabler:
 * `GET /internal/projects/:projectId/membership/:userId`). It re-expresses the
 * boolean `projectOrGroupMembershipAuthorizer` decision as the WHY behind it:
 *   - `{ source: "project"; role }` — a DIRECT project membership (wins outright);
 *   - `{ source: "group";   role }` — access INHERITED from the owning group
 *     (`Project.ownerGroupId`), when the user is not a direct member;
 *   - `null` — not a member. An unknown project is INDISTINGUISHABLE from a
 *     non-member (both `null`): the endpoint is deliberately NOT a project-
 *     existence oracle.
 *
 * This is a cross-package WIRE contract — the JSON body is `{ membership: … }` —
 * consumed by the private cloud control plane's project-access reader. Keep it in
 * lockstep with that consumer.
 */
export type MembershipReadResult =
  | { source: "project"; role: ProjectRole }
  | { source: "group"; role: GroupRole }
  | null;

export interface Project {
  id: ProjectId;
  name: string;
  ownerId: UserId;
  /**
   * Optional library metadata (roadmap #12.2). ALL additive/optional so the
   * server adapters and every existing test stay byte-for-byte: a row written
   * before these existed simply lacks them (absent = `undefined`; no migration).
   * Timestamps are epoch milliseconds. `tags` are free-form labels (the Overleaf
   * flat model); `archived` is a soft-delete flag (never a CRDT destroy).
   */
  tags?: string[];
  archived?: boolean;
  createdAt?: number;
  updatedAt?: number;
  lastOpenedAt?: number;
  /**
   * The group that OWNS this project (ADR-0029). When set, every member of that
   * group can access the project via `projectOrGroupMembershipAuthorizer` (in
   * addition to the project's own members). ADDITIVE/optional — a project written
   * before groups existed simply lacks it (absent = personally-owned, no group;
   * no migration). Assigning group ownership is a deliberate, authorization-relevant
   * mutation, so it rides the standard metadata patch (`ProjectPatch`).
   */
  ownerGroupId?: GroupId;
}

/**
 * A patch of MUTABLE project metadata for `ProjectStore.updateProject` (roadmap
 * #12.2). Identity fields (`id`/`ownerId`) are immutable and not patchable. Only
 * the keys PRESENT on the patch are written; an absent key leaves the stored
 * value untouched (so a partial update never clears unrelated fields). Passing a
 * key as `undefined` is treated as "not present" (exactOptionalPropertyTypes).
 */
export interface ProjectPatch {
  name?: string;
  tags?: string[];
  archived?: boolean;
  createdAt?: number;
  updatedAt?: number;
  lastOpenedAt?: number;
  ownerGroupId?: GroupId;
}

/**
 * Apply a `ProjectPatch` to a project, copying only the patch's DEFINED keys
 * (so an absent/`undefined` key never overwrites a stored value, and the result
 * has no `key: undefined` slots under exactOptionalPropertyTypes). Pure — the
 * single merge rule shared by every `ProjectStore` adapter.
 */
export function applyProjectPatch(project: Project, patch: ProjectPatch): Project {
  const next: Project = { ...project };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.tags !== undefined) next.tags = patch.tags;
  if (patch.archived !== undefined) next.archived = patch.archived;
  if (patch.createdAt !== undefined) next.createdAt = patch.createdAt;
  if (patch.updatedAt !== undefined) next.updatedAt = patch.updatedAt;
  if (patch.lastOpenedAt !== undefined) next.lastOpenedAt = patch.lastOpenedAt;
  if (patch.ownerGroupId !== undefined) next.ownerGroupId = patch.ownerGroupId;
  return next;
}

export interface ProjectMember {
  projectId: ProjectId;
  userId: UserId;
  role: ProjectRole;
}

/** A file in a materialized version tree (structurally matches collab's `MaterializedFile`). */
export interface VersionedFile {
  path: string;
  text: string;
}

/**
 * Is a canonical project file path safe to *materialize to disk* (roadmap #4,
 * ADR-0018)? Project paths are user-controlled (file create/rename), and the
 * version stores write them into real directories — so a path must be a clean,
 * leading-slash, in-tree path: no empty/`.`/`..` segments (traversal), no
 * backslash/NUL/control chars, and not under the reserved `/.galley` namespace
 * (where the `project.json` manifest lives). The projection (`materializeProject`)
 * fails closed on an unsafe path, and the version store containment-checks again.
 */
export function isSafeProjectPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  const segments = path.split("/");
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i] as string;
    if (seg === "" || seg === "." || seg === "..") return false;
    if (seg.includes("\\")) return false;
    for (let j = 0; j < seg.length; j++) {
      const code = seg.charCodeAt(j);
      if (code <= 0x1f || code === 0x7f) return false;
    }
  }
  if (segments[1] === ".galley") return false; // reserved (the manifest namespace)
  return true;
}

/**
 * Is a path in the project's RESERVED `.galley` namespace (roadmap 14-D)? True
 * iff the path's first segment is `.galley`, in EITHER the canonical
 * leading-slash form (`/.galley/instructions`) or the relative materialized form
 * (`.galley/instructions`). The `.galley/` tree holds internal config — the
 * `project.json` manifest and the agent-steering `instructions` file — which is
 * CRDT-local: it is never materialized as a user tree file (the projection
 * filters it out) and never shown in the document file tree.
 *
 * This is distinct from `isSafeProjectPath`, which fails closed on `.galley`
 * (a reserved path is NOT safe to materialize as a user file) AND on genuinely
 * unsafe paths (traversal, control chars). `materializeProject` filters reserved
 * paths out BEFORE the safety gate; the safety gate still rejects everything else.
 */
export function isReservedProjectPath(path: string): boolean {
  const trimmed = path.startsWith("/") ? path.slice(1) : path;
  const first = trimmed.split("/")[0];
  return first === ".galley";
}

export interface Version {
  id: string;
  projectId: ProjectId;
  name: string;
  message?: string;
  /**
   * Author-attributed versioning (roadmap #11): the DISTINCT display labels of
   * everyone who has contributed to the project state captured by this snapshot
   * (v1 = the union of registered authors at snapshot time, not a per-snapshot
   * diff). ADDITIVE/optional — a version written before this existed simply lacks
   * the field (absent = unknown; renders as nothing, no migration).
   */
  contributors?: string[];
}

/** Project CRUD + membership. Creating a project makes its owner a member with role `owner`. */
export interface ProjectStore {
  createProject(input: { id?: ProjectId; name: string; ownerId: UserId }): Promise<Project>;
  getProject(id: ProjectId): Promise<Project | null>;
  /**
   * Patch a project's mutable metadata (name/tags/archived/timestamps; roadmap
   * #12.2). Returns the updated project; rejects if the project is unknown.
   * Only the patch's defined keys are written (see `applyProjectPatch`).
   */
  updateProject(id: ProjectId, patch: ProjectPatch): Promise<Project>;
  listProjectsForUser(userId: UserId): Promise<Project[]>;
  deleteProject(id: ProjectId): Promise<void>;
  addMember(projectId: ProjectId, userId: UserId, role: ProjectRole): Promise<void>;
  removeMember(projectId: ProjectId, userId: UserId): Promise<void>;
  getMembership(projectId: ProjectId, userId: UserId): Promise<ProjectRole | null>;
  listMembers(projectId: ProjectId): Promise<ProjectMember[]>;
}

/**
 * The Yjs update log + snapshots for one project's CRDT doc. `loadUpdates` returns
 * the compacted snapshot (if any) followed by the appended tail, in apply order —
 * feed it straight to `restoreDoc`. `compact` bounds log growth.
 */
export interface CrdtStore {
  appendUpdate(projectId: ProjectId, update: Uint8Array): Promise<void>;
  loadUpdates(projectId: ProjectId): Promise<Uint8Array[]>;
  compact(projectId: ProjectId): Promise<void>;
}

/**
 * Named versions, each materialized to a git-shaped tree (from `materializeProject`).
 * The bare-git adapter commits the tree; the in-memory one just keeps it.
 */
export interface VersionStore {
  createVersion(
    projectId: ProjectId,
    /**
     * The version's metadata. `author` (roadmap #12, authored commits) is the
     * saver's real identity, stamped as the git commit author so downstream
     * `git blame` attributes work to a person; ADDITIVE/optional — when absent the
     * git store falls back to its `galley@localhost` default (byte-for-byte the old
     * behavior) and the in-memory/idb stores simply ignore it.
     */
    input: {
      name: string;
      message?: string;
      contributors?: string[];
      author?: { name: string; email: string };
    },
    tree: VersionedFile[],
  ): Promise<Version>;
  listVersions(projectId: ProjectId): Promise<Version[]>;
  getVersionTree(versionId: string): Promise<VersionedFile[] | null>;
}
