/**
 * Conformance contract for `GroupStore` (ADR-0029).
 *
 * Every adapter — the in-memory reference impl and the filesystem store — must
 * pass the exact same blocks: create seeds a sole admin, members read back with
 * roles (sorted), `addMember` upserts, the last-admin invariant holds at BOTH
 * mutation points (removal AND demotion refuse to strip the final admin),
 * `listGroupsForUser` isolates users, unknown groups are null/empty (never a
 * throw) on the read paths, and a durable adapter survives a restart. Call it
 * from a `*.test.ts` file with a factory for the implementation under test.
 *
 * Test-only: imports `vitest`. NEVER re-export from the package index (a
 * production import must not link test modules) — import it from test files.
 *
 * The factory returns the store plus an optional `reopen` hook. Adapters with a
 * durable backing (filesystem) provide `reopen` — it must simulate a process
 * restart (new store instance over the same backing) — and get the durability
 * block; the pure in-memory adapter omits it and that block is skipped.
 */
import { describe, expect, it } from "vitest";
import type { GroupStore } from "@galley/shared";

export interface GroupStoreHarness {
  store: GroupStore;
  /** Re-create the store over the same persistent backing, as a restart would. Omit for in-memory. */
  reopen?: () => Promise<GroupStore>;
}

export function groupStoreContract(name: string, makeStore: () => Promise<GroupStoreHarness>): void {
  describe(`GroupStore conformance: ${name}`, () => {
    it("createGroup seeds the creator as the sole admin; getGroup returns {id,name}", async () => {
      const { store } = await makeStore();
      const g = await store.createGroup("Lab", "alice");
      expect(await store.getGroup(g.id)).toEqual({ id: g.id, name: "Lab" });
      expect(await store.getMembership(g.id, "alice")).toBe("admin");
      expect(await store.listMembers(g.id)).toEqual([{ userId: "alice", role: "admin" }]);
    });

    it("adds a member with a role; getMembership + listMembers (sorted by userId) read it back", async () => {
      const { store } = await makeStore();
      const g = await store.createGroup("Lab", "alice");
      await store.addMember(g.id, "bob", "member");
      expect(await store.getMembership(g.id, "bob")).toBe("member");
      expect(await store.getMembership(g.id, "alice")).toBe("admin");
      expect((await store.listMembers(g.id)).map((m) => `${m.userId}:${m.role}`)).toEqual([
        "alice:admin",
        "bob:member",
      ]);
    });

    it("addMember upserts: re-adding a member updates the role, never duplicates", async () => {
      const { store } = await makeStore();
      const g = await store.createGroup("Lab", "alice");
      await store.addMember(g.id, "bob", "member");
      await store.addMember(g.id, "bob", "admin"); // promote (re-add updates the role)
      expect(await store.getMembership(g.id, "bob")).toBe("admin");
      expect((await store.listMembers(g.id)).map((m) => m.userId)).toEqual(["alice", "bob"]);
    });

    it("promotes a member to admin and demotes a non-last admin", async () => {
      const { store } = await makeStore();
      const g = await store.createGroup("Lab", "alice");
      await store.addMember(g.id, "bob", "admin"); // now two admins
      await store.addMember(g.id, "alice", "member"); // demoting one is fine (bob still admin)
      expect(await store.getMembership(g.id, "alice")).toBe("member");
      expect(await store.getMembership(g.id, "bob")).toBe("admin");
    });

    it("addMember to an unknown group rejects (mirrors ProjectStore.addMember)", async () => {
      const { store } = await makeStore();
      await expect(store.addMember("nope", "x", "member")).rejects.toThrow();
    });

    it("refuses removing the last admin — a group can't become admin-less", async () => {
      const { store } = await makeStore();
      const g = await store.createGroup("Lab", "alice"); // alice is the sole admin
      await store.addMember(g.id, "bob", "member");
      await expect(store.removeMember(g.id, "alice")).rejects.toThrow();
      expect(await store.getMembership(g.id, "alice")).toBe("admin"); // unchanged by the refusal
      // With a second admin, removing one IS allowed.
      await store.addMember(g.id, "bob", "admin");
      await store.removeMember(g.id, "alice");
      expect(await store.getMembership(g.id, "alice")).toBeNull();
      expect(await store.getMembership(g.id, "bob")).toBe("admin");
    });

    it("refuses demoting the last admin to member — same invariant, second mutation point", async () => {
      const { store } = await makeStore();
      const g = await store.createGroup("Lab", "alice"); // alice is the sole admin
      await expect(store.addMember(g.id, "alice", "member")).rejects.toThrow();
      expect(await store.getMembership(g.id, "alice")).toBe("admin"); // unchanged by the refusal
    });

    it("removes a member; removeMember of a non-member is a no-op (no throw)", async () => {
      const { store } = await makeStore();
      const g = await store.createGroup("Lab", "alice");
      await store.addMember(g.id, "bob", "member");
      await store.removeMember(g.id, "bob");
      expect(await store.getMembership(g.id, "bob")).toBeNull();
      await store.removeMember(g.id, "ghost"); // never a member — no-op
      expect((await store.listMembers(g.id)).map((m) => m.userId)).toEqual(["alice"]);
    });

    it("lists the groups a user belongs to (any role), not others; sorted by id", async () => {
      const { store } = await makeStore();
      const g1 = await store.createGroup("A", "alice");
      const g2 = await store.createGroup("B", "bob");
      await store.addMember(g2.id, "alice", "member");
      const g3 = await store.createGroup("C", "carol");
      const ids = (await store.listGroupsForUser("alice")).map((g) => g.id);
      expect(ids).toEqual([g1.id, g2.id].sort());
      expect(ids).not.toContain(g3.id);
      expect((await store.listGroupsForUser("carol")).map((g) => g.id)).toEqual([g3.id]);
    });

    it("unknown group: getGroup null, getMembership null, listMembers [], removeMember no-op", async () => {
      const { store } = await makeStore();
      expect(await store.getGroup("nope")).toBeNull();
      expect(await store.getMembership("nope", "x")).toBeNull();
      expect(await store.listMembers("nope")).toEqual([]);
      await expect(store.removeMember("nope", "x")).resolves.toBeUndefined(); // no throw
      expect(await store.listGroupsForUser("nobody")).toEqual([]);
    });

    it("retains groups + membership across a close/reopen cycle (durability)", async (ctx) => {
      const harness = await makeStore();
      if (!harness.reopen) return ctx.skip();
      const g = await harness.store.createGroup("Lab", "alice");
      await harness.store.addMember(g.id, "bob", "member");

      const reopened = await harness.reopen();
      expect(await reopened.getGroup(g.id)).toEqual({ id: g.id, name: "Lab" });
      expect(await reopened.getMembership(g.id, "alice")).toBe("admin");
      expect(await reopened.getMembership(g.id, "bob")).toBe("member");
      expect((await reopened.listMembers(g.id)).map((m) => m.userId)).toEqual(["alice", "bob"]);
      expect((await reopened.listGroupsForUser("bob")).map((x) => x.id)).toEqual([g.id]);
    });
  });
}
