import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { FsCrdtStore, FsProjectStore } from "@galley/persistence";
import { AggregateStorageQuota } from "./aggregate-storage-quota.js";
it("counts persisted rooms after restart, live writes, expiry and retirement against one shared owner budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "galley-aggregate-"));
  try {
    const projects = new FsProjectStore(root);
    const store = new FsCrdtStore(root);
    for (const id of ["a", "b", "other"])
      await projects.createProject({
        id,
        ownerId: id === "other" ? "bob" : "alice",
        name: id,
      });
    const doc = new Y.Doc();
    doc.getText("text").insert(0, "stored");
    await store.appendUpdate("a", Y.encodeStateAsUpdate(doc));
    let now = 1000;
    const quota = new AggregateStorageQuota({
      dataDir: root,
      persistDir: root,
      now: () => now,
      policy: async () => ({ maxBytes: 100, expiresAt: 2000 }),
    });
    await quota.getCaps("b");
    expect(quota.allowGrowth("b", 100)).toBe(false);
    quota.recordContent("b", 75);
    expect(quota.allowGrowth("b", 20)).toBe(false);
    quota.recordContent("b", 1);
    expect(quota.allowGrowth("b", 20)).toBe(true);
    await quota.getCaps("other");
    quota.recordContent("other", 99);
    expect(quota.allowGrowth("other", 2)).toBe(false);
    expect(quota.allowGrowth("b", 20)).toBe(true);
    quota.retire("a");
    expect(quota.allowGrowth("b", 99)).toBe(true);
    now = 2000;
    expect(quota.allowGrowth("b", 1)).toBe(false);
    doc.destroy();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("shares an exact CRDT, asset and retained-history budget across rooms and rebuilds it after restart", async () => {
  const { FsHostedStorage } = await import("@galley/persistence");
  const { createHash } = await import("node:crypto");
  const root = await mkdtemp(join(tmpdir(), "galley-all-storage-"));
  try {
    const projects = new FsProjectStore(root);
    for (const id of ["one", "two", "other"])
      await projects.createProject({
        id,
        name: id,
        ownerId: id === "other" ? "bob" : "alice",
      });
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "state");
    const update = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    await new FsCrdtStore(root).appendUpdate("one", update);
    const opts = {
      dataDir: root,
      persistDir: root,
      policy: async () => ({
        maxBytes: update.byteLength + 100,
        expiresAt: Date.now() + 60000,
      }),
    };
    const quota = new AggregateStorageQuota(opts);
    const store = new FsHostedStorage(root, quota);
    const bytes = new Uint8Array(60).fill(1);
    const hash = createHash("sha256").update(bytes).digest("hex");
    await store.putAsset("two", hash, bytes);
    await store.putAsset("two", hash, bytes);
    await store.checkpoint("one", new Uint8Array(40));
    expect(quota.allowGrowth("two", 0)).toBe(true);
    expect(quota.allowGrowth("two", 1)).toBe(false);
    const restarted = new AggregateStorageQuota(opts);
    await restarted.getCaps("two");
    expect(restarted.allowGrowth("two", 0)).toBe(true);
    expect(restarted.allowGrowth("two", 1)).toBe(false);
    await restarted.getCaps("other");
    expect(restarted.allowGrowth("other", 100)).toBe(true);
    await store.retire("one");
    quota.retire("one");
    expect(quota.allowGrowth("two", 40)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("reserves before awaiting disk so concurrent rooms cannot oversubscribe their owner; failed writes release reservation", async () => {
  const { FsHostedStorage } = await import("@galley/persistence");
  const { createHash } = await import("node:crypto");
  const root = await mkdtemp(join(tmpdir(), "galley-storage-race-"));
  try {
    const projects = new FsProjectStore(root);
    for (const id of ["one", "two"])
      await projects.createProject({ id, name: id, ownerId: "alice" });
    const quota = new AggregateStorageQuota({
      dataDir: root,
      persistDir: root,
      policy: async () => ({ maxBytes: 100, expiresAt: Date.now() + 60000 }),
    });
    const store = new FsHostedStorage(root, quota);
    const bytes = new Uint8Array(60);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const results = await Promise.allSettled([
      store.putAsset("one", hash, bytes),
      store.putAsset("two", hash, bytes),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(quota.allowGrowth("one", 40)).toBe(true);
    expect(quota.allowGrowth("one", 41)).toBe(false);
    const rollback = await quota.reserve("one", 40);
    expect(quota.allowGrowth("two", 1)).toBe(false);
    rollback();
    rollback();
    expect(quota.allowGrowth("one", 40)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("charges group-owned data to the group and refuses closed personal owners", async () => {
  const { FsSessionStore } = await import("@galley/persistence");
  const { writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "galley-storage-group-"));
  try {
    const projects = new FsProjectStore(root);
    await projects.createProject({
      id: "groupdoc",
      name: "Group",
      ownerId: "alice",
    });
    await projects.createProject({
      id: "personal",
      name: "Personal",
      ownerId: "alice",
    });
    await writeFile(
      join(root, "projects", "groupdoc", "project.json"),
      JSON.stringify({
        id: "groupdoc",
        name: "Group",
        ownerId: "alice",
        ownerGroupId: "team",
      }),
    );
    await new FsSessionStore(root).closeUser("alice", {
      version: 1,
      state: "closed",
    });
    const subjects: string[] = [];
    const quota = new AggregateStorageQuota({
      dataDir: root,
      persistDir: root,
      policy: async (subject) => {
        subjects.push(subject);
        return { maxBytes: 100, expiresAt: Date.now() + 60000 };
      },
    });
    await quota.getCaps("groupdoc");
    expect(subjects).toEqual(["group:team"]);
    await expect(quota.getCaps("personal")).rejects.toThrow("closed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
