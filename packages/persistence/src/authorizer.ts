/**
 * Membership-backed `Authorizer` (roadmap #4 slice 5, ADR-0018 §4). Any project
 * member (any role) may access the project's collaboration room; finer
 * role-gating (e.g. viewer = read-only) is a later refinement. Cores stay
 * auth-agnostic — this adapter bridges the `Authorizer` seam to `ProjectStore`.
 */
import type { Authorizer, GroupStore, ProjectStore } from "@galley/shared";

export function membershipAuthorizer(store: ProjectStore): Authorizer {
  return {
    canAccessProject: async (userId, projectId) =>
      (await store.getMembership(projectId, userId)) !== null,
  };
}

/**
 * Group-aware `Authorizer` (ADR-0029): access is granted to a project's own
 * members OR to any member of the group that OWNS it (`Project.ownerGroupId`).
 * BOTH stores are required so the (cloud) consumer wires an unmistakably
 * group-aware function — `membershipAuthorizer` above stays the untouched,
 * project-only path.
 *
 * Semantics:
 * - **Direct project membership short-circuits** — checked first; when the user is
 *   already a project member the group store is never consulted.
 * - Otherwise, if the project exists AND has an `ownerGroupId`, allow iff the user
 *   is a member (any role — `admin` or `member`) of that group.
 * - Unknown project ⇒ deny. A project with no owning group ⇒ deny (for a non-member).
 * - **Fail closed:** any store error denies (returns `false`) rather than
 *   propagating. This is a deliberately stronger posture than
 *   `membershipAuthorizer` (which lets a store error propagate): a composing
 *   authorizer touches two stores at the ws-upgrade edge, and a group-store hiccup
 *   must deny access, never crash the upgrade or fail open.
 */
export function projectOrGroupMembershipAuthorizer(
  projects: ProjectStore,
  groups: GroupStore,
): Authorizer {
  return {
    canAccessProject: async (userId, projectId) => {
      try {
        // Direct membership wins outright — never consult the group store for a member.
        if ((await projects.getMembership(projectId, userId)) !== null) return true;
        const ownerGroupId = (await projects.getProject(projectId))?.ownerGroupId;
        if (ownerGroupId === undefined) return false; // unknown project or no owning group
        return (await groups.getMembership(ownerGroupId, userId)) !== null;
      } catch {
        return false; // fail closed on any store error
      }
    },
  };
}
