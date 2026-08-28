/**
 * Connect GitHub — device-scoped connection persistence (PAT + login) behind the
 * injectable storage seam. All through a Map-backed fake store; the headline
 * invariant is that the REDACTED view can never carry the token. The push target
 * is per-project now and lives in `github-repo-target.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  GITHUB_CONNECT_KEY,
  clearGithubConnection,
  loadGithubConnection,
  loadRedactedGithubConnection,
  redactedGithubConnection,
  saveGithubConnection,
  type GithubConnectStorage,
} from "./github-connect.js";

function fakeStore(): GithubConnectStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const CONN = { token: "ghp_store_SENTINEL_42", login: "octocat" };

describe("save/load round-trip", () => {
  it("persists token+login under the namespaced key and loads them back", () => {
    const store = fakeStore();
    expect(saveGithubConnection(CONN, store)).toBe(true);
    expect([...store.map.keys()]).toEqual([GITHUB_CONNECT_KEY]);
    expect(loadGithubConnection(store)).toEqual(CONN);
  });

  it("ignores a legacy device-global repo field, still loading token+login", () => {
    const store = fakeStore();
    // A connection written before the per-project split carried `repo`.
    store.map.set(
      GITHUB_CONNECT_KEY,
      JSON.stringify({ ...CONN, repo: { owner: "octocat", name: "paper", branch: "main" } }),
    );
    const loaded = loadGithubConnection(store);
    expect(loaded).toEqual(CONN);
    expect("repo" in (loaded as object)).toBe(false);
  });

  it("returns null for absent / malformed / shape-violating stored values", () => {
    const store = fakeStore();
    expect(loadGithubConnection(store)).toBeNull();
    store.map.set(GITHUB_CONNECT_KEY, "not json {{{");
    expect(loadGithubConnection(store)).toBeNull();
    store.map.set(GITHUB_CONNECT_KEY, JSON.stringify({ login: "x" })); // no token
    expect(loadGithubConnection(store)).toBeNull();
    store.map.set(GITHUB_CONNECT_KEY, JSON.stringify({ token: "t" })); // no login
    expect(loadGithubConnection(store)).toBeNull();
  });

  it("rejects saving an invalid connection and reports a failed store write", () => {
    const store = fakeStore();
    expect(saveGithubConnection({ token: "", login: "x" }, store)).toBe(false);
    expect(store.map.size).toBe(0);
    const throwing: GithubConnectStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {},
    };
    expect(saveGithubConnection(CONN, throwing)).toBe(false);
  });

  it("clear removes the stored connection (the PAT wipe)", () => {
    const store = fakeStore();
    saveGithubConnection(CONN, store);
    clearGithubConnection(store);
    expect(loadGithubConnection(store)).toBeNull();
  });

  it("fails soft with no storage available", () => {
    expect(loadGithubConnection(null as unknown as undefined)).toBeNull();
  });
});

describe("redacted view", () => {
  it("carries login/hasToken and structurally CANNOT carry the token", () => {
    const view = redactedGithubConnection(CONN);
    expect(view).toEqual({ login: "octocat", hasToken: true });
    expect(JSON.stringify(view)).not.toContain(CONN.token);
    expect("token" in view).toBe(false);
  });

  it("loadRedactedGithubConnection mirrors load (null when nothing stored)", () => {
    const store = fakeStore();
    expect(loadRedactedGithubConnection(store)).toBeNull();
    saveGithubConnection(CONN, store);
    expect(loadRedactedGithubConnection(store)).toEqual({ login: "octocat", hasToken: true });
  });
});
