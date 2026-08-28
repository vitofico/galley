/**
 * Per-project sync-destination KIND marker — the tiny store that makes a
 * project's configured destination ("github" | "git") unambiguous instead of
 * derived from whichever secret store happens to have residue. Mirrors
 * `github-repo-target` in shape (namespaced versioned key, injectable storage,
 * fail-soft). The headline invariants:
 *  - round-trip + per-project isolation;
 *  - only the two known kinds load; anything else → null (fail-soft);
 *  - `deriveSyncDestinationKind` is PURE — it implements the migration order
 *    (github-repo-target wins → git-remote → null) over plain booleans, never
 *    reading the other stores itself.
 */
import { describe, expect, it } from "vitest";
import {
  SYNC_DESTINATION_KEY_PREFIX,
  clearSyncDestination,
  deriveSyncDestinationKind,
  loadSyncDestination,
  saveSyncDestination,
  syncDestinationKey,
  type SyncDestinationStorage,
} from "./sync-destination.js";

function fakeStore(): SyncDestinationStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("save/load round-trip", () => {
  it("persists the kind under the per-project namespaced key", () => {
    const store = fakeStore();
    saveSyncDestination("alpha", "github", store);
    expect([...store.map.keys()]).toEqual([syncDestinationKey("alpha")]);
    expect(syncDestinationKey("alpha")).toBe(`${SYNC_DESTINATION_KEY_PREFIX}.alpha`);
    expect(loadSyncDestination("alpha", store)).toBe("github");
  });

  it("isolates one project's kind from another's", () => {
    const store = fakeStore();
    saveSyncDestination("alpha", "github", store);
    saveSyncDestination("beta", "git", store);
    expect(loadSyncDestination("alpha", store)).toBe("github");
    expect(loadSyncDestination("beta", store)).toBe("git");
  });

  it("returns null when nothing is stored", () => {
    expect(loadSyncDestination("missing", fakeStore())).toBeNull();
  });

  it("clears a project's marker", () => {
    const store = fakeStore();
    saveSyncDestination("alpha", "git", store);
    clearSyncDestination("alpha", store);
    expect(loadSyncDestination("alpha", store)).toBeNull();
    expect(store.map.size).toBe(0);
  });
});

describe("fail-soft loading", () => {
  it("returns null for an unknown / malformed stored value", () => {
    const store = fakeStore();
    store.map.set(syncDestinationKey("p"), "svn");
    expect(loadSyncDestination("p", store)).toBeNull();
    store.map.set(syncDestinationKey("q"), "");
    expect(loadSyncDestination("q", store)).toBeNull();
  });

  it("returns null when storage access throws", () => {
    const throwing: SyncDestinationStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(loadSyncDestination("p", throwing)).toBeNull();
  });

  it("never throws on a failed save or clear", () => {
    const throwing: SyncDestinationStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => saveSyncDestination("p", "github", throwing)).not.toThrow();
    expect(() => clearSyncDestination("p", throwing)).not.toThrow();
  });
});

describe("deriveSyncDestinationKind (pure migration helper)", () => {
  it("prefers github when a github repo target is present", () => {
    expect(deriveSyncDestinationKind({ hasGithubRepoTarget: true, hasGitRemote: false })).toBe(
      "github",
    );
    // github-repo-target wins even when a generic git remote also lingers.
    expect(deriveSyncDestinationKind({ hasGithubRepoTarget: true, hasGitRemote: true })).toBe(
      "github",
    );
  });

  it("falls back to git when only a git remote is present", () => {
    expect(deriveSyncDestinationKind({ hasGithubRepoTarget: false, hasGitRemote: true })).toBe(
      "git",
    );
  });

  it("returns null when neither store is configured", () => {
    expect(deriveSyncDestinationKind({ hasGithubRepoTarget: false, hasGitRemote: false })).toBeNull();
  });
});
