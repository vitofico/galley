/**
 * Minimal Group primitive (ADR-0029).
 *
 * A `Group` is a named set of users with a two-role membership (`admin` |
 * `member`), and a project may be OWNED by a group (`Project.ownerGroupId`) so
 * that every group member can reach it. This is the smallest shape a private
 * downstream (galley-cloud Organizations) — and an AGPL self-hoster running a
 * shared lab — can build richer team models on top of. It is deliberately
 * additive and default-absent: nothing in galley references a cloud concept, and
 * a deployment that never creates a group behaves byte-for-byte as before.
 *
 * Types only — the adapters (in-memory + filesystem) live in `@galley/persistence`,
 * never here (mirrors the `ProjectStore` split in `./persistence.ts`).
 */

/** A group identity. Structurally a `UserId`/`ProjectId` — an opaque string id. */
export type GroupId = string;

/**
 * Membership role at a group. `admin` may administer the group (add/remove
 * members, promote/demote); `member` belongs to it (and so can reach the group's
 * projects) but does not administer it. The group-aware `Authorizer` treats BOTH
 * as "can access the group's projects" — role gates administration, not access.
 */
export type GroupRole = "admin" | "member";

/** A group: an id and a display name. Membership lives in the store, not here. */
export interface Group {
  id: GroupId;
  name: string;
}

/** One user's membership in a group (as returned by `listMembers`). */
export interface GroupMember {
  userId: string;
  role: GroupRole;
}

/**
 * Group CRUD + membership, modeled on `ProjectStore` (same per-id conventions in
 * every adapter). Invariants pinned by the conformance contract
 * (`group-store.contract.ts`):
 *
 * - **A group always has at least one admin.** `createGroup` seeds its creator as
 *   `admin`, and the store REFUSES any mutation that would leave the group
 *   admin-less: removing the last admin (`removeMember`) and demoting the last
 *   admin to `member` (`addMember`) both reject.
 * - **`addMember` upserts.** Adding an already-present member updates their role
 *   (it never duplicates), subject to the last-admin rule above.
 * - **Unknown group ⇒ null/empty, never throw** for the read paths (`getGroup`,
 *   `getMembership`, `listMembers`, `listGroupsForUser`) and a no-op for
 *   `removeMember`. `addMember` to an unknown group rejects (mirrors
 *   `ProjectStore.addMember`).
 */
export interface GroupStore {
  /** Create a group; its creator becomes the sole `admin` (a group is never admin-less). */
  createGroup(name: string, adminUserId: string): Promise<Group>;
  getGroup(id: GroupId): Promise<Group | null>;
  /** Add or re-role a member. Rejects an unknown group or demoting the last admin. */
  addMember(groupId: GroupId, userId: string, role: GroupRole): Promise<void>;
  /** Remove a member. No-op if absent; rejects removing the last admin. */
  removeMember(groupId: GroupId, userId: string): Promise<void>;
  getMembership(groupId: GroupId, userId: string): Promise<GroupRole | null>;
  listMembers(groupId: GroupId): Promise<GroupMember[]>;
  listGroupsForUser(userId: string): Promise<Group[]>;
}
