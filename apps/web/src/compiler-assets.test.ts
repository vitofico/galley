/**
 * Roadmap #5 slice 5: runtime-config consumption — the precedence matrix and the
 * TRUST-POSTURE PINS for the serve-time `window.__GALLEY_CONFIG__` global
 * (injected by apps/web-server's same-origin /config.js).
 *
 * Pure/offline: drives `gatherServerUrlInputs` (the testable core of
 * `readServerUrlInputs`) with fake windows, then resolves through the REAL
 * `resolveServerCompileUrl` to prove end-to-end precedence AND that the SSRF
 * rules are byte-for-byte unchanged:
 *   - `?compileUrl=` (behind the legacy `?serverCompile=1` hatch ONLY) >
 *     runtime config > build-time env > localhost default (legacy hatch only);
 *   - a PLAIN link's query param can never widen egress — with or without
 *     runtime config present;
 *   - the runtime value flows through `validateCompileUrl` exactly like env
 *     (javascript:/credentials/garbage → fail closed, no silent fallback).
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_SERVER_COMPILE_URL,
  resolveServerCompileUrl,
  serverConfigured,
} from "./components/compiler-mode.js";
import { gatherServerUrlInputs, readServerUrlInputs, type UrlInputsWindow } from "./compiler-assets.js";

const RUNTIME = "http://runtime.example.com/compile";
const BUILD = "http://build.example.com/compile";
const PARAM = "http://param.example.com/compile";

/** A fake window: query string + optional runtime-config global. */
function win(search: string, config?: unknown): UrlInputsWindow {
  return config === undefined
    ? { location: { search } }
    : { location: { search }, __GALLEY_CONFIG__: config };
}

describe("gatherServerUrlInputs: raw gathering", () => {
  it("reads the runtime-config URL into the trusted envUrl slot", () => {
    const inputs = gatherServerUrlInputs(win("", { compileUrl: RUNTIME }), null);
    expect(inputs).toEqual({ compileUrlParam: null, envUrl: RUNTIME, serverCompileFlag: false });
  });

  it("falls back to the build-time env when no runtime config is present", () => {
    expect(gatherServerUrlInputs(win(""), BUILD).envUrl).toBe(BUILD);
    expect(gatherServerUrlInputs(win(""), null).envUrl).toBeNull();
    expect(gatherServerUrlInputs(win(""), undefined).envUrl).toBeNull();
  });

  it("runtime config OUTRANKS the build-time env (deploy beats image)", () => {
    expect(gatherServerUrlInputs(win("", { compileUrl: RUNTIME }), BUILD).envUrl).toBe(RUNTIME);
  });

  it("still gathers the query param + legacy flag unchanged", () => {
    const inputs = gatherServerUrlInputs(win(`?serverCompile=1&compileUrl=${PARAM}`), BUILD);
    expect(inputs.compileUrlParam).toBe(PARAM);
    expect(inputs.serverCompileFlag).toBe(true);
  });

  it("reads a malformed/hostile global DEFENSIVELY: anything unexpected = absent", () => {
    const malformed: unknown[] = [
      null,
      "a-string",
      42,
      [],
      {},
      { compileUrl: 7 },
      { compileUrl: { nested: true } },
      { compileUrl: "" },
      { compileUrl: "   " },
    ];
    for (const config of malformed) {
      expect(gatherServerUrlInputs(win("", config), BUILD).envUrl, JSON.stringify(config)).toBe(BUILD);
      expect(gatherServerUrlInputs(win("", config), null).envUrl, JSON.stringify(config)).toBeNull();
    }
  });
});

describe("precedence through the REAL resolver (trust posture pins)", () => {
  /** Resolve as the user-facing server/auto toggle does (no legacy flag). */
  function resolvePlain(config?: unknown, buildEnv: string | null = null): string | null {
    return resolveServerCompileUrl(gatherServerUrlInputs(win("", config), buildEnv));
  }

  it("runtime config > build-time env > nothing (fail closed)", () => {
    expect(resolvePlain({ compileUrl: RUNTIME }, BUILD)).toBe(RUNTIME);
    expect(resolvePlain(undefined, BUILD)).toBe(BUILD);
    expect(resolvePlain(undefined, null)).toBeNull();
  });

  it("PIN: a plain link's ?compileUrl= can NEVER widen egress — with or without runtime config", () => {
    // No legacy flag → the query param is ignored exactly as before slice 5.
    const withParamOnly = gatherServerUrlInputs(win(`?compileUrl=${PARAM}`), null);
    expect(resolveServerCompileUrl(withParamOnly)).toBeNull();
    expect(serverConfigured(withParamOnly)).toBe(false);
    // Runtime config present: the param STILL doesn't win — the trusted source does.
    const withBoth = gatherServerUrlInputs(win(`?compileUrl=${PARAM}`, { compileUrl: RUNTIME }), BUILD);
    expect(resolveServerCompileUrl(withBoth)).toBe(RUNTIME);
  });

  it("legacy ?serverCompile=1 hatch: ?compileUrl= > runtime config > build env > localhost default", () => {
    const flag = "?serverCompile=1";
    expect(
      resolveServerCompileUrl(gatherServerUrlInputs(win(`${flag}&compileUrl=${PARAM}`, { compileUrl: RUNTIME }), BUILD)),
    ).toBe(PARAM);
    expect(resolveServerCompileUrl(gatherServerUrlInputs(win(flag, { compileUrl: RUNTIME }), BUILD))).toBe(RUNTIME);
    expect(resolveServerCompileUrl(gatherServerUrlInputs(win(flag), BUILD))).toBe(BUILD);
    expect(resolveServerCompileUrl(gatherServerUrlInputs(win(flag), null))).toBe(DEFAULT_SERVER_COMPILE_URL);
  });

  it("PIN: the runtime value flows through validateCompileUrl exactly like env (fail closed)", () => {
    // Invalid schemes / credentials / garbage NEVER resolve — and there is no
    // silent fallback to the baked build-time URL the operator overrode.
    for (const bad of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,x",
      "http://user:pass@evil.example.com/compile",
      "not a url",
    ]) {
      expect(resolvePlain({ compileUrl: bad }, BUILD), bad).toBeNull();
      expect(serverConfigured(gatherServerUrlInputs(win("", { compileUrl: bad }), BUILD)), bad).toBe(false);
    }
    // A valid https runtime URL resolves (normalized by the validator).
    expect(resolvePlain({ compileUrl: "https://ok.example.com/compile" })).toBe(
      "https://ok.example.com/compile",
    );
  });
});

describe("readServerUrlInputs (live-window wrapper)", () => {
  it("returns empty inputs in non-browser contexts (node test env: no window)", () => {
    expect(typeof window).toBe("undefined");
    expect(readServerUrlInputs()).toEqual({});
  });
});
