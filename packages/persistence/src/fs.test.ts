/**
 * Roadmap #4 slice 3a: the filesystem persistence adapters. Same contracts as the
 * in-memory impls, now over real files in a temp dir. The CRDT log semantics
 * (append/compact/load round-trips, buffer copying, concurrency, isolation) are
 * proven by the shared `crdtStoreContract`, which also exercises the durability
 * block here (a fresh store instance over the same root — a "restart" — reads
 * back the persisted state). Only the genuinely fs-specific behavior (path
 * traversal gating, on-disk project layout) stays as local tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsProjectStore, FsCrdtStore } from "./index.js";
import { crdtStoreContract } from "./crdt-store.contract.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "galley-persist-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("FsProjectStore", () => {
  it("persists projects + membership across a 'restart' (new instance, same root)", async () => {
    const s1 = new FsProjectStore(root);
    const p = await s1.createProject({ id: "proj-1", name: "Thesis", ownerId: "alice" });
    await s1.addMember(p.id, "bob", "editor");

    const s2 = new FsProjectStore(root); // simulate a process restart
    expect(await s2.getProject("proj-1")).toEqual(p);
    expect(await s2.getMembership("proj-1", "alice")).toBe("owner");
    expect(await s2.getMembership("proj-1", "bob")).toBe("editor");
    expect((await s2.listProjectsForUser("bob")).map((x) => x.id)).toEqual(["proj-1"]);
  });

  it("lists only a user's projects; removes members; rejects dup id / unknown project", async () => {
    const s = new FsProjectStore(root);
    await s.createProject({ id: "a", name: "A", ownerId: "alice" });
    const b = await s.createProject({ id: "b", name: "B", ownerId: "bob" });
    await s.addMember(b.id, "alice", "viewer");
    await s.createProject({ id: "c", name: "C", ownerId: "carol" });

    expect((await s.listProjectsForUser("alice")).map((p) => p.id)).toEqual(["a", "b"]);
    await s.removeMember("b", "alice");
    expect(await s.getMembership("b", "alice")).toBeNull();

    await expect(s.createProject({ id: "a", name: "dup", ownerId: "alice" })).rejects.toThrow();
    await expect(s.addMember("nope", "x", "editor")).rejects.toThrow();
  });

  it("deleteProject removes it (and it no longer lists)", async () => {
    const s = new FsProjectStore(root);
    await s.createProject({ id: "p", name: "P", ownerId: "alice" });
    await s.deleteProject("p");
    expect(await s.getProject("p")).toBeNull();
    expect(await s.listProjectsForUser("alice")).toEqual([]);
  });

  it("rejects an illegal project id (path traversal) but accepts a normal UUID", async () => {
    const s = new FsProjectStore(root);
    // An attacker-controlled id that would escape the root via path.join must be
    // refused before any FS access — across every id-keyed entry point.
    const evil = "../../etc";
    await expect(s.getMembership(evil, "alice")).rejects.toThrow(/illegal project id/);
    await expect(s.getProject(evil)).rejects.toThrow(/illegal project id/);
    await expect(s.createProject({ id: evil, name: "X", ownerId: "alice" })).rejects.toThrow(
      /illegal project id/,
    );

    // A legitimate UUID passes through unaffected.
    const uuid = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    const p = await s.createProject({ id: uuid, name: "Ok", ownerId: "alice" });
    expect(p.id).toBe(uuid);
    expect(await s.getMembership(uuid, "alice")).toBe("owner");
  });

  it("listProjectsForUser is [] before any project exists (no projects dir yet)", async () => {
    expect(await new FsProjectStore(root).listProjectsForUser("alice")).toEqual([]);
  });

  // Prototype-pollution guard (security round finding 1, HIGH). The role map is
  // parsed JSON, so a userId like `__proto__`/`constructor`/`toString` would
  // resolve via Object.prototype to a truthy inherited member and forge access.
  // This is FS-BACKED on purpose: the in-memory store is Map-backed (no prototype
  // chain) and cannot exhibit the bug, so only a real disk store proves the fix.
  it("getMembership never resolves an inherited Object.prototype key (no forged membership)", async () => {
    const s = new FsProjectStore(root);
    await s.createProject({ id: "proj-1", name: "P", ownerId: "alice" });
    for (const magic of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
      // Existing project, magic non-member id → null (not a function/object).
      expect(await s.getMembership("proj-1", magic), magic).toBeNull();
      // Non-existent project, magic id → still null (the pre-fix bug returned truthy for ANY project).
      expect(await s.getMembership("no-such-project", magic), magic).toBeNull();
      // Enumeration is not forged either.
      expect(await s.listProjectsForUser(magic), magic).toEqual([]);
    }
    // A genuine member is unaffected.
    expect(await s.getMembership("proj-1", "alice")).toBe("owner");
  });
});

// The shared CrdtStore semantics — incl. the reopen durability block (a fresh
// instance over the same root simulates a process restart). The factory runs
// inside each test, after `beforeEach` minted this test's `root`, and the
// file-level `afterEach` removes it.
crdtStoreContract("FsCrdtStore", async () => ({
  store: new FsCrdtStore(root),
  reopen: async () => new FsCrdtStore(root),
}));

describe("FsCrdtStore (fs-specific)", () => {
  it("rejects an illegal project id (path traversal) on every entry point", async () => {
    // Same gate as FsProjectStore: an attacker-controlled ws room id must be
    // refused before any FS access so it can't escape the root via path.join.
    const store = new FsCrdtStore(root);
    const evil = "../../etc";
    await expect(store.appendUpdate(evil, new Uint8Array([1]))).rejects.toThrow(/illegal project id/);
    await expect(store.loadUpdates(evil)).rejects.toThrow(/illegal project id/);
    await expect(store.compact(evil)).rejects.toThrow(/illegal project id/);
  });
});
