import { describe, it, expect } from "vitest";
import type { VersionedFile } from "@galley/shared";
import { IdbVersionStore, VERSIONS_STORE, TREES_STORE } from "./idb-version-store.js";
import { InMemoryKeyValueBackend } from "./idb-project-store.js";

/**
 * Wraps the in-memory backend to record put order and optionally simulate a crash
 * (a rejected put) on one store — used to prove createVersion writes the tree
 * before the metadata so a half-written version is never listed-but-unrestorable.
 */
class OrderedBackend {
  putOrder: string[] = [];
  constructor(
    private readonly inner = new InMemoryKeyValueBackend(),
    private readonly failOn?: string,
  ) {}
  get<T>(store: string, key: string): Promise<T | null> {
    return this.inner.get<T>(store, key);
  }
  getAll<T>(store: string): Promise<T[]> {
    return this.inner.getAll<T>(store);
  }
  delete(store: string, key: string): Promise<void> {
    return this.inner.delete(store, key);
  }
  async put(store: string, key: string, value: unknown): Promise<void> {
    if (this.failOn === store) throw new Error(`simulated crash writing ${store}`);
    this.putOrder.push(store);
    await this.inner.put(store, key, value);
  }
}

/** A store over the in-memory backend with a deterministic id generator. */
function makeStore() {
  let n = 0;
  return new IdbVersionStore({
    backend: new InMemoryKeyValueBackend(),
    newId: () => `ver-${n++}`,
  });
}

const tree = (text: string): VersionedFile[] => [{ path: "/main.typ", text }];

describe("IdbVersionStore durability (tree before metadata)", () => {
  it("writes the tree before the metadata", async () => {
    const backend = new OrderedBackend();
    const s = new IdbVersionStore({ backend, newId: () => "ver-0" });
    await s.createVersion("p1", { name: "v" }, tree("x"));
    expect(backend.putOrder).toEqual([TREES_STORE, VERSIONS_STORE]);
  });

  it("a crash writing metadata leaves no listed-but-unrestorable version", async () => {
    const backend = new OrderedBackend(new InMemoryKeyValueBackend(), VERSIONS_STORE);
    const s = new IdbVersionStore({ backend, newId: () => "ver-0" });
    await expect(s.createVersion("p1", { name: "v" }, tree("x"))).rejects.toThrow();
    // The metadata write failed; listVersions reads only the metadata store, so the
    // orphan tree is unreachable and nothing broken is surfaced.
    const reader = new IdbVersionStore({ backend, newId: () => "unused" });
    expect(await reader.listVersions("p1")).toEqual([]);
  });
});

describe("IdbVersionStore", () => {
  it("creates a version and round-trips its tree (bytes preserved)", async () => {
    const s = makeStore();
    const files: VersionedFile[] = [
      { path: "/main.typ", text: "= Hello\n" },
      { path: "/chapters/one.typ", text: "Body — with unicode ✓" },
    ];
    const v = await s.createVersion("proj-1", { name: "v1" }, files);
    expect(v.id).toBe("ver-0");
    expect(await s.getVersionTree(v.id)).toEqual(files);
  });

  it("returns a Version without a leaked tree field", async () => {
    const s = makeStore();
    const v = await s.createVersion("proj-1", { name: "v1" }, tree("x"));
    expect(v).toEqual({ id: "ver-0", projectId: "proj-1", name: "v1" });
    expect("tree" in v).toBe(false);
  });

  it("accepts an `author` input (#12) but never persists it onto the Version", async () => {
    const s = makeStore();
    const v = await s.createVersion(
      "proj-1",
      { name: "v1", author: { name: "Ada", email: "ada@users.galley.local" } },
      tree("x"),
    );
    expect(v).toEqual({ id: "ver-0", projectId: "proj-1", name: "v1" });
  });

  it("omits message when not given and includes it when given", async () => {
    const s = makeStore();
    const without = await s.createVersion("proj-1", { name: "v1" }, tree("a"));
    expect("message" in without).toBe(false);

    const withMsg = await s.createVersion("proj-1", { name: "v2", message: "notes" }, tree("b"));
    expect(withMsg.message).toBe("notes");
    expect(withMsg).toEqual({
      id: "ver-1",
      projectId: "proj-1",
      name: "v2",
      message: "notes",
    });
  });

  it("omits contributors when not given / empty and round-trips them when given (#11)", async () => {
    const s = makeStore();
    const without = await s.createVersion("proj-1", { name: "v1" }, tree("a"));
    expect("contributors" in without).toBe(false);

    const empty = await s.createVersion("proj-1", { name: "v2", contributors: [] }, tree("b"));
    expect("contributors" in empty).toBe(false); // [] is treated as absent (back-compat)

    const withC = await s.createVersion(
      "proj-1",
      { name: "v3", contributors: ["Alice", "Bob"] },
      tree("c"),
    );
    expect(withC.contributors).toEqual(["Alice", "Bob"]);

    // Survives a list round-trip (persisted in the row, returned by listVersions).
    const list = await s.listVersions("proj-1");
    expect(list.find((v) => v.name === "v3")?.contributors).toEqual(["Alice", "Bob"]);
    expect("contributors" in (list.find((v) => v.name === "v1") as object)).toBe(false);
  });

  it("listVersions returns only that project's versions in insertion order", async () => {
    const s = makeStore();
    await s.createVersion("proj-1", { name: "a" }, tree("a"));
    await s.createVersion("proj-2", { name: "x" }, tree("x"));
    await s.createVersion("proj-1", { name: "b" }, tree("b"));
    await s.createVersion("proj-1", { name: "c" }, tree("c"));

    const list = await s.listVersions("proj-1");
    expect(list.map((v) => v.name)).toEqual(["a", "b", "c"]);
    expect(list.map((v) => v.id)).toEqual(["ver-0", "ver-2", "ver-3"]);
  });

  it("listVersions is empty for an unknown project", async () => {
    const s = makeStore();
    await s.createVersion("proj-1", { name: "a" }, tree("a"));
    expect(await s.listVersions("unknown")).toEqual([]);
  });

  it("getVersionTree returns null for an unknown id", async () => {
    const s = makeStore();
    expect(await s.getVersionTree("nope")).toBeNull();
  });

  describe("getProjectVersionTree (B4 — project-scoped version file reads)", () => {
    it("returns the tree only when the version belongs to the project", async () => {
      const s = makeStore();
      const v = await s.createVersion("proj-1", { name: "a" }, tree("body"));
      expect(await s.getProjectVersionTree("proj-1", v.id)).toEqual(tree("body"));
    });

    it("refuses (null) a version id owned by a DIFFERENT project (no cross-project read)", async () => {
      const s = makeStore();
      const a = await s.createVersion("proj-a", { name: "a" }, tree("a-secret"));
      // Asking with the wrong project id must NOT return proj-a's tree.
      expect(await s.getProjectVersionTree("proj-b", a.id)).toBeNull();
    });

    it("returns null for an unknown version id", async () => {
      const s = makeStore();
      await s.createVersion("proj-1", { name: "a" }, tree("x"));
      expect(await s.getProjectVersionTree("proj-1", "ver-nope")).toBeNull();
    });

    it("returns null when the metadata row exists but the tree is missing", async () => {
      // Defensive: a row whose tree never landed (crash between writes) must not
      // surface a half-version. Simulate by deleting the tree row directly.
      const backend = new InMemoryKeyValueBackend();
      const s = new IdbVersionStore({ backend, newId: () => "ver-0" });
      const v = await s.createVersion("proj-1", { name: "a" }, tree("x"));
      await backend.delete(TREES_STORE, v.id);
      expect(await s.getProjectVersionTree("proj-1", v.id)).toBeNull();
    });
  });

  it("isolates two projects", async () => {
    const s = makeStore();
    const a = await s.createVersion("proj-a", { name: "a" }, tree("a-body"));
    const b = await s.createVersion("proj-b", { name: "b" }, tree("b-body"));

    expect((await s.listVersions("proj-a")).map((v) => v.id)).toEqual([a.id]);
    expect((await s.listVersions("proj-b")).map((v) => v.id)).toEqual([b.id]);
    expect(await s.getVersionTree(a.id)).toEqual(tree("a-body"));
    expect(await s.getVersionTree(b.id)).toEqual(tree("b-body"));
  });

  it("does not leak the listed Version's tree, nor mutate stored rows via a returned ref", async () => {
    const s = makeStore();
    const v = await s.createVersion("proj-1", { name: "a" }, tree("orig"));
    const list = await s.listVersions("proj-1");
    expect("tree" in list[0]!).toBe(false);

    // Mutating a returned tree must not affect the stored copy.
    const got = await s.getVersionTree(v.id);
    got![0]!.text = "mutated";
    expect((await s.getVersionTree(v.id))![0]!.text).toBe("orig");
  });
});

describe("IdbVersionStore createdAt metadata (F2 — list_versions surfaces creation time)", () => {
  /** A store with a deterministic id generator AND a fixed clock for createdAt. */
  function makeClockStore(now: () => number) {
    let n = 0;
    return new IdbVersionStore({
      backend: new InMemoryKeyValueBackend(),
      newId: () => `ver-${n++}`,
      now,
    });
  }

  it("stamps createdAt (epoch ms) into the stored row, NOT onto the returned Version", async () => {
    const s = makeClockStore(() => 1_700_000_000_000);
    const v = await s.createVersion("proj-1", { name: "v1", message: "notes" }, tree("x"));
    // The public Version stays exactly the {id, projectId, name, message} shape —
    // createdAt is an internal row field, never leaked onto the bare Version.
    expect(v).toEqual({ id: "ver-0", projectId: "proj-1", name: "v1", message: "notes" });
    expect("createdAt" in v).toBe(false);
  });

  it("listVersionMetadata carries createdAt AND message in insertion order", async () => {
    let t = 1_700_000_000_000;
    const s = makeClockStore(() => t);
    await s.createVersion("proj-1", { name: "a" }, tree("a"));
    t = 1_700_000_001_000;
    await s.createVersion("proj-1", { name: "b", message: "second" }, tree("b"));

    const meta = await s.listVersionMetadata("proj-1");
    expect(meta).toEqual([
      { id: "ver-0", projectId: "proj-1", name: "a", createdAt: 1_700_000_000_000 },
      {
        id: "ver-1",
        projectId: "proj-1",
        name: "b",
        message: "second",
        createdAt: 1_700_000_001_000,
      },
    ]);
  });

  it("listVersionMetadata omits createdAt for legacy rows written before the field existed", async () => {
    // A row persisted by an older build lacks `createdAt`. Simulate it by writing a
    // store with no clock-stamped field via a raw backend put, then read it back.
    const backend = new InMemoryKeyValueBackend();
    // Older shape: {id, projectId, name, seq} — no createdAt.
    await backend.put("versions", "ver-legacy", {
      id: "ver-legacy",
      projectId: "proj-1",
      name: "old",
      seq: 0,
    });
    const s = new IdbVersionStore({ backend, newId: () => "unused" });
    const meta = await s.listVersionMetadata("proj-1");
    expect(meta).toHaveLength(1);
    expect("createdAt" in meta[0]!).toBe(false);
    expect(meta[0]).toEqual({ id: "ver-legacy", projectId: "proj-1", name: "old" });
  });

  it("defaults createdAt to wall-clock time (Date.now) when no clock is injected", async () => {
    const s = new IdbVersionStore({
      backend: new InMemoryKeyValueBackend(),
      newId: () => "ver-0",
    });
    const before = Date.now();
    await s.createVersion("proj-1", { name: "a" }, tree("a"));
    const after = Date.now();
    const meta = await s.listVersionMetadata("proj-1");
    const createdAt = meta[0]!.createdAt!;
    expect(typeof createdAt).toBe("number");
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(createdAt).toBeLessThanOrEqual(after);
  });
});
