/**
 * Automatic versioning policy (roadmap #10) — an opt-in, default-OFF layer that
 * coalesces auto-snapshots so the version timeline stays readable.
 *
 * This is NOT a new store and NOT an agent edit: when enabled it simply drives
 * the EXISTING manual snapshot path (`onSaveVersion` → `materializeProject` →
 * `versionStore.createVersion`) on an elapsed-time and/or edit-count cadence. A
 * snapshot is a passive capture of current CRDT state — it never mutates the
 * document and never broadcasts (the version store is local).
 *
 * The decision is a PURE function ({@link shouldSnapshot}) with no React/DOM and
 * no clock — `now` is injected — so it is fully unit-testable. Persistence
 * mirrors `focus-mode.ts`: a single `galley.*` localStorage key, default OFF,
 * and ZERO import side effects (storage is only touched on an explicit call).
 */

/** localStorage key the auto-snapshot policy is persisted under. */
export const AUTO_SNAPSHOT_KEY = "galley.autoSnapshot";

/** Default elapsed-time cadence (5 minutes) when auto-snapshot is enabled. */
export const DEFAULT_INTERVAL_MS = 5 * 60_000;
/** Default edit-count cadence (30 doc updates) when auto-snapshot is enabled. */
export const DEFAULT_EDIT_THRESHOLD = 30;

/**
 * The opt-in policy. `enabled` defaults to false so shipped behavior is
 * byte-identical until the user flips the toggle. A snapshot is due when EITHER
 * configured cadence is met (an unset/undefined cadence is simply ignored).
 */
export interface AutoSnapshotPolicy {
  /** Master switch. Default false — nothing subscribes, zero overhead. */
  enabled: boolean;
  /** Snapshot after this many ms elapse since the last one. Omit to disable. */
  intervalMs?: number;
  /** Snapshot after this many edits since the last one. Omit to disable. */
  editThreshold?: number;
}

/** Running state the policy is evaluated against. */
export interface AutoSnapshotState {
  /** Epoch ms of the last (auto or manual-equivalent) snapshot baseline. */
  lastSnapshotTime: number;
  /** Doc updates observed since `lastSnapshotTime`. */
  editsSinceLast: number;
}

/**
 * The default, byte-identical policy: disabled. Returned for missing/corrupt
 * persisted state.
 */
export function defaultAutoSnapshotPolicy(): AutoSnapshotPolicy {
  return { enabled: false };
}

/**
 * A sensible enabled policy: both cadences active with the module defaults.
 * Used when the toggle flips on with no prior tuning.
 */
export function enabledAutoSnapshotPolicy(): AutoSnapshotPolicy {
  return {
    enabled: true,
    intervalMs: DEFAULT_INTERVAL_MS,
    editThreshold: DEFAULT_EDIT_THRESHOLD,
  };
}

/**
 * PURE: should an auto-snapshot be taken now?
 *
 * - Always false when the policy is disabled (the default-OFF guarantee).
 * - Otherwise true when (intervalMs is set AND `now - lastSnapshotTime >=
 *   intervalMs`) OR (editThreshold is set AND `editsSinceLast >= editThreshold`).
 * - A cadence that is undefined OR not a positive finite number is ignored, so a
 *   `{enabled:true}` policy with neither cadence never fires (no spam).
 *
 * No clock, no DOM — `now` is injected by the caller.
 */
export function shouldSnapshot(
  state: AutoSnapshotState,
  now: number,
  policy: AutoSnapshotPolicy,
): boolean {
  if (!policy.enabled) return false;

  const interval = policy.intervalMs;
  if (isPositive(interval) && now - state.lastSnapshotTime >= interval) {
    return true;
  }

  const threshold = policy.editThreshold;
  if (isPositive(threshold) && state.editsSinceLast >= threshold) {
    return true;
  }

  return false;
}

/** A positive, finite number — the only kind of cadence that can ever fire. */
function isPositive(n: number | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** The minimal storage surface this module needs (a subset of `Storage`). */
export interface AutoSnapshotStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): AutoSnapshotStorage | null {
  const s = (globalThis as { localStorage?: AutoSnapshotStorage }).localStorage;
  return s ?? null;
}

/**
 * Read the persisted policy. Returns the disabled default when unset, invalid,
 * corrupt, or storage is unavailable — so a broken value can never silently turn
 * auto-snapshotting ON. Unknown/extra fields are dropped; cadences are only
 * carried through when they are positive finite numbers.
 */
export function loadAutoSnapshotPolicy(
  storage?: AutoSnapshotStorage | null,
): AutoSnapshotPolicy {
  const s = storage === undefined ? defaultStorage() : storage;
  if (!s) return defaultAutoSnapshotPolicy();
  try {
    const raw = s.getItem(AUTO_SNAPSHOT_KEY);
    if (raw == null) return defaultAutoSnapshotPolicy();
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return defaultAutoSnapshotPolicy();
    }
    const obj = parsed as Record<string, unknown>;
    const policy: AutoSnapshotPolicy = { enabled: obj.enabled === true };
    if (isPositive(obj.intervalMs as number | undefined)) {
      policy.intervalMs = obj.intervalMs as number;
    }
    if (isPositive(obj.editThreshold as number | undefined)) {
      policy.editThreshold = obj.editThreshold as number;
    }
    return policy;
  } catch {
    return defaultAutoSnapshotPolicy();
  }
}

/** Persist the policy. Best-effort — storage failures are swallowed. */
export function saveAutoSnapshotPolicy(
  policy: AutoSnapshotPolicy,
  storage?: AutoSnapshotStorage | null,
): void {
  const s = storage === undefined ? defaultStorage() : storage;
  if (!s) return;
  try {
    s.setItem(AUTO_SNAPSHOT_KEY, JSON.stringify(policy));
  } catch {
    /* persistence is best-effort */
  }
}
