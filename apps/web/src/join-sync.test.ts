import { describe, it, expect } from "vitest";
import { joinPhaseOnTimeout, joinSyncCue } from "./join-sync.js";

/**
 * joinSync cue (H3). The timeout must go LOUD when the relay never reached the
 * joiner, instead of silently clearing to a blank-looking doc.
 */
describe("joinPhaseOnTimeout", () => {
  it("resolves to done when the relay's state already arrived", () => {
    expect(joinPhaseOnTimeout(true)).toBe("done");
  });

  it("goes stalled (loud) when the room was never reached by the timeout", () => {
    expect(joinPhaseOnTimeout(false)).toBe("stalled");
  });
});

describe("joinSyncCue", () => {
  it("syncing is a calm info cue, keeping the historical join-syncing testid", () => {
    expect(joinSyncCue("syncing")).toEqual({
      severity: "info",
      message: "Syncing the shared document…",
      testId: "join-syncing",
    });
  });

  it("stalled is a warning that the room couldn't be reached, under a distinct testid", () => {
    const cue = joinSyncCue("stalled");
    expect(cue?.severity).toBe("warning");
    expect(cue?.message).toMatch(/couldn't reach the room/i);
    expect(cue?.testId).toBe("join-stalled");
  });

  it("a resolved join shows no banner", () => {
    expect(joinSyncCue("done")).toBeNull();
  });
});
