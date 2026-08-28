/**
 * Roadmap #4 slice 5: the membership-backed Authorizer. Any project member (any
 * role) may access; non-members and unknown projects are denied.
 */
import { describe, it, expect, vi } from "vitest";
import {
  InMemoryProjectStore,
  InMemoryGroupStore,
  membershipAuthorizer,
  projectOrGroupMembershipAuthorizer,
} from "./index.js";

describe("membershipAuthorizer", () => {
  it("permits members (incl. the owner) and denies non-members / unknown projects", async () => {
    const store = new InMemoryProjectStore(() => "p1");
    await store.createProject({ name: "P", ownerId: "alice" });
    const authz = membershipAuthorizer(store);

    expect(await authz.canAccessProject("alice", "p1")).toBe(true); // owner is a member
    expect(await authz.canAccessProject("bob", "p1")).toBe(false);

    await store.addMember("p1", "bob", "viewer");
    expect(await authz.canAccessProject("bob", "p1")).toBe(true); // any role suffices

    expect(await authz.canAccessProject("alice", "missing")).toBe(false);
  });
});

describe("projectOrGroupMembershipAuthorizer", () => {
  // A project p1 (direct owner: alice) OWNED by group g1 (admin: carol, member: erin).
  async function setup() {
    const projects = new InMemoryProjectStore(() => "p1");
    await projects.createProject({ name: "P", ownerId: "alice" });
    const groups = new InMemoryGroupStore(() => "g1");
    await groups.createGroup("Lab", "carol");
    await groups.addMember("g1", "erin", "member");
    await projects.updateProject("p1", { ownerGroupId: "g1" });
    return { projects, groups };
  }

  it("allows a direct project member WITHOUT consulting the group store (short-circuit)", async () => {
    const { projects, groups } = await setup();
    const spy = vi.spyOn(groups, "getMembership");
    const authz = projectOrGroupMembershipAuthorizer(projects, groups);
    expect(await authz.canAccessProject("alice", "p1")).toBe(true); // alice is the direct owner
    expect(spy).not.toHaveBeenCalled(); // never asked the group store
  });

  it("allows admins AND members of the owning group (access, not administration)", async () => {
    const { projects, groups } = await setup();
    expect(await groups.getMembership("g1", "carol")).toBe("admin");
    expect(await groups.getMembership("g1", "erin")).toBe("member");
    const authz = projectOrGroupMembershipAuthorizer(projects, groups);
    expect(await authz.canAccessProject("carol", "p1")).toBe(true); // group admin
    expect(await authz.canAccessProject("erin", "p1")).toBe(true); // group member
  });

  it("denies a user who is neither a project member nor in the owning group", async () => {
    const { projects, groups } = await setup();
    const authz = projectOrGroupMembershipAuthorizer(projects, groups);
    expect(await authz.canAccessProject("dave", "p1")).toBe(false);
  });

  it("denies an unknown project", async () => {
    const { projects, groups } = await setup();
    const authz = projectOrGroupMembershipAuthorizer(projects, groups);
    expect(await authz.canAccessProject("carol", "missing")).toBe(false);
  });

  it("denies when the project has no owning group and the user isn't a direct member", async () => {
    const projects = new InMemoryProjectStore(() => "p2");
    await projects.createProject({ name: "Solo", ownerId: "alice" }); // no ownerGroupId
    const groups = new InMemoryGroupStore(() => "g9");
    await groups.createGroup("Other", "carol");
    const authz = projectOrGroupMembershipAuthorizer(projects, groups);
    expect(await authz.canAccessProject("alice", "p2")).toBe(true); // direct owner
    expect(await authz.canAccessProject("carol", "p2")).toBe(false); // no group link to p2
  });

  it("fails closed: a project-store error denies rather than propagating", async () => {
    const { projects, groups } = await setup();
    vi.spyOn(projects, "getMembership").mockRejectedValue(new Error("db down"));
    const authz = projectOrGroupMembershipAuthorizer(projects, groups);
    await expect(authz.canAccessProject("alice", "p1")).resolves.toBe(false);
  });

  it("fails closed: a group-store error denies rather than propagating", async () => {
    const { projects, groups } = await setup();
    // dave is not a direct member, so the authorizer reaches the group store.
    vi.spyOn(groups, "getMembership").mockRejectedValue(new Error("group store down"));
    const authz = projectOrGroupMembershipAuthorizer(projects, groups);
    await expect(authz.canAccessProject("dave", "p1")).resolves.toBe(false);
  });
});
