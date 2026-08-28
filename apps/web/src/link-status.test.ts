import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  reduceLinkStatus,
  linkStatusCue,
  createStaleTimer,
  reduceStorageCue,
  storageCue,
  STALE_AFTER_MS,
  type LinkStatus,
  type StorageCueState,
} from "./link-status.js";
import type { StorageFullInfo } from "@galley/collab";

/**
 * linkStatus phase machine (C2). apps/web vitest runs under Node, so we exercise
 * the PURE reducer + cue mapping; the React effect (subscribe onStatus, settle
 * timer) is a thin wrapper verified by typecheck + the e2e old-path pin.
 */
describe("reduceLinkStatus", () => {
  it("the FIRST connect goes online silently (the join cue owns the initial sync)", () => {
    expect(reduceLinkStatus("initial", "connected")).toBe("online");
    expect(linkStatusCue("online")).toBeNull();
  });

  it("a drop AFTER going online surfaces reconnecting", () => {
    expect(reduceLinkStatus("online", "disconnected")).toBe("reconnecting");
  });

  it("recovery shows a brief reconnected confirmation", () => {
    expect(reduceLinkStatus("reconnecting", "connected")).toBe("reconnected");
  });

  it("the settle tick auto-dismisses reconnected back to online", () => {
    expect(reduceLinkStatus("reconnected", "settle")).toBe("online");
  });

  it("a NEVER-connected drop stays quiet (H3 owns initial-sync failure, not C2)", () => {
    expect(reduceLinkStatus("initial", "disconnected")).toBe("initial");
  });

  it("dropping again inside the reconnected window returns to reconnecting", () => {
    expect(reduceLinkStatus("reconnected", "disconnected")).toBe("reconnecting");
  });

  it("duplicate edges never regress the phase (idempotent)", () => {
    expect(reduceLinkStatus("online", "connected")).toBe("online");
    expect(reduceLinkStatus("reconnecting", "disconnected")).toBe("reconnecting");
    expect(reduceLinkStatus("reconnected", "connected")).toBe("reconnected");
    // settle is a no-op outside the reconnected window
    for (const s of ["initial", "online", "reconnecting"] as const) {
      expect(reduceLinkStatus(s, "settle")).toBe(s);
    }
  });
});

describe("reduceLinkStatus — staleness degrade (L6)", () => {
  // A relay reaps a room only at conns.size===0, and link-status only moves on a
  // `disconnected` edge — so a joiner whose host quietly leaves keeps a HEALTHY
  // socket and sits in "online" forever over a dead session, no edge ever firing.
  // The `stale` timer is the only thing that can advance that quiet link; the cue
  // is deliberately hedged ("may have ended") because a quiet online link and a
  // dead-but-connected one are indistinguishable to this reducer.

  it("a quiet online link degrades to stale when the stale timer fires", () => {
    expect(reduceLinkStatus("online", "stale")).toBe("stale");
  });

  it("stale is reachable ONLY from online — every other phase ignores the timer", () => {
    // Exhaustive over prev for the `stale` event: only online descends.
    expect(reduceLinkStatus("initial", "stale")).toBe("initial");
    expect(reduceLinkStatus("reconnecting", "stale")).toBe("reconnecting");
    expect(reduceLinkStatus("reconnected", "stale")).toBe("reconnected");
    expect(reduceLinkStatus("stale", "stale")).toBe("stale");
  });

  it("a fresh connect edge recovers stale back to online (non-terminal)", () => {
    expect(reduceLinkStatus("stale", "connected")).toBe("online");
  });

  it("a drop while stale surfaces the active reconnecting cue (non-terminal)", () => {
    expect(reduceLinkStatus("stale", "disconnected")).toBe("reconnecting");
  });

  it("the settle tick is a no-op while stale (settle only clears the reconnected confirmation)", () => {
    expect(reduceLinkStatus("stale", "settle")).toBe("stale");
  });

  it("stale never sticks terminally: BOTH real edges leave it, neither lands back on stale", () => {
    // The property the design promises: from stale, every connection edge exits to
    // a live/active phase. If a future change made either edge idempotent on stale
    // (return prev), this pins it red.
    for (const edge of ["connected", "disconnected"] as const) {
      const next = reduceLinkStatus("stale", edge);
      expect(next).not.toBe("stale");
      expect(["online", "reconnecting"]).toContain(next);
    }
  });

  it("existing reconnect transitions are unchanged by the new phase", () => {
    // Byte-for-byte guard that adding `stale` didn't perturb the live path.
    expect(reduceLinkStatus("initial", "connected")).toBe("online");
    expect(reduceLinkStatus("online", "disconnected")).toBe("reconnecting");
    expect(reduceLinkStatus("reconnecting", "connected")).toBe("reconnected");
    expect(reduceLinkStatus("reconnected", "settle")).toBe("online");
    expect(reduceLinkStatus("initial", "disconnected")).toBe("initial");
  });
});

describe("linkStatusCue", () => {
  it("reconnecting is a calm warning that reassures local edits are safe", () => {
    const cue = linkStatusCue("reconnecting");
    expect(cue?.severity).toBe("warning");
    expect(cue?.message).toMatch(/reconnecting/i);
    expect(cue?.message).toMatch(/saved on this device/i);
  });

  it("reconnected is a brief info confirmation", () => {
    expect(linkStatusCue("reconnected")).toEqual({ severity: "info", message: "Reconnected." });
  });

  it("healthy phases show no banner", () => {
    expect(linkStatusCue("initial")).toBeNull();
    expect(linkStatusCue("online")).toBeNull();
  });

  it("stale is an honest, non-alarming warning that the session may have ended (L6)", () => {
    const cue = linkStatusCue("stale");
    expect(cue?.severity).toBe("warning");
    expect(cue?.message).toMatch(/session may have ended/i);
  });
});

/**
 * The re-armable staleness timer (L6). ProjectApp's effect is a thin shell around
 * this controller — it arms one on entering `online` and calls `bump()` on every
 * inbound-liveness signal (remote-origin doc update / peer awareness change). These
 * fake-timer tests are the direct proof of the RESET semantics the reducer tests
 * can't express: without the reset, EVERY healthy session would false-fire the cue
 * 90s after connect. We drive the real controller (no re-modelled replica) so the
 * test can't drift from what ProjectApp actually runs.
 */
describe("createStaleTimer — inbound-liveness reset (L6)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires exactly once after a full threshold of silence, then never again", () => {
    const onFire = vi.fn();
    createStaleTimer(onFire); // no delay arg → proves the default is STALE_AFTER_MS
    vi.advanceTimersByTime(STALE_AFTER_MS - 1);
    expect(onFire).not.toHaveBeenCalled(); // deadline not yet reached
    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledTimes(1); // fired at exactly the threshold
    vi.advanceTimersByTime(STALE_AFTER_MS * 5);
    expect(onFire).toHaveBeenCalledTimes(1); // no self-re-arm: exactly once
  });

  it("an inbound-liveness bump within the window DEFERS the deadline — a live session never trips", () => {
    const onFire = vi.fn();
    const timer = createStaleTimer(onFire);
    // Five times, go almost-silent then hear a peer: the clock keeps resetting.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(STALE_AFTER_MS - 1_000);
      timer.bump();
      expect(onFire).not.toHaveBeenCalled();
    }
    // Only a WHOLE threshold of silence after the last bump fires it, once.
    vi.advanceTimersByTime(STALE_AFTER_MS);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("a bump AFTER firing is inert — the degrade can't re-fire without a fresh timer", () => {
    const onFire = vi.fn();
    const timer = createStaleTimer(onFire);
    vi.advanceTimersByTime(STALE_AFTER_MS);
    expect(onFire).toHaveBeenCalledTimes(1);
    timer.bump(); // late liveness arriving after we already degraded
    vi.advanceTimersByTime(STALE_AFTER_MS * 3);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("stop() cancels a pending fire and is idempotent", () => {
    const onFire = vi.fn();
    const timer = createStaleTimer(onFire);
    timer.stop();
    timer.stop(); // second call must be a harmless no-op
    vi.advanceTimersByTime(STALE_AFTER_MS * 3);
    expect(onFire).not.toHaveBeenCalled();
  });
});

/**
 * B2 storage-full cue. The relay refuses a growth write and emits a
 * `messageStorageFull` frame; the connection decodes it into `StorageFullInfo`
 * and this ORTHOGONAL reducer drives a distinct, dismissible banner. There is no
 * "storage ok again" frame, so the cue clears on a reconnect edge or a user
 * dismiss, and every new frame is a fresh episode that re-shows.
 */
const info = (reason: StorageFullInfo["reason"], capBytes = 0): StorageFullInfo => ({
  reason,
  capBytes,
});

describe("reduceStorageCue — storage-full episode (B2)", () => {
  it("a storage-full event starts a visible episode carrying the decoded info", () => {
    const s = reduceStorageCue(null, { type: "storage-full", info: info("content-cap", 1_000) });
    expect(s).toEqual({
      info: { reason: "content-cap", capBytes: 1_000 },
      dismissed: false,
      sawDisconnect: false,
    });
    expect(storageCue(s)).not.toBeNull();
  });

  it("dismiss hides the current episode but keeps it in state (so a reconnect still clears)", () => {
    let s = reduceStorageCue(null, { type: "storage-full", info: info("content-cap") });
    s = reduceStorageCue(s, { type: "dismiss" });
    expect(s?.dismissed).toBe(true);
    expect(storageCue(s)).toBeNull(); // dismissed → no banner
  });

  it("a NEW storage-full event re-shows the cue even after a dismiss (each frame is a new episode)", () => {
    let s = reduceStorageCue(null, { type: "storage-full", info: info("content-cap") });
    s = reduceStorageCue(s, { type: "dismiss" });
    s = reduceStorageCue(s, { type: "storage-full", info: info("log-ceiling", 42) });
    expect(s?.dismissed).toBe(false);
    expect(s?.info).toEqual({ reason: "log-ceiling", capBytes: 42 });
    expect(storageCue(s)).not.toBeNull();
  });

  it("a reconnect edge (connected AFTER disconnected) clears the episode", () => {
    let s = reduceStorageCue(null, { type: "storage-full", info: info("content-cap") });
    s = reduceStorageCue(s, { type: "disconnected" });
    s = reduceStorageCue(s, { type: "connected" });
    expect(s).toBeNull();
  });

  it("a bare connected with NO preceding drop does NOT clear (only a real reconnect heals)", () => {
    let s = reduceStorageCue(null, { type: "storage-full", info: info("content-cap") });
    s = reduceStorageCue(s, { type: "connected" });
    expect(s).not.toBeNull(); // no disconnect seen → not a reconnect
    expect(storageCue(s)).not.toBeNull();
  });

  it("a reconnect clears even a DISMISSED episode (a fresh sync re-offers the diff)", () => {
    let s = reduceStorageCue(null, { type: "storage-full", info: info("content-cap") });
    s = reduceStorageCue(s, { type: "dismiss" });
    s = reduceStorageCue(s, { type: "disconnected" });
    s = reduceStorageCue(s, { type: "connected" });
    expect(s).toBeNull();
  });

  it("does NOT auto-clear on peer liveness: there is no liveness event, and a drop alone keeps it shown", () => {
    // The reducer has NO inbound-liveness input by design — others' edits flowing
    // in must never clear the cue (yours may still not be reaching the room). A
    // `disconnected` only ARMS the reconnect-clear; the cue stays visible.
    let s = reduceStorageCue(null, { type: "storage-full", info: info("content-cap") });
    s = reduceStorageCue(s, { type: "disconnected" });
    expect(s?.sawDisconnect).toBe(true);
    expect(storageCue(s)).not.toBeNull();
  });

  it("edges on an empty (null) state are no-ops", () => {
    expect(reduceStorageCue(null, { type: "dismiss" })).toBeNull();
    expect(reduceStorageCue(null, { type: "connected" })).toBeNull();
    expect(reduceStorageCue(null, { type: "disconnected" })).toBeNull();
  });
});

describe("storageCue — banner mapping (B2)", () => {
  const shown = (reason: StorageFullInfo["reason"]): StorageCueState => ({
    info: info(reason, 1_000),
    dismissed: false,
    sawDisconnect: false,
  });

  it("content-cap is a sticky warning telling the user edits are saved locally but not syncing", () => {
    const cue = storageCue(shown("content-cap"));
    expect(cue?.severity).toBe("warning");
    expect(cue?.message).toBe(
      "Storage full — your edits are saved on this device but no longer sync to the room. Free up space to resume.",
    );
  });

  it("log-ceiling shares the SAME honest 'storage full' message (no mechanism leak)", () => {
    expect(storageCue(shown("log-ceiling"))).toEqual(storageCue(shown("content-cap")));
  });

  it("an UNKNOWN reason (open enum) also shows the generic storage-full warning", () => {
    const cue = storageCue(shown("unknown"));
    expect(cue?.severity).toBe("warning");
    expect(cue?.message).toMatch(/no longer sync to the room/);
  });

  it("quota-unavailable is a softer, transient 'sync paused … retrying' warning, distinct from the full cue", () => {
    const cue = storageCue(shown("quota-unavailable"));
    expect(cue?.severity).toBe("warning");
    expect(cue?.message).toBe(
      "Sync paused — storage service unavailable. Your edits are saved on this device; retrying.",
    );
    expect(cue?.message).not.toMatch(/Free up space/); // distinct copy from the full cue
  });

  it("no episode or a dismissed episode shows no banner", () => {
    expect(storageCue(null)).toBeNull();
    expect(storageCue({ info: info("content-cap"), dismissed: true, sawDisconnect: false })).toBeNull();
  });

  it("the storage cue copy is DISTINCT from the reconnecting/stale cues", () => {
    const storage = storageCue(shown("content-cap"));
    expect(storage?.message).not.toBe(linkStatusCue("reconnecting")?.message);
    expect(storage?.message).not.toBe(linkStatusCue("stale")?.message);
  });
});
