import { describe, it, expect } from "vitest";
import {
  loadRemoteConfig,
  loadRedactedConfig,
  saveRemoteConfig,
  clearRemoteConfig,
  redactedView,
  gitRemoteKey,
  type ConfigStorage,
} from "./git-remote-config.js";

/**
 * The per-project git-remote config store (#4 UI side). Mirrors the
 * editor-prefs/PROVIDER_KEY pattern: a typed, fail-soft localStorage seam. The
 * security-critical invariant under test is that the `auth.token` is WRITE-ONLY
 * from the screen's perspective — it round-trips for the network call but NEVER
 * appears in the redacted view the panel renders.
 *
 * Storage is injected as an in-memory map so these tests touch no real browser
 * storage and no globals.
 */
function memStorage(seed: Record<string, string> = {}): ConfigStorage & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("git-remote-config store", () => {
  it("round-trips url, ref, and token through save/load (full config for the network call)", () => {
    const s = memStorage();
    saveRemoteConfig("proj-1", { url: "https://git.example/repo.git", ref: "main", token: "ghp_secret" }, s);
    const cfg = loadRemoteConfig("proj-1", s);
    expect(cfg).toEqual({ url: "https://git.example/repo.git", ref: "main", auth: { token: "ghp_secret" } });
  });

  it("keys storage per project id", () => {
    const s = memStorage();
    saveRemoteConfig("proj-A", { url: "https://a/r.git" }, s);
    saveRemoteConfig("proj-B", { url: "https://b/r.git" }, s);
    expect(loadRemoteConfig("proj-A", s)?.url).toBe("https://a/r.git");
    expect(loadRemoteConfig("proj-B", s)?.url).toBe("https://b/r.git");
    expect(s.map.has(gitRemoteKey("proj-A"))).toBe(true);
    expect(s.map.has(gitRemoteKey("proj-B"))).toBe(true);
  });

  it("the redacted view NEVER carries the token value — only hasToken", () => {
    const s = memStorage();
    saveRemoteConfig("p", { url: "https://git.example/r.git", ref: "trunk", token: "ghp_topsecret" }, s);
    const view = loadRedactedConfig("p", s);
    expect(view).toEqual({ url: "https://git.example/r.git", ref: "trunk", hasToken: true });
    // The token string must not appear anywhere in the redacted view.
    expect(JSON.stringify(view)).not.toContain("ghp_topsecret");
  });

  it("redactedView reports hasToken:false when no token is stored", () => {
    const s = memStorage();
    saveRemoteConfig("p", { url: "https://git.example/r.git" }, s);
    expect(loadRedactedConfig("p", s)).toEqual({ url: "https://git.example/r.git", hasToken: false });
    expect(redactedView({ url: "x" })).toEqual({ url: "x", hasToken: false });
  });

  it("treats a blank/whitespace token as no token (never stores an empty credential)", () => {
    const s = memStorage();
    saveRemoteConfig("p", { url: "https://git.example/r.git", token: "   " }, s);
    expect(loadRemoteConfig("p", s)?.auth).toBeUndefined();
  });

  it("drops a blank ref", () => {
    const s = memStorage();
    saveRemoteConfig("p", { url: "https://git.example/r.git", ref: "  " }, s);
    expect(loadRemoteConfig("p", s)?.ref).toBeUndefined();
  });

  it("rejects a blank url (no-op write)", () => {
    const s = memStorage();
    saveRemoteConfig("p", { url: "   " }, s);
    expect(loadRemoteConfig("p", s)).toBeNull();
  });

  it("clear wipes the stored config (the user removing the secret)", () => {
    const s = memStorage();
    saveRemoteConfig("p", { url: "https://git.example/r.git", token: "ghp_x" }, s);
    expect(loadRemoteConfig("p", s)).not.toBeNull();
    clearRemoteConfig("p", s);
    expect(loadRemoteConfig("p", s)).toBeNull();
    expect(loadRedactedConfig("p", s)).toBeNull();
  });

  it("returns null on malformed / missing / non-string-url stored JSON", () => {
    expect(loadRemoteConfig("missing", memStorage())).toBeNull();
    expect(loadRemoteConfig("bad", memStorage({ [gitRemoteKey("bad")]: "{not json" }))).toBeNull();
    expect(loadRemoteConfig("nourl", memStorage({ [gitRemoteKey("nourl")]: '{"ref":"main"}' }))).toBeNull();
  });

  it("is fail-soft when storage is unavailable (null storage)", () => {
    expect(loadRemoteConfig("p", null)).toBeNull();
    expect(loadRedactedConfig("p", null)).toBeNull();
    // No throw:
    expect(() => saveRemoteConfig("p", { url: "https://x/r.git" }, null)).not.toThrow();
    expect(() => clearRemoteConfig("p", null)).not.toThrow();
  });

  it("REJECTS a URL carrying userinfo credentials (HIGH-1) — and stores nothing", () => {
    const s = memStorage();
    const result = saveRemoteConfig(
      "p",
      { url: "https://x-access-token:ghp_URLPAT_999@github.com/o/r.git", token: "" },
      s,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/token field, not the URL/i);
    expect(loadRemoteConfig("p", s)).toBeNull();
    // The credential string never entered storage.
    expect(JSON.stringify([...s.map.values()])).not.toContain("ghp_URLPAT_999");
  });

  it("STRIPS userinfo from a legacy/poisoned stored URL on load (HIGH-1 defense in depth)", () => {
    const s = memStorage({
      [gitRemoteKey("p")]: JSON.stringify({ url: "https://u:ghp_LEGACY_PAT@h/r.git", ref: "main" }),
    });
    // Both the full-config loader AND the redacted view return a clean URL.
    expect(loadRemoteConfig("p", s)?.url).toBe("https://h/r.git");
    const view = loadRedactedConfig("p", s);
    expect(view?.url).toBe("https://h/r.git");
    expect(JSON.stringify(view)).not.toContain("ghp_LEGACY_PAT");
  });

  it("a blank token on save PRESERVES the existing stored token (REC-4)", () => {
    const s = memStorage();
    saveRemoteConfig("p", { url: "https://h/r.git", token: "ghp_keepme" }, s);
    // Re-save with a blank token (e.g. user only edited the ref) — token survives.
    const result = saveRemoteConfig("p", { url: "https://h/r.git", ref: "dev", token: "" }, s);
    expect(result.ok).toBe(true);
    expect(loadRemoteConfig("p", s)?.auth?.token).toBe("ghp_keepme");
    expect(loadRemoteConfig("p", s)?.ref).toBe("dev");
  });

  it("a non-blank token on save OVERWRITES the stored token; Clear removes it", () => {
    const s = memStorage();
    saveRemoteConfig("p", { url: "https://h/r.git", token: "old" }, s);
    saveRemoteConfig("p", { url: "https://h/r.git", token: "new" }, s);
    expect(loadRemoteConfig("p", s)?.auth?.token).toBe("new");
    clearRemoteConfig("p", s);
    expect(loadRemoteConfig("p", s)).toBeNull();
  });

  it("returns ok on a valid save and a typed error on blank/unavailable", () => {
    expect(saveRemoteConfig("p", { url: "https://h/r.git" }, memStorage())).toEqual({ ok: true });
    expect(saveRemoteConfig("p", { url: "https://h/r.git" }, null).ok).toBe(false);
    expect(saveRemoteConfig("p", { url: "  " }, memStorage()).ok).toBe(false);
  });

  it("survives a throwing storage (e.g. quota / blocked) without throwing", () => {
    const throwing: ConfigStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadRemoteConfig("p", throwing)).toBeNull();
    expect(() => saveRemoteConfig("p", { url: "https://x/r.git" }, throwing)).not.toThrow();
    expect(() => clearRemoteConfig("p", throwing)).not.toThrow();
  });
});
