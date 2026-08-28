import { describe, it, expect } from "vitest";
import {
  IdbProjectStore,
  IndexeddbKeyValueBackend,
  InMemoryKeyValueBackend,
} from "./idb-project-store.js";

/**
 * A minimal in-test IDBFactory (no `fake-indexeddb` dependency, per the module's
 * house pattern): the first `failures` opens fire `onerror`, the rest succeed
 * with a db whose reads resolve `undefined`. Handlers are invoked on a microtask
 * so the backend has assigned them after `open()` returns.
 */
function flakyFactory(failures: number): IDBFactory {
  let calls = 0;
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => {},
    transaction: () => ({
      objectStore: () => ({
        get: () => {
          const r: { onsuccess: (() => void) | null; onerror: (() => void) | null; result: unknown } =
            { onsuccess: null, onerror: null, result: undefined };
          queueMicrotask(() => r.onsuccess?.());
          return r;
        },
      }),
    }),
  };
  return {
    open: () => {
      const fail = calls++ < failures;
      const req: {
        onupgradeneeded: (() => void) | null;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        result: unknown;
        error: unknown;
      } = { onupgradeneeded: null, onsuccess: null, onerror: null, result: db, error: new Error("open failed") };
      queueMicrotask(() => {
        if (fail) {
          req.onerror?.();
        } else {
          req.onupgradeneeded?.();
          req.onsuccess?.();
        }
      });
      return req as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

/** A store over the in-memory backend with a deterministic id generator. */
function makeStore() {
  let n = 0;
  return new IdbProjectStore({
    backend: new InMemoryKeyValueBackend(),
    newId: () => `proj-${n++}`,
  });
}

describe("IndexeddbKeyValueBackend open() recovery", () => {
  it("retries the db open after a transient failure instead of caching the rejection", async () => {
    const backend = new IndexeddbKeyValueBackend("galley-test-db", flakyFactory(1));
    // First call: open fails and the rejection propagates.
    await expect(backend.get("projects", "x")).rejects.toThrow();
    // Second call MUST retry the open (the rejected promise was not cached) and succeed.
    expect(await backend.get("projects", "x")).toBeNull();
  });
});

describe("IdbProjectStore", () => {
  it("creates a project, round-trips it, and makes the owner an 'owner' member", async () => {
    const s = makeStore();
    const p = await s.createProject({ name: "Thesis", ownerId: "alice" });
    expect(p.id).toBe("proj-0");
    expect(p).toEqual({ id: "proj-0", name: "Thesis", ownerId: "alice" });
    expect(await s.getProject(p.id)).toEqual(p);
    expect(await s.getMembership(p.id, "alice")).toBe("owner");
  });

  it("getProject returns null for an unknown id", async () => {
    const s = makeStore();
    expect(await s.getProject("nope")).toBeNull();
  });

  it("honors an explicit id and rejects a duplicate", async () => {
    const s = makeStore();
    await s.createProject({ id: "fixed", name: "P", ownerId: "alice" });
    expect((await s.getProject("fixed"))?.id).toBe("fixed");
    await expect(s.createProject({ id: "fixed", name: "X", ownerId: "alice" })).rejects.toThrow();
  });

  it("auto-assigns an id when none is given", async () => {
    const s = makeStore();
    const a = await s.createProject({ name: "A", ownerId: "alice" });
    const b = await s.createProject({ name: "B", ownerId: "alice" });
    expect(a.id).toBe("proj-0");
    expect(b.id).toBe("proj-1");
  });

  it("lists projects the user owns OR is a member of, excluding non-members", async () => {
    const s = makeStore();
    const a = await s.createProject({ name: "A", ownerId: "alice" });
    const b = await s.createProject({ name: "B", ownerId: "bob" });
    await s.addMember(b.id, "alice", "editor");
    const c = await s.createProject({ name: "C", ownerId: "carol" });

    const alices = await s.listProjectsForUser("alice");
    expect(alices.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(alices.map((p) => p.id)).not.toContain(c.id);
  });

  it("adds/removes members and reads membership + roles", async () => {
    const s = makeStore();
    const p = await s.createProject({ name: "P", ownerId: "alice" });
    await s.addMember(p.id, "bob", "viewer");
    expect(await s.getMembership(p.id, "bob")).toBe("viewer");
    expect((await s.listMembers(p.id)).map((m) => `${m.userId}:${m.role}`).sort()).toEqual([
      "alice:owner",
      "bob:viewer",
    ]);
    await s.removeMember(p.id, "bob");
    expect(await s.getMembership(p.id, "bob")).toBeNull();
    expect((await s.listMembers(p.id)).map((m) => m.userId)).toEqual(["alice"]);
  });

  it("getMembership returns null when absent", async () => {
    const s = makeStore();
    const p = await s.createProject({ name: "P", ownerId: "alice" });
    expect(await s.getMembership(p.id, "stranger")).toBeNull();
    expect(await s.getMembership("no-project", "alice")).toBeNull();
  });

  it("rejects adding a member to an unknown project", async () => {
    const s = makeStore();
    await expect(s.addMember("nope", "bob", "editor")).rejects.toThrow();
  });

  it("addMember upserts the role for an existing member", async () => {
    const s = makeStore();
    const p = await s.createProject({ name: "P", ownerId: "alice" });
    await s.addMember(p.id, "bob", "viewer");
    await s.addMember(p.id, "bob", "editor");
    expect(await s.getMembership(p.id, "bob")).toBe("editor");
    expect((await s.listMembers(p.id)).filter((m) => m.userId === "bob")).toHaveLength(1);
  });

  it("deleteProject removes the project and its memberships", async () => {
    const s = makeStore();
    const p = await s.createProject({ name: "P", ownerId: "alice" });
    await s.addMember(p.id, "bob", "editor");
    await s.deleteProject(p.id);
    expect(await s.getProject(p.id)).toBeNull();
    expect(await s.getMembership(p.id, "alice")).toBeNull();
    expect(await s.getMembership(p.id, "bob")).toBeNull();
    expect(await s.listMembers(p.id)).toEqual([]);
    expect(await s.listProjectsForUser("alice")).toEqual([]);
    expect(await s.listProjectsForUser("bob")).toEqual([]);
  });

  it("deleteProject on an unknown id is a no-op", async () => {
    const s = makeStore();
    await expect(s.deleteProject("ghost")).resolves.toBeUndefined();
  });

  it("isolates members per project", async () => {
    const s = makeStore();
    const a = await s.createProject({ name: "A", ownerId: "alice" });
    const b = await s.createProject({ name: "B", ownerId: "bob" });
    await s.addMember(a.id, "carol", "viewer");
    expect((await s.listMembers(b.id)).map((m) => m.userId)).toEqual(["bob"]);
    expect(await s.getMembership(b.id, "carol")).toBeNull();
  });

  it("updateProject patches metadata, persists it, and rejects unknown ids (#12.2)", async () => {
    const s = makeStore();
    const p = await s.createProject({ name: "Thesis", ownerId: "alice" });
    // A fresh project carries no metadata (absent = undefined; no migration).
    expect(p).toEqual({ id: "proj-0", name: "Thesis", ownerId: "alice" });

    const t1 = await s.updateProject(p.id, { tags: ["draft"], createdAt: 10, archived: false });
    expect(t1).toMatchObject({ tags: ["draft"], createdAt: 10, archived: false });
    // Partial patch leaves unpatched keys intact and round-trips through the backend.
    const t2 = await s.updateProject(p.id, { archived: true, lastOpenedAt: 99 });
    expect(t2.tags).toEqual(["draft"]);
    expect(t2.createdAt).toBe(10);
    expect(t2.archived).toBe(true);
    expect(t2.lastOpenedAt).toBe(99);
    expect(await s.getProject(p.id)).toEqual(t2);

    await expect(s.updateProject("ghost", { archived: true })).rejects.toThrow();
  });
});

describe("InMemoryKeyValueBackend", () => {
  it("put/get/getAll/delete round-trip within a store namespace", async () => {
    const be = new InMemoryKeyValueBackend();
    await be.put("things", "k1", { v: 1 });
    await be.put("things", "k2", { v: 2 });
    expect(await be.get("things", "k1")).toEqual({ v: 1 });
    expect((await be.getAll("things")).length).toBe(2);
    await be.delete("things", "k1");
    expect(await be.get("things", "k1")).toBeNull();
    expect((await be.getAll("things")).length).toBe(1);
  });

  it("isolates namespaces and returns null/[] for unknowns", async () => {
    const be = new InMemoryKeyValueBackend();
    expect(await be.get("nope", "x")).toBeNull();
    expect(await be.getAll("nope")).toEqual([]);
    await be.put("a", "k", 1);
    expect(await be.get("b", "k")).toBeNull();
  });
});
