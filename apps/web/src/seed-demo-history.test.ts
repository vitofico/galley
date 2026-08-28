import { describe, it, expect, vi } from "vitest";
import type { ProjectId, Version, VersionedFile, VersionStore } from "@galley/shared";
import { IdbVersionStore, InMemoryKeyValueBackend } from "./idb-version-store.js";
import { DEMO_HISTORY } from "./demo/einstein-1905.js";
import { seedDemoHistory } from "./seed-demo-history.js";

const PROJECT: ProjectId = "proj-demo";

function memStore(): IdbVersionStore {
  return new IdbVersionStore({ backend: new InMemoryKeyValueBackend() });
}

describe("seedDemoHistory (#20.2)", () => {
  it("writes the four 1905 versions, oldest first, names verbatim", async () => {
    const store = memStore();
    await expect(seedDemoHistory(store, PROJECT)).resolves.toBe(true);

    const versions = await store.listVersions(PROJECT);
    expect(versions).toHaveLength(4);
    // Insertion order is oldest-first; names match DEMO_HISTORY verbatim.
    expect(versions.map((v) => v.name)).toEqual(DEMO_HISTORY.map((h) => h.name));
    expect(versions[0]!.name).toContain("17 March 1905");
    expect(versions[3]!.name).toContain("27 September 1905");

    // Each version's materialized tree is retrievable and is the spec'd tree.
    for (const [i, v] of versions.entries()) {
      const tree = await store.getVersionTree(v.id);
      expect(tree).toEqual(DEMO_HISTORY[i]!.tree);
    }
  });

  it("is exactly-once: a second call (e.g. a misfired signal) seeds nothing", async () => {
    const store = memStore();
    await seedDemoHistory(store, PROJECT);
    await expect(seedDemoHistory(store, PROJECT)).resolves.toBe(false);
    expect(await store.listVersions(PROJECT)).toHaveLength(4);
  });

  it("never touches a project that already has ANY version", async () => {
    const store = memStore();
    await store.createVersion(PROJECT, { name: "my own save" }, []);
    await expect(seedDemoHistory(store, PROJECT)).resolves.toBe(false);
    const versions = await store.listVersions(PROJECT);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.name).toBe("my own save");
  });

  it("scopes the guard per project — another project's versions don't block it", async () => {
    const store = memStore();
    await store.createVersion("proj-other", { name: "elsewhere" }, []);
    await expect(seedDemoHistory(store, PROJECT)).resolves.toBe(true);
    expect(await store.listVersions(PROJECT)).toHaveLength(4);
    expect(await store.listVersions("proj-other")).toHaveLength(1);
  });

  it("fails soft when listVersions rejects (resolves false, warns, never throws)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken: VersionStore = {
      listVersions: () => Promise.reject(new Error("idb gone")),
      createVersion: () => Promise.reject(new Error("idb gone")),
      getVersionTree: () => Promise.resolve(null),
    };
    await expect(seedDemoHistory(broken, PROJECT)).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("fails soft when createVersion rejects midway (resolves false, never throws)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const created: string[] = [];
    const flaky: VersionStore = {
      listVersions: () => Promise.resolve([]),
      createVersion: (
        _projectId: ProjectId,
        input: { name: string },
        _tree: VersionedFile[],
      ): Promise<Version> => {
        if (created.length >= 2) return Promise.reject(new Error("quota exceeded"));
        created.push(input.name);
        return Promise.resolve({ id: `v${created.length}`, projectId: PROJECT, name: input.name });
      },
      getVersionTree: () => Promise.resolve(null),
    };
    await expect(seedDemoHistory(flaky, PROJECT)).resolves.toBe(false);
    expect(created).toHaveLength(2); // partial write is tolerated, boot survives
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
