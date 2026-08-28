/**
 * Fail-closed startup guard for the sync server (roadmap #4 hardening).
 *
 * `buildSyncOptions(env)` is the pure decision the entrypoint makes from the
 * environment. It MUST refuse to produce an "enforcing but unenforceable" config:
 * when `GALLEY_SYNC_AUTH=required` it has to have a durable, SHARED session dir
 * (so it can validate a web-minted session) and a data dir (membership). Missing
 * either → throw, never silently fall back to an in-memory store that can never
 * see the web container's sessions (that would report healthy while authorizing
 * nobody / everybody — false security). The default (no-auth) path returns `{}`
 * and is asserted byte-for-byte unchanged.
 */
import { describe, it, expect } from "vitest";
import { FsCrdtStore } from "@galley/persistence";
import { buildSyncOptions, parseAllowedOrigins } from "./server-config.js";

describe("buildSyncOptions — sync auth fail-closed guard", () => {
  it("default no-auth path: returns empty options (open rooms), unchanged", () => {
    expect(buildSyncOptions({})).toEqual({});
    expect(buildSyncOptions({ GALLEY_SYNC_AUTH: "off" })).toEqual({});
    // Even if session/data dirs are set, without auth=required rooms stay open.
    expect(
      buildSyncOptions({ GALLEY_SESSION_DIR: "/data/sessions", GALLEY_DATA_DIR: "/data/projects" }),
    ).toEqual({});
  });

  it("auth required + both durable dirs + allowlist: produces an upgrade gate (no throw)", () => {
    const opts = buildSyncOptions({
      GALLEY_SYNC_AUTH: "required",
      GALLEY_SESSION_DIR: "/data/sessions",
      GALLEY_DATA_DIR: "/data/projects",
      GALLEY_SYNC_ALLOWED_ORIGINS: "https://app.test",
    });
    expect(typeof opts.authorizeUpgrade).toBe("function");
  });

  // #1 slice 2 security round HIGH-1: capability rooms are authorized WITHOUT a
  // cookie, so under auth=required the Origin allowlist is the wall that stops a
  // hostile page from driving a leaked room id. An enforcing relay without one
  // is a misconfiguration — refuse to start. Auth-off behavior is unchanged.
  it("auth required but NO Origin allowlist: refuses to start (fail closed)", () => {
    expect(() =>
      buildSyncOptions({
        GALLEY_SYNC_AUTH: "required",
        GALLEY_SESSION_DIR: "/data/sessions",
        GALLEY_DATA_DIR: "/data/projects",
      }),
    ).toThrow(/GALLEY_SYNC_ALLOWED_ORIGINS/);
    expect(() =>
      buildSyncOptions({
        GALLEY_SYNC_AUTH: "required",
        GALLEY_SESSION_DIR: "/data/sessions",
        GALLEY_DATA_DIR: "/data/projects",
        GALLEY_SYNC_ALLOWED_ORIGINS: "  ,  ", // blanks-only = empty = still refused
      }),
    ).toThrow(/GALLEY_SYNC_ALLOWED_ORIGINS/);
  });

  it("auth required but NO session dir: refuses to start (fail closed)", () => {
    expect(() =>
      buildSyncOptions({ GALLEY_SYNC_AUTH: "required", GALLEY_DATA_DIR: "/data/projects" }),
    ).toThrow(/GALLEY_SESSION_DIR/);
  });

  it("auth required but NO data dir: refuses to start (fail closed)", () => {
    expect(() =>
      buildSyncOptions({ GALLEY_SYNC_AUTH: "required", GALLEY_SESSION_DIR: "/data/sessions" }),
    ).toThrow(/GALLEY_DATA_DIR/);
  });

  it("auth required but blank/whitespace session dir: refuses to start", () => {
    expect(() =>
      buildSyncOptions({
        GALLEY_SYNC_AUTH: "required",
        GALLEY_SESSION_DIR: "   ",
        GALLEY_DATA_DIR: "/data/projects",
      }),
    ).toThrow(/GALLEY_SESSION_DIR/);
  });

  // Strict-enum hardening: a malformed explicit toggle must fail closed, never
  // silently select the open path (that would be false security on a typo).
  const dirs = {
    GALLEY_SESSION_DIR: "/data/sessions",
    GALLEY_DATA_DIR: "/data/projects",
    GALLEY_SYNC_ALLOWED_ORIGINS: "https://app.test",
  };

  it("accepts the canonical token trimmed + case-insensitively (gated, no throw)", () => {
    for (const v of ["required", "Required", "REQUIRED", "  required  ", "required\n"]) {
      const opts = buildSyncOptions({ GALLEY_SYNC_AUTH: v, ...dirs });
      expect(typeof opts.authorizeUpgrade, v).toBe("function");
    }
  });

  it("THROWS on any unrecognized non-empty value (never opens on a typo)", () => {
    for (const v of ["requireed", "require", "on", "1", "true", "yes", "enabled", "open"]) {
      // dirs present so the only possible failure is the enum guard itself.
      expect(() => buildSyncOptions({ GALLEY_SYNC_AUTH: v, ...dirs }), v).toThrow(/GALLEY_SYNC_AUTH/);
    }
  });

  it("unset / empty / 'off' → open rooms (default unchanged)", () => {
    for (const v of [undefined, "", "  ", "off", "OFF", " off "]) {
      expect(buildSyncOptions(v === undefined ? {} : { GALLEY_SYNC_AUTH: v }), String(v)).toEqual({});
    }
  });
});

// #22.2 hardening A: Origin allowlist (default OFF), parsed like compile's
// ALLOWED_ORIGINS and INDEPENDENT of auth.
describe("buildSyncOptions — GALLEY_SYNC_ALLOWED_ORIGINS (CSWSH defense, default OFF)", () => {
  it("parseAllowedOrigins mirrors compile's parse: comma-split, trimmed, blanks dropped", () => {
    expect(parseAllowedOrigins({})).toEqual([]);
    expect(parseAllowedOrigins({ GALLEY_SYNC_ALLOWED_ORIGINS: "" })).toEqual([]);
    expect(parseAllowedOrigins({ GALLEY_SYNC_ALLOWED_ORIGINS: "  ,  " })).toEqual([]);
    expect(
      parseAllowedOrigins({ GALLEY_SYNC_ALLOWED_ORIGINS: " https://a.test , https://b.test ,," }),
    ).toEqual(["https://a.test", "https://b.test"]);
  });

  it("UNSET origins, no auth: config stays byte-for-byte `{}` (open path unchanged)", () => {
    expect(buildSyncOptions({})).toEqual({});
    expect(buildSyncOptions({ GALLEY_SYNC_ALLOWED_ORIGINS: "" })).toEqual({});
    expect(buildSyncOptions({ GALLEY_SYNC_ALLOWED_ORIGINS: "  ,  " })).toEqual({});
  });

  it("SET origins, no auth: attaches allowedOrigins (still no auth gate)", () => {
    const opts = buildSyncOptions({ GALLEY_SYNC_ALLOWED_ORIGINS: "https://app.test, https://x.test" });
    expect(opts.allowedOrigins).toEqual(["https://app.test", "https://x.test"]);
    expect(opts.authorizeUpgrade).toBeUndefined();
  });

  it("SET origins WITH auth: both the gate AND the allowlist are present", () => {
    const opts = buildSyncOptions({
      GALLEY_SYNC_AUTH: "required",
      GALLEY_SESSION_DIR: "/data/sessions",
      GALLEY_DATA_DIR: "/data/projects",
      GALLEY_SYNC_ALLOWED_ORIGINS: "https://app.test",
    });
    expect(opts.allowedOrigins).toEqual(["https://app.test"]);
    expect(typeof opts.authorizeUpgrade).toBe("function");
  });

  it("the allowlist does NOT relax the auth fail-closed guard (missing dir still throws)", () => {
    expect(() =>
      buildSyncOptions({
        GALLEY_SYNC_AUTH: "required",
        GALLEY_SYNC_ALLOWED_ORIGINS: "https://app.test",
        // no session/data dir → must still refuse to start
      }),
    ).toThrow(/GALLEY_SESSION_DIR/);
  });
});

// B1.3 (roadmap S2): CRDT persistence (default OFF), INDEPENDENT of auth —
// `GALLEY_SYNC_PERSIST_DIR` wires an FsCrdtStore into the relay so a
// crash/restart loses no doc state. Constructing the store does no IO, so these
// stay pure config tests (no tmpdirs).
describe("buildSyncOptions — GALLEY_SYNC_PERSIST_DIR (CRDT persistence, default OFF)", () => {
  it("UNSET / blank: config stays byte-for-byte `{}` (stateless relay unchanged)", () => {
    expect(buildSyncOptions({})).toEqual({});
    expect(buildSyncOptions({ GALLEY_SYNC_PERSIST_DIR: "" })).toEqual({});
    expect(buildSyncOptions({ GALLEY_SYNC_PERSIST_DIR: "   " })).toEqual({});
  });

  it("SET: attaches an FsCrdtStore-backed crdtStore (no auth gate implied)", () => {
    const opts = buildSyncOptions({ GALLEY_SYNC_PERSIST_DIR: "/data/crdt" });
    expect(opts.crdtStore).toBeInstanceOf(FsCrdtStore);
    expect(opts.authorizeUpgrade).toBeUndefined();
    expect(opts.allowedOrigins).toBeUndefined();
  });

  it("SET with auth required: persistence and the gate coexist", () => {
    const opts = buildSyncOptions({
      GALLEY_SYNC_AUTH: "required",
      GALLEY_SESSION_DIR: "/data/sessions",
      GALLEY_DATA_DIR: "/data/projects",
      GALLEY_SYNC_ALLOWED_ORIGINS: "https://app.test",
      GALLEY_SYNC_PERSIST_DIR: "/data/crdt",
    });
    expect(opts.crdtStore).toBeInstanceOf(FsCrdtStore);
    expect(typeof opts.authorizeUpgrade).toBe("function");
  });

  it("persistence does NOT relax the auth fail-closed guards", () => {
    expect(() =>
      buildSyncOptions({
        GALLEY_SYNC_AUTH: "required",
        GALLEY_SYNC_PERSIST_DIR: "/data/crdt",
        GALLEY_SYNC_ALLOWED_ORIGINS: "https://app.test",
      }),
    ).toThrow(/GALLEY_SESSION_DIR/);
  });
});
