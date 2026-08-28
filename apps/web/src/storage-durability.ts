/**
 * Roadmap #23.1 — data-durability guard.
 *
 * Galley is local-first: a user's projects + CRDT history live in the browser's
 * IndexedDB, which is EVICTABLE — under storage pressure (or some private-mode /
 * quota situations) a browser can silently drop the origin's data and lose the
 * user's work. This module makes the local-first promise trustworthy:
 *
 *   - request PERSISTENT storage so the browser won't evict us,
 *   - read storage HEALTH (persisted? quota usage?) so the user isn't blind,
 *   - decide (purely) whether to NUDGE the user to back up a copy.
 *
 * Everything wraps the `navigator.storage` StorageManager API behind a small,
 * INJECTABLE seam so the wrappers unit-test with a fake (no real browser). The
 * wrappers NEVER throw: missing API / rejected promises degrade to the safe
 * "unsupported"/null shapes, so a healthy or unsupported environment is
 * byte-for-byte unchanged.
 */

/** Whether the origin's IndexedDB is durable against eviction. */
export type PersistState =
  /** `persist()`/`persisted()` granted — the browser won't silently evict us. */
  | "persisted"
  /** Best-effort only — denied or not granted; the browser MAY evict under pressure. */
  | "transient"
  /** No `navigator.storage` / no `persist` — we can't tell, and didn't change anything. */
  | "unsupported";

/** A defensive read of `StorageManager.estimate()` with a computed percent. */
export interface StorageEstimateResult {
  usageBytes: number;
  quotaBytes: number;
  /** usage/quota in [0,1], or null when quota is unknown/zero (no divide-by-zero). */
  percent: number | null;
}

/** The durability "traffic light" the UI renders from. */
export type DurabilityLevel =
  /** Not under storage pressure (persisted, or transient with low usage) — render nothing. */
  | "ok"
  /** Storage nearly full (eviction risk) — surface the back-up nudge. */
  | "at-risk"
  /** API unsupported — we can't tell; render nothing (don't nag blindly). */
  | "unknown";

export interface DurabilityStatus {
  level: DurabilityLevel;
  /** A plain-language reason, suitable for the notice copy. */
  reason: string;
  /** Whether to surface the "back up a copy" nudge. */
  nudgeBackup: boolean;
}

/**
 * Storage-pressure high-water mark: at/above this fraction of quota we nudge a
 * backup even when persisted (eviction risk rises near the cap). Named export so
 * callers / tests reference the same constant.
 */
export const DEFAULT_PRESSURE_THRESHOLD = 0.9;

/**
 * Resolve the StorageManager seam: an explicit arg wins (tests), else the live
 * `navigator.storage`, else undefined (unsupported). Reading `navigator` is
 * guarded so this is safe in non-browser test/SSR contexts.
 */
function resolveStorage(storage?: StorageManager): StorageManager | undefined {
  if (storage) return storage;
  if (typeof navigator !== "undefined" && navigator.storage) return navigator.storage;
  return undefined;
}

/**
 * Request persistent storage (best-effort) and report the resulting state.
 * Never throws: a missing API or a rejected promise maps to "unsupported".
 *
 * `persist()` is idempotent and a no-op once granted, so calling this on every
 * boot is safe. We treat an already-persisted origin as "persisted" even if
 * `persist()` itself reports false (some browsers do).
 */
export async function requestPersistentStorage(
  storage?: StorageManager,
): Promise<PersistState> {
  const s = resolveStorage(storage);
  if (!s || typeof s.persist !== "function" || typeof s.persisted !== "function") {
    return "unsupported";
  }
  try {
    const granted = await s.persist();
    if (granted) return "persisted";
    // Denied by persist() — but we may already be persisted from a prior session.
    const already = await s.persisted();
    return already ? "persisted" : "transient";
  } catch {
    return "unsupported";
  }
}

/**
 * Read the storage estimate (usage/quota) with a defensively-computed percent.
 * Returns null when unsupported or on any failure — never throws.
 */
export async function estimateStorage(
  storage?: StorageManager,
): Promise<StorageEstimateResult | null> {
  const s = resolveStorage(storage);
  if (!s || typeof s.estimate !== "function") return null;
  try {
    const est = await s.estimate();
    const usageBytes = est.usage ?? 0;
    const quotaBytes = est.quota ?? 0;
    const percent = quotaBytes > 0 ? usageBytes / quotaBytes : null;
    return { usageBytes, quotaBytes, percent };
  } catch {
    return null;
  }
}

/**
 * Pure decision: given the persist state and (optional) estimate, decide the
 * durability level, a human reason, and whether to nudge a backup.
 *
 * Decision table:
 *   - unsupported                 → unknown,  no nudge (we can't tell; don't nag)
 *   - usage ≥ thresh (either state)→ at-risk, nudge    (storage nearly full)
 *   - transient + below thresh    → ok,       no nudge (denied persist alone is
 *                                              not a reason to nag a fresh project)
 *   - persisted + below thresh    → ok,       no nudge
 *
 * Note: we deliberately DON'T nag merely because persistence was denied
 * (common in private/incognito mode). On a fresh project with negligible usage
 * that's a false alarm. We only escalate to "at-risk" when storage is actually
 * approaching the pressure threshold — the real eviction trigger.
 */
export function durabilityStatus({
  persistState,
  estimate,
  pressureThreshold = DEFAULT_PRESSURE_THRESHOLD,
}: {
  persistState: PersistState;
  estimate: StorageEstimateResult | null;
  pressureThreshold?: number;
}): DurabilityStatus {
  if (persistState === "unsupported") {
    return {
      level: "unknown",
      reason: "Storage durability can't be determined in this browser.",
      nudgeBackup: false,
    };
  }

  // Storage pressure is the real eviction trigger — nudge near the quota cap
  // regardless of persist state (a transient origin near its cap is the worst
  // case, but even a persisted one can hit failed saves).
  if (estimate?.percent != null && estimate.percent >= pressureThreshold) {
    return {
      level: "at-risk",
      reason:
        persistState === "transient"
          ? "Your browser may evict locally-stored work under storage pressure."
          : "Local storage is nearly full, which risks failed saves and eviction.",
      nudgeBackup: true,
    };
  }

  // transient but well under the cap → don't nag (denied persistence alone, e.g.
  // private/incognito mode on a fresh project, is not an at-risk situation).
  return {
    level: "ok",
    reason:
      persistState === "transient"
        ? "Local storage isn't guaranteed persistent, but usage is low."
        : "Local storage is persistent.",
    nudgeBackup: false,
  };
}
