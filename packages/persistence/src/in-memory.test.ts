/**
 * Roadmap #4 slice 2b: the persistence seams + their in-memory reference impls.
 * Proves the contracts (project CRUD + membership; named versions over a
 * materialized tree) — all offline, deterministic. The CRDT log semantics
 * (append/compact/load round-trips through the real snapshot core, buffer
 * copying, concurrency, isolation) are proven by the shared `crdtStoreContract`;
 * its reopen durability block is skipped here (no persistent backing).
 */
import { describe, it, expect } from "vitest";
import { applyProjectPatch } from "@galley/shared";
import type { Project } from "@galley/shared";
import {
  InMemoryProjectStore,
  InMemoryGroupStore,
  InMemoryCrdtStore,
  InMemoryVersionStore,
} from "./index.js";
import { crdtStoreContract } from "./crdt-store.contract.js";
import { groupStoreContract } from "./group-store.contract.js";

describe("InMemoryProjectStore", () => {
  it("creates a project and makes the owner an 'owner' member", async () => {
    const s = new InMemoryProjectStore();
    const p = await s.createProject({ name: "Thesis", ownerId: "alice" });
    expect(p.id).toBe("proj-0");
    expect(await s.getProject(p.id)).toEqual(p);
    expect(await s.getMembership(p.id, "alice")).toBe("owner");
  });

  it("lists projects a user is a member of (not others)", async () => {
    const s = new InMemoryProjectStore();
    const a = await s.createProject({ name: "A", ownerId: "alice" });
    const b = await s.createProject({ name: "B", ownerId: "bob" });
    await s.addMember(b.id, "alice", "editor");
    const c = await s.createProject({ name: "C", ownerId: "carol" });

    const alices = await s.listProjectsForUser("alice");
    expect(alices.map((p) => p.id)).toEqual([a.id, b.id]);
    expect(alices.map((p) => p.id)).not.toContain(c.id);
  });

  it("adds/removes members and reads membership + roles", async () => {
    const s = new InMemoryProjectStore();
    const p = await s.createProject({ name: "P", ownerId: "alice" });
    await s.addMember(p.id, "bob", "viewer");
    expect(await s.getMembership(p.id, "bob")).toBe("viewer");
    expect((await s.listMembers(p.id)).map((m) => `${m.userId}:${m.role}`)).toEqual([
      "alice:owner",
      "bob:viewer",
    ]);
    await s.removeMember(p.id, "bob");
    expect(await s.getMembership(p.id, "bob")).toBeNull();
  });

  it("rejects a duplicate project id and a member on an unknown project", async () => {
    const s = new InMemoryProjectStore();
    await s.createProject({ id: "fixed", name: "P", ownerId: "alice" });
    await expect(s.createProject({ id: "fixed", name: "X", ownerId: "alice" })).rejects.toThrow();
    await expect(s.addMember("nope", "bob", "editor")).rejects.toThrow();
  });

  it("patches mutable metadata, leaving unpatched fields untouched (#12.2)", async () => {
    const s = new InMemoryProjectStore();
    const p = await s.createProject({ name: "Thesis", ownerId: "alice" });
    // A patch writes only its defined keys; the rest are preserved.
    const t1 = await s.updateProject(p.id, { tags: ["draft", "physics"], createdAt: 100 });
    expect(t1).toMatchObject({ id: p.id, name: "Thesis", ownerId: "alice", tags: ["draft", "physics"], createdAt: 100 });
    // A second patch touches a different field; tags/createdAt survive.
    const t2 = await s.updateProject(p.id, { archived: true, updatedAt: 200 });
    expect(t2.tags).toEqual(["draft", "physics"]);
    expect(t2.createdAt).toBe(100);
    expect(t2.archived).toBe(true);
    expect(t2.updatedAt).toBe(200);
    // Persisted, not just returned.
    expect(await s.getProject(p.id)).toEqual(t2);
    // Identity (id/ownerId) is never mutated; name patch works.
    const t3 = await s.updateProject(p.id, { name: "Final" });
    expect(t3.name).toBe("Final");
    expect(t3.ownerId).toBe("alice");
    expect(t3.archived).toBe(true); // unrelated field still intact
  });

  it("updateProject rejects an unknown project", async () => {
    const s = new InMemoryProjectStore();
    await expect(s.updateProject("nope", { archived: true })).rejects.toThrow();
  });
});

// The shared CrdtStore semantics; no `reopen` (nothing outlives the instance),
// so the contract's durability block is skipped.
crdtStoreContract("InMemoryCrdtStore", async () => ({ store: new InMemoryCrdtStore() }));

// The shared GroupStore semantics (ADR-0029); no `reopen` (in-memory), so the
// contract's durability block is skipped.
groupStoreContract("InMemoryGroupStore", async () => ({ store: new InMemoryGroupStore() }));

// ADR-0029 is strictly additive: a project that never touches a group must be
// byte-for-byte what it was before `ownerGroupId` existed (no new key, no JSON
// slot) — so existing self-hoster on-disk state and every server adapter are
// untouched. The field only appears when a patch explicitly sets it.
describe("groups are additive: a group-less project is byte-for-byte unchanged", () => {
  it("createProject writes no ownerGroupId key when no group is involved", async () => {
    const s = new InMemoryProjectStore();
    const p = await s.createProject({ name: "Solo", ownerId: "alice" });
    expect("ownerGroupId" in p).toBe(false);
    expect(Object.keys(p).sort()).toEqual(["id", "name", "ownerId"]);
    expect(JSON.stringify(p)).not.toContain("ownerGroupId"); // on-disk projection carries no slot
  });

  it("applyProjectPatch never introduces an ownerGroupId key for a group-less patch", () => {
    const p: Project = { id: "p", name: "Solo", ownerId: "alice" };
    const patched = applyProjectPatch(p, { name: "Renamed", tags: ["x"] });
    expect("ownerGroupId" in patched).toBe(false);
    expect(JSON.stringify(patched)).not.toContain("ownerGroupId");
  });

  it("only writes ownerGroupId when a patch explicitly sets it (opt-in group ownership)", async () => {
    const s = new InMemoryProjectStore(() => "p1");
    await s.createProject({ name: "P", ownerId: "alice" });
    const updated = await s.updateProject("p1", { ownerGroupId: "g1" });
    expect(updated.ownerGroupId).toBe("g1");
    expect(await s.getProject("p1")).toMatchObject({ ownerGroupId: "g1" });
  });
});

describe("InMemoryVersionStore", () => {
  it("stores a materialized tree under a named version and reads it back", async () => {
    const vs = new InMemoryVersionStore();
    const tree = [
      { path: "main.typ", text: "= Title" },
      { path: ".galley/project.json", text: "{}" },
    ];
    const v = await vs.createVersion("p1", { name: "v1", message: "first" }, tree);
    expect(v).toEqual({ id: "ver-0", projectId: "p1", name: "v1", message: "first" });
    expect(await vs.getVersionTree(v.id)).toEqual(tree);
    expect((await vs.listVersions("p1")).map((x) => x.name)).toEqual(["v1"]);
  });

  it("copies the tree so later source mutation can't change a stored version", async () => {
    const vs = new InMemoryVersionStore();
    const tree = [{ path: "a.typ", text: "orig" }];
    const v = await vs.createVersion("p1", { name: "v1" }, tree);
    tree[0]!.text = "mutated";
    expect((await vs.getVersionTree(v.id))![0]!.text).toBe("orig");
  });

  it("returns null for an unknown version and [] for a project with none", async () => {
    const vs = new InMemoryVersionStore();
    expect(await vs.getVersionTree("nope")).toBeNull();
    expect(await vs.listVersions("p1")).toEqual([]);
  });

  it("accepts an `author` input (#12) without changing the public Version shape", async () => {
    const vs = new InMemoryVersionStore();
    const v = await vs.createVersion(
      "p1",
      { name: "v1", author: { name: "Ada", email: "ada@users.galley.local" } },
      [{ path: "a.typ", text: "x" }],
    );
    // author is accepted but not persisted — the Version is unchanged.
    expect(v).toEqual({ id: "ver-0", projectId: "p1", name: "v1" });
  });

  it("accepts a materialized tree shape from the projection core (structural fit)", async () => {
    // A materializeProject tree ({path,text}[]) flows in structurally, no adapter.
    const vs = new InMemoryVersionStore();
    const v = await vs.createVersion("p", { name: "snap" }, [{ path: "main.typ", text: "x" }]);
    expect((await vs.getVersionTree(v.id))?.[0]?.path).toBe("main.typ");
  });
});
