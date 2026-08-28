import { describe, it, expect } from "vitest";
import { foregroundProjectId } from "./agent-background-foreground.js";
import type { Route } from "./router.js";

/**
 * Offline unit tests for the F13 "which project is foregrounded" resolver — the
 * background host SKIPS the foregrounded project (the editor owns it), so this
 * decides which projectId the host must NOT run for. Pure (node).
 *
 * M1 (security review): the home/?seed= route resolves to the SAME id UnifiedRoot
 * uses (fastProjectId(undefined)) — NOT a literal "default" — injected here as a
 * fake resolver so we pin that the resolved room id flows through.
 */

/** A fake home-id resolver standing in for fastProjectId(undefined). */
const homeId = (id: string | null) => () => id;

describe("foregroundProjectId", () => {
  it("a /p/<id> project route foregrounds that explicit id (resolver unused)", () => {
    let resolverCalls = 0;
    const fg = foregroundProjectId({ kind: "project", id: "proj-7" } as Route, "", () => {
      resolverCalls += 1;
      return "should-not-be-used";
    });
    expect(fg).toBe("proj-7");
    expect(resolverCalls).toBe(0);
  });

  it("home + ?seed resolves the SAME room id UnifiedRoot uses (NOT literal 'default')", () => {
    // The persisted/`?id=` home room — e.g. a minted proj-<random>. The host must
    // treat THIS as foreground so it never double-applies to the live editor doc.
    expect(foregroundProjectId({ kind: "home" }, "?seed=einstein", homeId("proj-abc123"))).toBe(
      "proj-abc123",
    );
  });

  it("home + ?seed with an unresolvable id (cold boot) foregrounds null", () => {
    // The grant-keyed Web-Lock still covers this narrow first-boot window.
    expect(foregroundProjectId({ kind: "home" }, "?seed=einstein", homeId(null))).toBeNull();
  });

  it("bare home (Projects page, no ?seed) foregrounds nothing — resolver not consulted", () => {
    let calls = 0;
    const r = () => {
      calls += 1;
      return "x";
    };
    expect(foregroundProjectId({ kind: "home" }, "", r)).toBeNull();
    expect(foregroundProjectId({ kind: "home" }, "?id=abc", r)).toBeNull();
    expect(calls).toBe(0);
  });

  it("library / settings foreground nothing (no editor project open)", () => {
    expect(foregroundProjectId({ kind: "library" }, "", homeId("x"))).toBeNull();
    expect(foregroundProjectId({ kind: "settings" }, "", homeId("x"))).toBeNull();
  });

  it("a join route (a visited shared room) foregrounds nothing — never an owned project", () => {
    expect(foregroundProjectId({ kind: "join", room: "share-abc" } as Route, "", homeId("x"))).toBeNull();
  });
});
