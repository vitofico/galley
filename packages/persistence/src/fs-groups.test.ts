/**
 * The filesystem `GroupStore` adapter (ADR-0029). The full CRUD/roles/last-admin
 * semantics are proven by the shared `groupStoreContract` — invoked here with a
 * `reopen` hook (a fresh instance over the same root simulates a process restart,
 * exercising the durability block). Only the genuinely fs-specific behavior (path
 * traversal gating, corrupted on-disk JSON) stays as local tests, mirroring
 * `FsProjectStore`'s posture in fs.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsGroupStore } from "./index.js";
import { groupStoreContract } from "./group-store.contract.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "galley-groups-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// The shared GroupStore semantics — incl. the reopen durability block (a fresh
// instance over the same root simulates a process restart). The factory runs
// inside each test, after `beforeEach` minted this test's `root`.
groupStoreContract("FsGroupStore", async () => ({
  store: new FsGroupStore(root),
  reopen: async () => new FsGroupStore(root),
}));

describe("FsGroupStore (fs-specific)", () => {
  it("rejects an illegal group id (path traversal) on every id-keyed entry point", async () => {
    // An attacker-controlled id that would escape the root via path.join must be
    // refused before any FS access — across every id-keyed method.
    const store = new FsGroupStore(root);
    const evil = "../../etc";
    await expect(store.getGroup(evil)).rejects.toThrow(/illegal group id/);
    await expect(store.getMembership(evil, "alice")).rejects.toThrow(/illegal group id/);
    await expect(store.addMember(evil, "alice", "member")).rejects.toThrow(/illegal group id/);
    await expect(store.removeMember(evil, "alice")).rejects.toThrow(/illegal group id/);
    await expect(store.listMembers(evil)).rejects.toThrow(/illegal group id/);

    // A legitimate group (id generated internally) is unaffected.
    const g = await store.createGroup("Ok", "alice");
    expect(await store.getMembership(g.id, "alice")).toBe("admin");
  });

  it("generates ids that pass the traversal gate (createGroup never mints an illegal id)", async () => {
    const store = new FsGroupStore(root);
    const g = await store.createGroup("Lab", "alice");
    expect(g.id).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });

  it("propagates on corrupted group.json (unparseable JSON is not swallowed)", async () => {
    // Mirrors FsProjectStore's readJson posture: ENOENT ⇒ null, but a corrupted
    // (unparseable) file surfaces as a thrown error rather than a silent null.
    const store = new FsGroupStore(root);
    const g = await store.createGroup("Lab", "alice");
    await writeFile(join(root, "groups", g.id, "group.json"), "{ not json");
    await expect(store.getGroup(g.id)).rejects.toThrow();
  });

  it("propagates on corrupted members.json (unparseable JSON is not swallowed)", async () => {
    const store = new FsGroupStore(root);
    const g = await store.createGroup("Lab", "alice");
    await writeFile(join(root, "groups", g.id, "members.json"), "]]not json[[");
    await expect(store.getMembership(g.id, "alice")).rejects.toThrow();
    await expect(store.listMembers(g.id)).rejects.toThrow();
  });

  it("listGroupsForUser is [] before any group exists (no groups dir yet)", async () => {
    expect(await new FsGroupStore(root).listGroupsForUser("alice")).toEqual([]);
  });

  // Prototype-pollution guard (security round finding 1, HIGH) — mirror of the
  // FsProjectStore test. A magic userId must never resolve an inherited role and
  // forge group access (which the membership endpoint would report as source:group).
  it("getMembership never resolves an inherited Object.prototype key (no forged group access)", async () => {
    const store = new FsGroupStore(root);
    const g = await store.createGroup("Lab", "alice");
    for (const magic of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
      expect(await store.getMembership(g.id, magic), magic).toBeNull();
      expect(await store.getMembership("no-such-group", magic), magic).toBeNull();
      expect(await store.listGroupsForUser(magic), magic).toEqual([]);
    }
    expect(await store.getMembership(g.id, "alice")).toBe("admin");
  });

  it("writes the documented on-disk layout (groups/<id>/group.json + members.json)", async () => {
    const store = new FsGroupStore(root);
    const g = await store.createGroup("Lab", "alice");
    await store.addMember(g.id, "bob", "member");
    // group.json is exactly { id, name } on disk.
    const group = JSON.parse(await readFile(join(root, "groups", g.id, "group.json"), "utf8"));
    expect(group).toEqual({ id: g.id, name: "Lab" });
    // members.json is a plain userId->role map (same shape as FsProjectStore).
    const members = JSON.parse(await readFile(join(root, "groups", g.id, "members.json"), "utf8"));
    expect(members).toEqual({ alice: "admin", bob: "member" });
  });
});
