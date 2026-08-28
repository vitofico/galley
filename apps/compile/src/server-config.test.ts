/**
 * Startup config resolution for the compile service (pure, no side effects).
 *
 * These pin the 2026-07 FLIP: `GALLEY_COMPILE_ISOLATION` unset now resolves to
 * `worker`, not `inline`. The resolver is strict tri-state — unset/blank ⇒
 * worker, explicit `worker`/`inline`, and ANY other value THROWS at startup. A
 * silent fallthrough on a typo (`"inlien"`, `"off"`, `"WORKER"`) would quietly
 * change isolation to the default, which is exactly the failure this rejects
 * (mirrors the fail-loud `GALLEY_COMPILE_MAX_CONCURRENCY` / `..._TIMEOUT_MS`
 * parsers). The registry-compatibility guard is separated out as a pure function
 * so both the resolver and the guard are unit-testable without booting a server.
 */
import { describe, it, expect } from "vitest";
import {
  resolveCompileIsolation,
  assertRegistryIsolationCompatible,
  REGISTRY_WORKER_INCOMPATIBLE_MESSAGE,
} from "./server-config.js";

describe("resolveCompileIsolation", () => {
  it("defaults to worker when unset (the 2026-07 flip)", () => {
    expect(resolveCompileIsolation(undefined)).toBe("worker");
  });

  it("defaults to worker on an empty / whitespace-only value", () => {
    expect(resolveCompileIsolation("")).toBe("worker");
    expect(resolveCompileIsolation("   ")).toBe("worker");
  });

  it("resolves an explicit worker", () => {
    expect(resolveCompileIsolation("worker")).toBe("worker");
    // Surrounding whitespace is tolerated (matches the sibling env parsers).
    expect(resolveCompileIsolation("  worker  ")).toBe("worker");
  });

  it("resolves an explicit inline", () => {
    expect(resolveCompileIsolation("inline")).toBe("inline");
    expect(resolveCompileIsolation("  inline  ")).toBe("inline");
  });

  it("THROWS on any other value — a typo must never silently change isolation", () => {
    // These would, under a lenient default-fallthrough, all resolve to the worker
    // default and hide the operator's intent (esp. someone who meant "inline").
    for (const bad of ["inlien", "off", "none", "0", "true", "WORKER", "Inline", "worker,inline"]) {
      expect(() => resolveCompileIsolation(bad)).toThrow(/GALLEY_COMPILE_ISOLATION/);
    }
  });
});

describe("assertRegistryIsolationCompatible", () => {
  it("throws the EXACT guard message when a registry is combined with worker isolation", () => {
    expect(() => assertRegistryIsolationCompatible("worker", "https://packages.typst.org")).toThrow(
      REGISTRY_WORKER_INCOMPATIBLE_MESSAGE,
    );
    // Pin the message verbatim (operators grep on it).
    expect(REGISTRY_WORKER_INCOMPATIBLE_MESSAGE).toBe(
      "REGISTRY_BASE_URL requires GALLEY_COMPILE_ISOLATION=inline; unset defaults to worker, and registry-aware workers are not supported yet",
    );
  });

  it("accepts a registry with inline isolation", () => {
    expect(() => assertRegistryIsolationCompatible("inline", "https://packages.typst.org")).not.toThrow();
  });

  it("accepts worker isolation when no registry is configured (unset / blank base url)", () => {
    expect(() => assertRegistryIsolationCompatible("worker", undefined)).not.toThrow();
    expect(() => assertRegistryIsolationCompatible("worker", "")).not.toThrow();
    expect(() => assertRegistryIsolationCompatible("worker", "   ")).not.toThrow();
  });

  it("accepts inline isolation with no registry", () => {
    expect(() => assertRegistryIsolationCompatible("inline", undefined)).not.toThrow();
  });
});
