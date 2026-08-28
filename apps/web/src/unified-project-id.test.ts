import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fastProjectId, UNIFIED_PROJECT_KEY } from "./unified-project-id.js";

/**
 * Offline unit tests for the pure home-route project-id resolver (extracted so the
 * F13 background host can import it without the editor React tree). The M1 fix
 * depends on this returning the SAME id UnifiedRoot renders — so pin the precedence:
 * explicit > `?id=` > localStorage > null.
 */

/** A tiny in-memory localStorage so the resolver is testable in node. */
function memStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memStore());
  vi.stubGlobal("window", { location: { search: "" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fastProjectId — home-route id precedence", () => {
  it("an explicit id wins over everything", () => {
    localStorage.setItem(UNIFIED_PROJECT_KEY, "stored-id");
    vi.stubGlobal("window", { location: { search: "?id=url-id" } });
    expect(fastProjectId("explicit-id")).toBe("explicit-id");
  });

  it("falls back to ?id= when no explicit id", () => {
    vi.stubGlobal("window", { location: { search: "?id=url-id" } });
    localStorage.setItem(UNIFIED_PROJECT_KEY, "stored-id");
    expect(fastProjectId(undefined)).toBe("url-id");
  });

  it("falls back to the persisted localStorage id when no explicit/url id", () => {
    localStorage.setItem(UNIFIED_PROJECT_KEY, "stored-id");
    expect(fastProjectId(undefined)).toBe("stored-id");
  });

  it("returns null when nothing is resolvable (cold boot before mint/persist)", () => {
    expect(fastProjectId(undefined)).toBeNull();
  });
});
