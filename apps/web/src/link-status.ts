/**
 * `linkStatus` (corrections C2) — the pure phase machine behind the collaboration
 * connection cue. `CollabConnection.onStatus` emits only "connected"/"disconnected"
 * on every (re)open and drop, but nothing consumed it — so a dropped relay socket
 * was completely invisible while edits buffered into a dead outbox. This reducer
 * turns that raw stream into a calm UI phase: a "Reconnecting…" cue on a drop and a
 * brief "Reconnected." confirmation on recovery.
 *
 * Crucially it distinguishes the FIRST connect (covered by the separate join
 * "Syncing…" cue — no banner) from a RECONNECT, and stays quiet on a
 * never-connected drop (a relay unreachable on join is H3's territory, not a
 * "reconnect"). L6 adds a `stale` degrade: a link that stays "online" but hears
 * NOTHING from any peer past {@link STALE_AFTER_MS} — the case a `disconnected`
 * edge can never catch, e.g. a joiner whose host left while the relay socket
 * stayed healthy — surfaces an honest "This session may have ended" until any real
 * edge recovers it. The staleness timer is re-armed by every inbound-liveness
 * signal (a remote-origin doc update or a peer's awareness change), so a live,
 * co-editing session never trips it (see {@link createStaleTimer}). The reducer
 * and cue stay pure + Node-unit-tested; the React effect over it is a thin
 * subscribe-and-dispatch wrapper with `settle` and `stale` timers.
 */
import type { NoticeSeverity } from "./components/Notice.js";
import type { StorageFullInfo } from "@galley/collab";

export type LinkStatus = "initial" | "online" | "reconnecting" | "reconnected" | "stale";

/**
 * The events that advance the machine: the connection's two status edges, a
 * `settle` tick (a timer fired ~3s after entering "reconnected" to auto-dismiss
 * the confirmation), and a `stale` tick (L6 — see {@link STALE_AFTER_MS}).
 */
export type LinkEvent = "connected" | "disconnected" | "settle" | "stale";

/**
 * L6: how long a link may stay "online" WITHOUT hearing from any peer before it
 * honestly degrades to `stale`. The relay reaps a room only at conns.size===0 and
 * `onStatus` fires only on a real (re)open/drop — so a joiner whose host quietly
 * leaves keeps a HEALTHY socket to the relay and never sees a `disconnected` edge;
 * it sits "online" forever over a dead session. No edge will ever arrive, so a
 * timer is the only thing that can advance it.
 *
 * The timer is RE-ARMED on every inbound-liveness signal the app already receives
 * — a remote-origin doc update or a peer's awareness change (see
 * {@link createStaleTimer} and the ProjectApp effect) — so the cue fires ONLY when
 * the client has been online and heard nothing from anyone for this long, i.e.
 * genuinely "alone and quiet". Active or cursor-moving co-editing never trips it.
 *
 * 90s = 3× y-protocols' `outdatedTimeout` (30s). Even a fully-idle present peer is
 * NOT silent on the wire: the stock `Awareness` galley instantiates runs an
 * internal ~3s tick that renews the local client's state once it is older than
 * `outdatedTimeout / 2` (~15s), and the connection broadcasts that renewal — so an
 * alive room always delivers an inbound-liveness bump roughly every ~15s, far
 * inside this window. (Its sibling reaper prunes a peer gone >30s with origin
 * `'timeout'`, not the connection, so a reap never falsely bumps.) Net: only a
 * client that is GENUINELY alone — no renewals arriving — degrades, and only after
 * a full 3× the interval at which any live peer would have checked in.
 */
export const STALE_AFTER_MS = 90_000;

/**
 * L6: the re-armable staleness timer behind ProjectApp's `stale` degrade,
 * extracted so the reset semantics are unit-tested directly (fake timers) rather
 * than buried in a React effect. It arms a single timeout on creation; `bump()` —
 * called on every inbound-liveness signal — defers the deadline by clearing and
 * re-arming. `onFire` runs AT MOST ONCE per timer: once it has fired (or `stop()`
 * was called) the controller is inert, so a late `bump()` can never re-fire it;
 * the caller builds a fresh timer only when the link returns to `online`. Uses the
 * ambient timer functions so a fake-timer test drives it deterministically and
 * ProjectApp gets real timeouts.
 */
export function createStaleTimer(
  onFire: () => void,
  delayMs: number = STALE_AFTER_MS,
): { bump: () => void; stop: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined = setTimeout(fire, delayMs);
  function fire(): void {
    handle = undefined;
    onFire();
  }
  return {
    /** Inbound liveness: defer the deadline. Inert once fired/stopped. */
    bump(): void {
      if (handle === undefined) return;
      clearTimeout(handle);
      handle = setTimeout(fire, delayMs);
    },
    /** Cancel the pending fire. Idempotent. */
    stop(): void {
      if (handle === undefined) return;
      clearTimeout(handle);
      handle = undefined;
    },
  };
}

/**
 * PURE: advance the link phase.
 *
 *  - `initial + connected`      → `online`        (first connect; the join cue covers it — no banner)
 *  - `online + disconnected`    → `reconnecting`  (a drop AFTER we were live → "Reconnecting…")
 *  - `reconnecting + connected` → `reconnected`   (recovery → a brief "Reconnected.")
 *  - `reconnected + settle`     → `online`        (auto-dismiss the confirmation)
 *  - `reconnected + disconnected` → `reconnecting` (dropped again inside the window)
 *  - `initial + disconnected`   → `initial`       (never-connected: stay quiet, H3 owns that copy)
 *  - `online + stale`           → `stale`         (L6: quiet too long → "This session may have ended")
 *  - `stale + connected`        → `online`        (a fresh open is unambiguous liveness → recover)
 *  - `stale + disconnected`     → `reconnecting`  (a real drop while stale → the active recovery cue)
 *
 * The `stale` phase is reachable ONLY from `online` (a healthy link that has gone
 * quiet); it never overrides an active `reconnecting`/`reconnected` cue and never
 * fabricates a session over a never-connected link. It is strictly non-terminal:
 * either connection edge exits it. All other pairs are idempotent (a duplicate
 * edge never regresses the phase).
 */
export function reduceLinkStatus(prev: LinkStatus, event: LinkEvent): LinkStatus {
  switch (event) {
    case "connected":
      if (prev === "initial") return "online";
      if (prev === "reconnecting") return "reconnected";
      if (prev === "stale") return "online"; // a live open recovers a stale link
      return prev;
    case "disconnected":
      if (prev === "initial") return "initial";
      return "reconnecting";
    case "settle":
      return prev === "reconnected" ? "online" : prev;
    case "stale":
      // Only a quiet, healthy link degrades; every other phase ignores the timer.
      return prev === "online" ? "stale" : prev;
  }
}

export interface LinkCue {
  severity: NoticeSeverity;
  message: string;
}

/**
 * PURE: the calm banner for a phase, or `null` when none should show (a healthy
 * `online`/`initial` link is silent — no always-on chrome).
 */
export function linkStatusCue(status: LinkStatus): LinkCue | null {
  switch (status) {
    case "reconnecting":
      return {
        severity: "warning",
        message:
          "Reconnecting… your edits are saved on this device and will sync when the connection returns.",
      };
    case "reconnected":
      return { severity: "info", message: "Reconnected." };
    case "stale":
      // L6: honest and hedged — the client genuinely cannot tell a quiet-but-live
      // link from a dead one, so it never asserts the session ended. A reload
      // re-joins the room and re-syncs presence, which is the real way to be sure.
      return {
        severity: "warning",
        message:
          "This session may have ended — reload to check who's still connected. Your edits are saved on this device.",
      };
    case "initial":
    case "online":
      return null;
  }
}

/**
 * B2 storage-full cue — ORTHOGONAL to the link phase above. The relay emits a
 * `messageStorageFull` control frame when it refuses a growth write (a room
 * storage cap was hit); `CollabConnection.onStorageFull` decodes it. This is a
 * DISTINCT condition from stale/reconnecting: the socket is perfectly healthy,
 * but the user's edits are no longer reaching the room. y-sync has no per-update
 * ack, so WITHOUT this cue sync LOOKS fine while the local doc silently diverges.
 *
 * There is NO "storage ok again" frame, so recovery is not directly observable.
 * The cue is therefore (a) DISMISSIBLE by the user and (b) auto-cleared on a real
 * RECONNECT edge — a `connected` that follows a `disconnected`, i.e. a fresh sync
 * exchange re-offers the full diff, which either heals or immediately triggers a
 * NEW frame that re-shows the cue. A new storage-full frame is a new "episode"
 * and ALWAYS re-shows, dismissed or not (per the wire contract, each frame is a
 * fresh episode). We deliberately do NOT auto-clear on inbound peer liveness:
 * others' edits flowing IN does not mean yours are flowing OUT — there is no
 * liveness event in this reducer at all.
 */
export type StorageCueEvent =
  | { type: "storage-full"; info: StorageFullInfo }
  | { type: "dismiss" }
  | { type: "connected" }
  | { type: "disconnected" };

/** The live storage-full episode (or `null` when none is active). */
export interface StorageCueState {
  info: StorageFullInfo;
  /** The user hid THIS episode's cue; a NEW storage-full frame re-shows it. */
  dismissed: boolean;
  /** A `disconnected` edge has occurred since this episode began — so the paired
   *  `connected` edge is the reconnect that clears the cue (a bare `connected`
   *  with no preceding drop is not a reconnect and leaves the cue in place). */
  sawDisconnect: boolean;
}

/**
 * PURE: advance the storage-full cue. `null` = no active episode (render nothing).
 *  - `storage-full` → (re)start an episode: visible again, edge tracking reset.
 *  - `dismiss`      → hide the current episode (kept in state so a later reconnect still clears it).
 *  - `disconnected` → remember the drop (arms the reconnect-clear); the cue stays shown.
 *  - `connected`    → if a drop preceded it, this is a reconnect → clear; otherwise a no-op.
 *
 * A duplicate/idle edge never regresses an episode; a `connected`/`disconnected`
 * on an empty state is a no-op (no episode to arm or clear).
 */
export function reduceStorageCue(
  prev: StorageCueState | null,
  event: StorageCueEvent,
): StorageCueState | null {
  switch (event.type) {
    case "storage-full":
      return { info: event.info, dismissed: false, sawDisconnect: false };
    case "dismiss":
      return prev === null ? null : { ...prev, dismissed: true };
    case "disconnected":
      return prev === null ? null : { ...prev, sawDisconnect: true };
    case "connected":
      if (prev === null) return null;
      // A reconnect (connected AFTER a disconnected) heals the episode: the fresh
      // sync exchange re-offers the diff; if the room still refuses it, a NEW
      // storage-full frame re-shows the cue. A bare connect (no prior drop) is
      // not a reconnect — leave the cue as-is.
      return prev.sawDisconnect ? null : prev;
  }
}

/**
 * PURE: the banner for a storage-cue state, or `null` when none should show (no
 * episode, or the user dismissed it). Reuses the {@link LinkCue} shape + severity
 * vocabulary. Both variants are `warning` (edits are safe locally but genuinely
 * not syncing); the softer/transient flavor of `quota-unavailable` is carried by
 * the WORDING, not a lower severity — an unavailable store is still a real, if
 * self-healing, sync outage, so downgrading it to `info` (which reads as purely
 * positive, like "Reconnected.") would under-signal it.
 */
export function storageCue(state: StorageCueState | null): LinkCue | null {
  if (state === null || state.dismissed) return null;
  switch (state.info.reason) {
    case "quota-unavailable":
      // Softer, transient flavor: the store is briefly unavailable and retrying.
      return {
        severity: "warning",
        message:
          "Sync paused — storage service unavailable. Your edits are saved on this device; retrying.",
      };
    case "content-cap":
    case "log-ceiling":
    case "unknown":
      // ONE honest message across the "full" reasons — don't leak which cap hit.
      return {
        severity: "warning",
        message:
          "Storage full — your edits are saved on this device but no longer sync to the room. Free up space to resume.",
      };
  }
}
