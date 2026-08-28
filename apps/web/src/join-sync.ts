/**
 * `joinSync` (corrections H3) — the join-time "Syncing…" cue, made LOUD on
 * failure. A CONNECTED joiner shows a calm "Syncing the shared document…" line
 * until the relay's initial state lands (`connection.onSynced`) or a short
 * timeout elapses. Before, the cue cleared on the timeout REGARDLESS — so a joiner
 * whose relay was unreachable watched it vanish into a blank-looking empty doc,
 * with no hint anything went wrong.
 *
 * Now the timeout branches on `connection.synced`: synced ⇒ done (silent);
 * not-synced ⇒ a warning that the room couldn't be reached, which SELF-HEALS to
 * done if a (late) first sync still arrives (the `onSynced` subscription stays
 * live, and the transport keeps retrying with capped backoff — C2). Pure +
 * Node-unit-tested; the React effect feeds it `connection.synced` + `onSynced`.
 */
import type { NoticeSeverity } from "./components/Notice.js";

export type JoinSyncPhase = "syncing" | "stalled" | "done";

export interface JoinSyncCue {
  severity: NoticeSeverity;
  message: string;
  /** Stable testid per phase (the happy path keeps the historical `join-syncing`). */
  testId: string;
}

/**
 * PURE: which phase a still-unresolved join lands in when the timeout fires —
 * `done` if the relay's state already arrived, else `stalled` (go loud).
 */
export function joinPhaseOnTimeout(synced: boolean): JoinSyncPhase {
  return synced ? "done" : "stalled";
}

/** PURE: the cue for a phase, or `null` when the join has resolved (no banner). */
export function joinSyncCue(phase: JoinSyncPhase): JoinSyncCue | null {
  switch (phase) {
    case "syncing":
      return { severity: "info", message: "Syncing the shared document…", testId: "join-syncing" };
    case "stalled":
      return {
        severity: "warning",
        message: "Couldn't reach the room yet — still trying to sync…",
        testId: "join-stalled",
      };
    case "done":
      return null;
  }
}
