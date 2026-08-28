/**
 * Fail-closed startup guard for the web-server's OIDC auth wiring (roadmap #4
 * hardening). `resolveAuthStores(env)` is the pure decision the entrypoint makes
 * about WHICH session/login-state stores to build.
 *
 * The security property: OIDC is only ever turned on for a networked, multi-
 * container deploy, and the sync relay validates a web-minted session by reading
 * the SAME durable session dir. In-memory sessions live only in the web process,
 * so a sync container can never see them — auth would appear "on" yet no
 * collaborator could ever be authorized (and sessions would vanish on restart).
 * That cannot possibly work cross-process, so we FAIL CLOSED: `GALLEY_AUTH_MODE=
 * oidc` without `GALLEY_SESSION_DIR` throws. The default (no-auth) path never
 * builds stores and is unaffected.
 */
import { describe, it, expect, vi } from "vitest";
import {
  resolveAuthStores,
  isOidcEnabled,
  isOidcHttpAllowed,
  resolveInternalMembershipConfig,
} from "./server-config.js";
import { FsSessionStore, FsOidcLoginStateStore } from "@galley/persistence";

describe("web-server auth store resolution — fail closed", () => {
  it("default (no auth): OIDC disabled, resolveAuthStores not reached", () => {
    expect(isOidcEnabled({})).toBe(false);
    expect(isOidcEnabled({ GALLEY_AUTH_MODE: "off" })).toBe(false);
    expect(isOidcEnabled({ GALLEY_AUTH_MODE: "oidc" })).toBe(true);
  });

  it("OIDC on + durable session dir: builds Fs (shareable) stores", () => {
    const stores = resolveAuthStores({ GALLEY_AUTH_MODE: "oidc", GALLEY_SESSION_DIR: "/data/sessions" });
    expect(stores.sessionStore).toBeInstanceOf(FsSessionStore);
    expect(stores.loginStateStore).toBeInstanceOf(FsOidcLoginStateStore);
  });

  it("OIDC on but NO session dir: refuses to start (fail closed)", () => {
    expect(() => resolveAuthStores({ GALLEY_AUTH_MODE: "oidc" })).toThrow(/GALLEY_SESSION_DIR/);
  });

  it("OIDC on but blank/whitespace session dir: refuses to start", () => {
    expect(() => resolveAuthStores({ GALLEY_AUTH_MODE: "oidc", GALLEY_SESSION_DIR: "  " })).toThrow(
      /GALLEY_SESSION_DIR/,
    );
  });

  // Strict-enum hardening on GALLEY_AUTH_MODE: a typo must fail closed, never
  // silently disable authentication.
  it("accepts the canonical token trimmed + case-insensitively (enabled)", () => {
    for (const v of ["oidc", "OIDC", "  oidc  ", "Oidc\n"]) {
      expect(isOidcEnabled({ GALLEY_AUTH_MODE: v }), v).toBe(true);
    }
  });

  it("THROWS on any unrecognized non-empty value (never disables auth on a typo)", () => {
    for (const v of ["oid", "oidcc", "on", "1", "true", "enabled", "saml"]) {
      expect(() => isOidcEnabled({ GALLEY_AUTH_MODE: v }), v).toThrow(/GALLEY_AUTH_MODE/);
    }
  });

  it("unset / empty / 'off' → auth disabled (default unchanged)", () => {
    for (const v of [undefined, "", "  ", "off", "OFF", " off "]) {
      expect(isOidcEnabled(v === undefined ? {} : { GALLEY_AUTH_MODE: v }), String(v)).toBe(false);
    }
  });
});

/**
 * `GALLEY_OIDC_ALLOW_HTTP=1` — the dev/local plain-http escape hatch, parsed
 * exactly like its sibling `GALLEY_INSECURE_COOKIES=1` (literal "1", nothing
 * else). It FAILS SECURE, not closed: unlike `GALLEY_AUTH_MODE` a typo here must
 * not throw, because the strict https posture is what a typo falls back to — the
 * worst outcome of a mistyped value is that a local dev deploy refuses to
 * discover its http IdP, never that a production deploy silently accepts one.
 */
describe("GALLEY_OIDC_ALLOW_HTTP — dev-only plain-http escape hatch", () => {
  it("unset/absent → OFF, and nothing is logged (the default, unchanged)", () => {
    const warn = vi.fn();
    expect(isOidcHttpAllowed({}, warn)).toBe(false);
    expect(isOidcHttpAllowed({ GALLEY_AUTH_MODE: "oidc", GALLEY_SESSION_DIR: "/data" }, warn)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("exactly \"1\" → ON, with EXACTLY ONE loud dev-only startup warning", () => {
    const warn = vi.fn();
    expect(isOidcHttpAllowed({ GALLEY_OIDC_ALLOW_HTTP: "1" }, warn)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toContain("GALLEY_OIDC_ALLOW_HTTP");
    expect(msg).toMatch(/http/i);
    // The warning must name the posture, not just the variable.
    expect(msg).toMatch(/local|dev/i);
    expect(msg).toMatch(/production|never/i);
    // And it must state the REAL blast radius. "Traffic is visible" would badly
    // undersell it: with discovery + JWKS fetched over an unauthenticated
    // channel, an on-path attacker serves their own key set and forges a login
    // as anyone. An operator who reads this warning must not come away thinking
    // the residual checks protect them.
    expect(msg).toMatch(/forge/i);
    expect(msg).toMatch(/any user/i);
    expect(msg).not.toMatch(/everything else stays enforced/i);
  });

  it("any other value → OFF and silent (no accidental enable, mirrors INSECURE_COOKIES)", () => {
    const warn = vi.fn();
    for (const v of ["", " ", "0", "1 ", " 1", "true", "TRUE", "yes", "on", "01", "11", "http"]) {
      expect(isOidcHttpAllowed({ GALLEY_OIDC_ALLOW_HTTP: v }, warn), JSON.stringify(v)).toBe(false);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("is independent of the auth toggle and the fail-closed store resolution", () => {
    const warn = vi.fn();
    const env = { GALLEY_AUTH_MODE: "oidc", GALLEY_SESSION_DIR: "/data/sessions", GALLEY_OIDC_ALLOW_HTTP: "1" };
    // Turning the hatch on changes NOTHING about whether auth is on or which
    // stores are built — it must never become a second way to relax those.
    expect(isOidcEnabled(env)).toBe(true);
    expect(resolveAuthStores(env).sessionStore).toBeInstanceOf(FsSessionStore);
    expect(() => resolveAuthStores({ GALLEY_AUTH_MODE: "oidc", GALLEY_OIDC_ALLOW_HTTP: "1" })).toThrow(
      /GALLEY_SESSION_DIR/,
    );
    expect(isOidcHttpAllowed(env, warn)).toBe(true);
  });
});

describe("internal membership-read config — fail loud", () => {
  const KEY = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----";
  const full = {
    GALLEY_INTERNAL_SERVICE_PUBLIC_KEY: KEY,
    GALLEY_INTERNAL_SERVICE_ISSUER: "https://cloud.galley.internal",
    GALLEY_INTERNAL_SERVICE_AUDIENCE: "galley-self-host",
    GALLEY_DATA_DIR: "/data",
  };

  it("all three service vars ABSENT → feature off (null), the default", () => {
    expect(resolveInternalMembershipConfig({})).toBeNull();
    expect(resolveInternalMembershipConfig({ GALLEY_DATA_DIR: "/data" })).toBeNull();
    // Blank/whitespace values count as absent too.
    expect(
      resolveInternalMembershipConfig({
        GALLEY_INTERNAL_SERVICE_PUBLIC_KEY: "  ",
        GALLEY_INTERNAL_SERVICE_ISSUER: "",
      }),
    ).toBeNull();
  });

  it("a PARTIAL set of the three service vars → throws (never half-wired)", () => {
    const K = "GALLEY_INTERNAL_SERVICE_PUBLIC_KEY";
    const I = "GALLEY_INTERNAL_SERVICE_ISSUER";
    const A = "GALLEY_INTERNAL_SERVICE_AUDIENCE";
    // Every single-var and every pair combination (with GALLEY_DATA_DIR present)
    // must fail loud rather than silently leave the endpoint off or half-wired.
    const partials: Array<Record<string, string>> = [
      { [K]: KEY },
      { [I]: full.GALLEY_INTERNAL_SERVICE_ISSUER },
      { [A]: full.GALLEY_INTERNAL_SERVICE_AUDIENCE },
      { [K]: KEY, [I]: full.GALLEY_INTERNAL_SERVICE_ISSUER },
      { [K]: KEY, [A]: full.GALLEY_INTERNAL_SERVICE_AUDIENCE },
      { [I]: full.GALLEY_INTERNAL_SERVICE_ISSUER, [A]: full.GALLEY_INTERNAL_SERVICE_AUDIENCE },
    ];
    for (const p of partials) {
      expect(
        () => resolveInternalMembershipConfig({ ...p, GALLEY_DATA_DIR: "/data" }),
        JSON.stringify(p),
      ).toThrow(/GALLEY_INTERNAL_SERVICE/);
    }
  });

  it("all three service vars but NO GALLEY_DATA_DIR → throws (needs the shared volume)", () => {
    expect(() =>
      resolveInternalMembershipConfig({
        GALLEY_INTERNAL_SERVICE_PUBLIC_KEY: KEY,
        GALLEY_INTERNAL_SERVICE_ISSUER: "https://cloud.galley.internal",
        GALLEY_INTERNAL_SERVICE_AUDIENCE: "galley-self-host",
      }),
    ).toThrow(/GALLEY_DATA_DIR/);
  });

  it("full config → resolved (trimmed), feature on", () => {
    const cfg = resolveInternalMembershipConfig({
      GALLEY_INTERNAL_SERVICE_PUBLIC_KEY: `  ${KEY}  `,
      GALLEY_INTERNAL_SERVICE_ISSUER: " https://cloud.galley.internal ",
      GALLEY_INTERNAL_SERVICE_AUDIENCE: " galley-self-host ",
      GALLEY_DATA_DIR: " /data ",
    });
    expect(cfg).toEqual({
      publicKeyPem: KEY,
      issuer: "https://cloud.galley.internal",
      audience: "galley-self-host",
      dataDir: "/data",
    });
  });
});
