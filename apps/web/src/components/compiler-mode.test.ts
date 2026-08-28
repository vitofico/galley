import { describe, it, expect, vi } from "vitest";
import {
  COMPILE_MODE_KEY,
  COMPILE_MODES,
  DEFAULT_MODE,
  DEFAULT_SERVER_COMPILE_URL,
  FALLBACK_REASON,
  PACKAGES_ON_SERVER_REASON,
  PACKAGES_UNAVAILABLE_REASON,
  SERVER_UNAVAILABLE_REASON,
  createFallbackState,
  cycleMode,
  isCompileMode,
  loadMode,
  markFallbackActive,
  resolveInitialMode,
  resolvePackageAwareTransport,
  resolveServerCompileUrl,
  resolveTransport,
  saveMode,
  serverConfigured,
  shouldFallback,
  validateCompileUrl,
} from "./compiler-mode.js";

/**
 * Unit tests for the PURE compile-mode logic (Enabler E2).
 *
 * The vitest env is `node` (no DOM) — storage is exercised via an injected
 * double, mirroring `theme.test.ts`. The load-bearing invariants asserted here:
 *   - the DEFAULT stays "local" (no silent default change);
 *   - server/auto FAIL CLOSED to the worker when no compile URL is configured;
 *   - fallback is ONE-SHOT and visible (a reason string, never silent).
 */

function makeStorage(seed?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    getItem: vi.fn((k: string) => (map.has(k) ? map.get(k)! : null)),
    setItem: vi.fn((k: string, v: string) => {
      map.set(k, v);
    }),
    _map: map,
  };
}

describe("mode constants", () => {
  it("the default mode is local (no silent default change)", () => {
    expect(DEFAULT_MODE).toBe("local");
  });

  it("cycles local → server → auto → local", () => {
    expect(COMPILE_MODES).toEqual(["local", "server", "auto"]);
  });

  it("the storage key is the namespaced galley key", () => {
    expect(COMPILE_MODE_KEY).toBe("galley.compiler.mode");
  });
});

describe("isCompileMode", () => {
  it("accepts the three known modes", () => {
    expect(isCompileMode("local")).toBe(true);
    expect(isCompileMode("server")).toBe(true);
    expect(isCompileMode("auto")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isCompileMode("remote")).toBe(false);
    expect(isCompileMode("")).toBe(false);
    expect(isCompileMode(null)).toBe(false);
    expect(isCompileMode(undefined)).toBe(false);
    expect(isCompileMode(1)).toBe(false);
  });
});

describe("resolveInitialMode (pure)", () => {
  it("a valid stored mode wins", () => {
    expect(resolveInitialMode("server")).toBe("server");
    expect(resolveInitialMode("auto")).toBe("auto");
    expect(resolveInitialMode("local")).toBe("local");
  });

  it("falls back to the default for missing / corrupt / hostile values", () => {
    expect(resolveInitialMode(null)).toBe("local");
    expect(resolveInitialMode("")).toBe("local");
    expect(resolveInitialMode("REMOTE; DROP TABLE")).toBe("local");
  });
});

describe("cycleMode", () => {
  it("advances through the modes and wraps", () => {
    expect(cycleMode("local")).toBe("server");
    expect(cycleMode("server")).toBe("auto");
    expect(cycleMode("auto")).toBe("local");
  });
});

describe("persistence (injected storage)", () => {
  it("loadMode returns the default when nothing stored", () => {
    const storage = makeStorage();
    expect(loadMode(storage)).toBe("local");
  });

  it("loadMode returns a valid stored mode", () => {
    const storage = makeStorage({ [COMPILE_MODE_KEY]: "auto" });
    expect(loadMode(storage)).toBe("auto");
  });

  it("loadMode ignores a corrupt stored value", () => {
    const storage = makeStorage({ [COMPILE_MODE_KEY]: "garbage" });
    expect(loadMode(storage)).toBe("local");
  });

  it("loadMode falls back to default when storage is unavailable", () => {
    expect(loadMode(null)).toBe("local");
  });

  it("saveMode persists under the namespaced key", () => {
    const storage = makeStorage();
    saveMode("server", storage);
    expect(storage.setItem).toHaveBeenCalledWith(COMPILE_MODE_KEY, "server");
    expect(storage._map.get(COMPILE_MODE_KEY)).toBe("server");
  });

  it("saveMode is a no-op (never throws) when storage is unavailable", () => {
    expect(() => saveMode("auto", null)).not.toThrow();
  });

  it("a save then load round-trips", () => {
    const storage = makeStorage();
    saveMode("auto", storage);
    expect(loadMode(storage)).toBe("auto");
  });
});

describe("validateCompileUrl (SSRF guard)", () => {
  it("accepts http and https URLs and normalizes them", () => {
    expect(validateCompileUrl("https://compile.example/c")).toBe("https://compile.example/c");
    expect(validateCompileUrl("http://localhost:3001/compile")).toBe(
      "http://localhost:3001/compile",
    );
  });

  it("rejects non-http(s) protocols", () => {
    expect(validateCompileUrl("file:///etc/passwd")).toBeNull();
    expect(validateCompileUrl("javascript:alert(1)")).toBeNull();
    expect(validateCompileUrl("data:text/plain,hi")).toBeNull();
    expect(validateCompileUrl("ftp://host/x")).toBeNull();
  });

  it("rejects URLs carrying embedded credentials", () => {
    expect(validateCompileUrl("https://user:pass@evil.example/c")).toBeNull();
    expect(validateCompileUrl("https://user@evil.example/c")).toBeNull();
  });

  it("rejects unparseable / empty values (fail closed)", () => {
    expect(validateCompileUrl("not a url")).toBeNull();
    expect(validateCompileUrl("")).toBeNull();
    expect(validateCompileUrl(null)).toBeNull();
    expect(validateCompileUrl(undefined)).toBeNull();
  });
});

describe("resolveServerCompileUrl (trust-aware, SSRF defense)", () => {
  it("user-facing (no legacy flag): a hostile ?compileUrl= is IGNORED", () => {
    // The canonical attack: a shared link pointing compilation at an attacker.
    expect(
      resolveServerCompileUrl({ compileUrlParam: "https://evil.example/compile" }),
    ).toBeNull();
  });

  it("user-facing: a hostile ?compileUrl= does NOT override the trusted env URL", () => {
    expect(
      resolveServerCompileUrl({
        compileUrlParam: "https://evil.example/compile",
        envUrl: "https://trusted.example/c",
      }),
    ).toBe("https://trusted.example/c");
  });

  it("user-facing: trusts env ONLY", () => {
    expect(resolveServerCompileUrl({ envUrl: "https://trusted.example/c" })).toBe(
      "https://trusted.example/c",
    );
  });

  it("legacy flag: ?compileUrl= IS honoured (dev/e2e escape hatch) and wins", () => {
    expect(
      resolveServerCompileUrl({
        compileUrlParam: "http://localhost:3001/compile",
        envUrl: "https://trusted.example/c",
        serverCompileFlag: true,
      }),
    ).toBe("http://localhost:3001/compile");
  });

  it("legacy flag: a hostile-protocol ?compileUrl= is still rejected, falls through to env", () => {
    expect(
      resolveServerCompileUrl({
        compileUrlParam: "file:///etc/passwd",
        envUrl: "https://trusted.example/c",
        serverCompileFlag: true,
      }),
    ).toBe("https://trusted.example/c");
  });

  it("legacy flag: the localhost default is ONLY available behind the flag", () => {
    expect(resolveServerCompileUrl({ serverCompileFlag: true })).toBe(DEFAULT_SERVER_COMPILE_URL);
  });

  it("returns null (FAIL CLOSED) when nothing trusted is configured", () => {
    expect(resolveServerCompileUrl({})).toBeNull();
    expect(resolveServerCompileUrl({ compileUrlParam: "", envUrl: "" })).toBeNull();
    expect(resolveServerCompileUrl({ serverCompileFlag: false })).toBeNull();
    // A hostile credentialed env URL is rejected too (defense in depth).
    expect(resolveServerCompileUrl({ envUrl: "https://u:p@evil/c" })).toBeNull();
  });

  it("serverConfigured mirrors url resolution", () => {
    expect(serverConfigured({ envUrl: "https://x/c" })).toBe(true);
    expect(serverConfigured({})).toBe(false);
    expect(serverConfigured({ compileUrlParam: "https://evil/c" })).toBe(false);
  });
});

describe("resolveTransport", () => {
  it("local always uses the worker", () => {
    expect(resolveTransport("local", { envUrl: "https://x/c" })).toEqual({
      transport: "worker",
      downgradeReason: null,
    });
  });

  it("server uses remote when a URL is configured", () => {
    expect(resolveTransport("server", { envUrl: "https://x/c" })).toEqual({
      transport: "remote",
      downgradeReason: null,
    });
  });

  it("server FAILS CLOSED to the worker (with a GENERIC visible reason) when unconfigured", () => {
    const r = resolveTransport("server", {});
    expect(r.transport).toBe("worker");
    expect(r.downgradeReason).toBe(SERVER_UNAVAILABLE_REASON);
    // The reason carries no error text / URL.
    expect(r.downgradeReason).not.toMatch(/https?:|error|\//i);
  });

  it("a hostile ?compileUrl= cannot make server mode go remote (SSRF)", () => {
    const r = resolveTransport("server", { compileUrlParam: "https://evil.example/compile" });
    expect(r.transport).toBe("worker");
    expect(r.downgradeReason).toBe(SERVER_UNAVAILABLE_REASON);
  });

  it("auto starts on the worker (fallback happens after a failure)", () => {
    expect(resolveTransport("auto", { envUrl: "https://x/c" })).toEqual({
      transport: "worker",
      downgradeReason: null,
    });
  });
});

describe("resolvePackageAwareTransport (@preview egress policy)", () => {
  const TRUSTED = { envUrl: "https://trusted.example/c" };

  it("no packages → identical to resolveTransport (no behaviour change)", () => {
    for (const mode of ["local", "server", "auto"] as const) {
      for (const inputs of [TRUSTED, {}]) {
        expect(resolvePackageAwareTransport(mode, inputs, false)).toEqual(
          resolveTransport(mode, inputs),
        );
      }
    }
  });

  it("auto + packages + trusted server URL → remote, VISIBLE package reason", () => {
    const r = resolvePackageAwareTransport("auto", TRUSTED, true);
    expect(r.transport).toBe("remote");
    expect(r.downgradeReason).toBe(PACKAGES_ON_SERVER_REASON);
    expect(r.packagesUnavailable).toBeUndefined();
  });

  it("auto + packages + NO trusted URL → FAIL CLOSED packages-unavailable (no egress)", () => {
    const r = resolvePackageAwareTransport("auto", {}, true);
    expect(r.transport).toBe("worker");
    expect(r.downgradeReason).toBe(PACKAGES_UNAVAILABLE_REASON);
    expect(r.packagesUnavailable).toBe(true);
  });

  it("auto + packages + hostile ?compileUrl= alone → FAIL CLOSED (SSRF defense)", () => {
    // The untrusted query param must NOT be enough to license document egress.
    const r = resolvePackageAwareTransport(
      "auto",
      { compileUrlParam: "https://evil.example/compile" },
      true,
    );
    expect(r.transport).toBe("worker");
    expect(r.packagesUnavailable).toBe(true);
    expect(r.downgradeReason).toBe(PACKAGES_UNAVAILABLE_REASON);
  });

  it("local + packages → STILL local worker, never networks (explicit never-egress)", () => {
    // Even though the worker will fail on the package, we respect the user's
    // explicit local choice and do NOT auto-upgrade to the server.
    const r = resolvePackageAwareTransport("local", TRUSTED, true);
    expect(r).toEqual({ transport: "worker", downgradeReason: null });
    expect(r.packagesUnavailable).toBeUndefined();
  });

  it("server + packages + trusted URL → remote (unchanged server behaviour)", () => {
    expect(resolvePackageAwareTransport("server", TRUSTED, true)).toEqual({
      transport: "remote",
      downgradeReason: null,
    });
  });

  it("server + packages + no URL → unchanged fail-closed (SERVER_UNAVAILABLE, not packages)", () => {
    const r = resolvePackageAwareTransport("server", {}, true);
    expect(r.transport).toBe("worker");
    expect(r.downgradeReason).toBe(SERVER_UNAVAILABLE_REASON);
    expect(r.packagesUnavailable).toBeUndefined();
  });

  it("the package reasons leak NO URL / host / document content (info-leak defense)", () => {
    for (const reason of [PACKAGES_ON_SERVER_REASON, PACKAGES_UNAVAILABLE_REASON]) {
      expect(reason).not.toMatch(/https?:|trusted\.example|localhost|\/c\b/i);
      expect(reason).not.toMatch(/Error|\(/);
    }
    // The unavailable reason must not hint that a server could have helped.
    expect(PACKAGES_UNAVAILABLE_REASON).not.toMatch(/server/i);
  });
});

describe("one-shot fallback (auto)", () => {
  it("a fresh state is inactive with no reason", () => {
    const s = createFallbackState();
    expect(s.active).toBe(false);
    expect(s.reason).toBeNull();
  });

  it("auto with a configured server falls back exactly once", () => {
    const inputs = { envUrl: "https://x/c" };
    let state = createFallbackState();
    expect(shouldFallback("auto", state, inputs)).toBe(true);
    state = markFallbackActive();
    // Latched: a second failure does NOT trigger another fallback.
    expect(shouldFallback("auto", state, inputs)).toBe(false);
    expect(state.active).toBe(true);
    expect(state.reason).toBe(FALLBACK_REASON);
  });

  it("auto does NOT fall back when no server is configured (fail closed)", () => {
    expect(shouldFallback("auto", createFallbackState(), {})).toBe(false);
  });

  it("auto does NOT fall back on a hostile ?compileUrl= alone (SSRF + fail closed)", () => {
    expect(
      shouldFallback("auto", createFallbackState(), {
        compileUrlParam: "https://evil.example/compile",
      }),
    ).toBe(false);
  });

  it("local never falls back", () => {
    expect(shouldFallback("local", createFallbackState(), { envUrl: "https://x/c" })).toBe(false);
  });

  it("server never falls back (it is already remote)", () => {
    expect(shouldFallback("server", createFallbackState(), { envUrl: "https://x/c" })).toBe(false);
  });

  it("markFallbackActive returns a new object and never mutates the input", () => {
    const before = createFallbackState();
    const after = markFallbackActive();
    expect(after).not.toBe(before);
    expect(before.active).toBe(false);
    expect(after.active).toBe(true);
  });

  it("the visible fallback reason is GENERIC — no error text, no URL (info-leak defense)", () => {
    expect(FALLBACK_REASON).toBe("Local compiler failed; using the server compiler.");
    // Must never carry a parenthetical detail, a path, or a URL.
    expect(FALLBACK_REASON).not.toMatch(/\(|https?:|\/etc|Error/);
    expect(markFallbackActive().reason).toBe(FALLBACK_REASON);
  });
});
