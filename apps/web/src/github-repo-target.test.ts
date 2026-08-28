/**
 * Per-project GitHub push target — owner/name/branch keyed per project, behind
 * the injectable storage seam. The headline invariant is ISOLATION: two projects
 * never share a target (the device-global bug this split fixes).
 */
import { describe, expect, it } from "vitest";
import {
  GITHUB_REPO_KEY_PREFIX,
  clearRepoTarget,
  githubRepoKey,
  loadRepoTarget,
  saveRepoTarget,
  type RepoTargetStorage,
} from "./github-repo-target.js";

function fakeStore(): RepoTargetStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("save/load round-trip", () => {
  it("persists owner/name/branch under the per-project namespaced key", () => {
    const store = fakeStore();
    expect(saveRepoTarget("alpha", { owner: "octocat", name: "paper", branch: "main" }, store)).toEqual({
      ok: true,
    });
    expect([...store.map.keys()]).toEqual([githubRepoKey("alpha")]);
    expect(githubRepoKey("alpha")).toBe(`${GITHUB_REPO_KEY_PREFIX}.alpha`);
    expect(loadRepoTarget("alpha", store)).toEqual({
      owner: "octocat",
      name: "paper",
      branch: "main",
    });
  });

  it("trims fields and defaults a blank/absent branch to main", () => {
    const store = fakeStore();
    saveRepoTarget("p", { owner: "  octocat ", name: " paper ", branch: " " }, store);
    expect(loadRepoTarget("p", store)).toEqual({ owner: "octocat", name: "paper", branch: "main" });
    saveRepoTarget("q", { owner: "o", name: "n" }, store);
    expect(loadRepoTarget("q", store)?.branch).toBe("main");
  });

  it("rejects a blank owner or name and writes nothing", () => {
    const store = fakeStore();
    expect(saveRepoTarget("p", { owner: "", name: "paper" }, store).ok).toBe(false);
    expect(saveRepoTarget("p", { owner: "octocat", name: "  " }, store).ok).toBe(false);
    expect(store.map.size).toBe(0);
  });

  it("reports a failed store write", () => {
    const throwing: RepoTargetStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {},
    };
    expect(saveRepoTarget("p", { owner: "o", name: "n" }, throwing).ok).toBe(false);
  });
});

describe("per-project isolation (the device-global bug this fixes)", () => {
  it("keeps each project's target independent — saving one never moves another", () => {
    const store = fakeStore();
    saveRepoTarget("project-a", { owner: "alice", name: "thesis", branch: "main" }, store);
    saveRepoTarget("project-b", { owner: "bob", name: "notes", branch: "draft" }, store);
    expect(loadRepoTarget("project-a", store)).toEqual({
      owner: "alice",
      name: "thesis",
      branch: "main",
    });
    expect(loadRepoTarget("project-b", store)).toEqual({
      owner: "bob",
      name: "notes",
      branch: "draft",
    });
    // Re-pointing A leaves B untouched.
    saveRepoTarget("project-a", { owner: "alice", name: "thesis-v2", branch: "main" }, store);
    expect(loadRepoTarget("project-b", store)?.name).toBe("notes");
  });
});

describe("load resilience", () => {
  it("returns null for absent / malformed / incomplete stored values", () => {
    const store = fakeStore();
    expect(loadRepoTarget("p", store)).toBeNull();
    store.map.set(githubRepoKey("p"), "not json {{{");
    expect(loadRepoTarget("p", store)).toBeNull();
    store.map.set(githubRepoKey("p"), JSON.stringify({ owner: "octocat" })); // no name
    expect(loadRepoTarget("p", store)).toBeNull();
  });

  it("fails soft with no storage available", () => {
    expect(loadRepoTarget("p", null)).toBeNull();
    expect(saveRepoTarget("p", { owner: "o", name: "n" }, null).ok).toBe(false);
  });
});

describe("clear", () => {
  it("removes only the named project's target", () => {
    const store = fakeStore();
    saveRepoTarget("p", { owner: "o", name: "n" }, store);
    saveRepoTarget("q", { owner: "o2", name: "n2" }, store);
    clearRepoTarget("p", store);
    expect(loadRepoTarget("p", store)).toBeNull();
    expect(loadRepoTarget("q", store)).not.toBeNull();
  });
});
