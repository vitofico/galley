/**
 * 14-E auth activation — the pure boot-gate logic, exercised with an injected
 * fetch (no React, no browser; mirrors the provider-storage.ts seam style).
 *
 * The CRITICAL contract pinned here: the gate NEVER probes for auth — when the
 * server is auth-off, /auth/me falls through to the SPA wildcard and answers
 * index.html 200, so probing would mis-detect. `isAuthEnabled` trusts ONLY the
 * server-rendered `window.__GALLEY_CONFIG__.auth === true` flag.
 */
import { describe, it, expect } from "vitest";
import {
  isAuthEnabled,
  fetchAuthState,
  signInUrl,
  signOut,
  type AuthFetch,
} from "./auth-gate.js";

function jsonResponse(status: number, body: unknown): ReturnType<AuthFetch> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

describe("isAuthEnabled (the server-rendered flag, never a probe)", () => {
  it("is true ONLY for a literal `auth: true`", () => {
    expect(isAuthEnabled({ auth: true })).toBe(true);
    expect(isAuthEnabled({ compileUrl: "http://x", auth: true })).toBe(true);
  });

  it("is false for everything else (absent global, absent key, wrong type)", () => {
    expect(isAuthEnabled(undefined)).toBe(false);
    expect(isAuthEnabled(null)).toBe(false);
    expect(isAuthEnabled({})).toBe(false);
    expect(isAuthEnabled({ compileUrl: "http://x" })).toBe(false);
    expect(isAuthEnabled({ auth: false })).toBe(false);
    expect(isAuthEnabled({ auth: "true" })).toBe(false);
    expect(isAuthEnabled({ auth: 1 })).toBe(false);
    expect(isAuthEnabled("auth")).toBe(false);
  });
});

describe("fetchAuthState (injected fetch)", () => {
  it("authenticated: 200 with a userId → the user, display preferred over userId", async () => {
    const fetchImpl: AuthFetch = (input, init) => {
      expect(input).toBe("/auth/me");
      expect(init?.credentials).toBe("same-origin");
      // The boot authority must NEVER be answered from a cache — a stale
      // `authenticated: true` would render the app after logout/expiry.
      expect(init?.cache).toBe("no-store");
      return jsonResponse(200, { authenticated: true, userId: "oidc:abc", display: "Ada Lovelace" });
    };
    expect(await fetchAuthState(fetchImpl)).toEqual({
      kind: "authenticated",
      user: { userId: "oidc:abc", display: "Ada Lovelace" },
    });
  });

  it("authenticated without a display claim → falls back to the userId", async () => {
    const state = await fetchAuthState(() => jsonResponse(200, { authenticated: true, userId: "oidc:abc" }));
    expect(state).toEqual({ kind: "authenticated", user: { userId: "oidc:abc", display: "oidc:abc" } });
  });

  it("401 → unauthenticated", async () => {
    expect(await fetchAuthState(() => jsonResponse(401, { authenticated: false }))).toEqual({
      kind: "unauthenticated",
    });
  });

  it("fails CLOSED to unauthenticated: network error, malformed JSON, wrong shape", async () => {
    expect(await fetchAuthState(() => Promise.reject(new Error("offline")))).toEqual({
      kind: "unauthenticated",
    });
    expect(
      await fetchAuthState(() =>
        Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error("not json")) }),
      ),
    ).toEqual({ kind: "unauthenticated" });
    // A 200 that is NOT a real /auth/me payload (e.g. some other JSON) → signed out.
    expect(await fetchAuthState(() => jsonResponse(200, { hello: "world" }))).toEqual({
      kind: "unauthenticated",
    });
    expect(await fetchAuthState(() => jsonResponse(200, { authenticated: true }))).toEqual({
      kind: "unauthenticated", // no userId → not a valid session
    });
  });
});

describe("signInUrl (returnTo = the current same-origin path)", () => {
  it("encodes path + search into returnTo", () => {
    expect(signInUrl("/p/proj-1", "?a=1&b=2")).toBe(
      `/auth/login?returnTo=${encodeURIComponent("/p/proj-1?a=1&b=2")}`,
    );
    expect(signInUrl("/", "")).toBe(`/auth/login?returnTo=${encodeURIComponent("/")}`);
  });

  it("defensively collapses non-path inputs to / (the server re-validates anyway)", () => {
    expect(signInUrl("", "")).toBe(`/auth/login?returnTo=${encodeURIComponent("/")}`);
    expect(signInUrl("//evil.example", "")).toBe(`/auth/login?returnTo=${encodeURIComponent("/")}`);
  });
});

describe("signOut", () => {
  it("POSTs /auth/logout with credentials", async () => {
    const calls: Array<{ input: string; method?: string; credentials?: string }> = [];
    const fetchImpl: AuthFetch = (input, init) => {
      calls.push({
        input,
        ...(init?.method !== undefined ? { method: init.method } : {}),
        ...(init?.credentials !== undefined ? { credentials: init.credentials } : {}),
      });
      return jsonResponse(204, null);
    };
    await signOut(fetchImpl);
    expect(calls).toEqual([{ input: "/auth/logout", method: "POST", credentials: "same-origin" }]);
  });

  it("never throws — a failed logout still lets the caller reload to the gate", async () => {
    await expect(signOut(() => Promise.reject(new Error("offline")))).resolves.toBeUndefined();
  });
});
