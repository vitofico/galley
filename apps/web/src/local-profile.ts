/**
 * Stable LOCAL-PROFILE identity for the web app (roadmap #12.1, substrate for the
 * activation epic #14 + the project library #12).
 *
 * In no-auth local mode the user's identity is today a per-TAB random id (see
 * `createCollabSession` / `createProjectSession`, which mint `randomId()` each
 * load). That makes a returning user a different author/owner on every reload.
 * This module mints the id ONCE and persists it to `localStorage` so the same
 * browser is the same `UserId` across reloads — the owner of their own projects.
 *
 * Pure + storage-edge: `loadLocalProfile` takes an injectable storage so the Node
 * unit gate (no `localStorage`) can pass a Map-backed fake. The persisted shape is
 * a JSON `LocalProfile`; under OIDC (later) the subject replaces this id, but the
 * registry/author seams stay the same.
 */
import type { UserId } from "@galley/shared";

/** localStorage key under which the JSON-encoded `LocalProfile` lives. */
export const LOCAL_PROFILE_KEY = "galley.localProfile";

export interface LocalProfile {
  /** Stable, persisted local identity (e.g. `local-…`). Equals an OIDC subject later. */
  userId: UserId;
  /** Optional human-friendly name (set by the user; not minted). */
  displayName?: string;
  /** Optional cursor/presence color (set by the user; not minted). */
  color?: string;
  /**
   * True once the join-name prompt (#19.4) has been answered OR skipped, so a
   * joiner is asked exactly once — a skip is remembered, never re-prompted.
   */
  namePromptSeen?: boolean;
}

/** The slice of `Storage` we use — injectable so tests pass a fake. */
export interface ProfileStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** A reasonably-unique token: `crypto.randomUUID()` when available, else a fallback. */
function mintToken(): string {
  const c: { randomUUID?: () => string } | undefined =
    typeof globalThis !== "undefined"
      ? (globalThis.crypto as { randomUUID?: () => string } | undefined)
      : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Fallback (older/Node-without-webcrypto): time + two random chunks.
  const rand = () => Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${rand()}${rand()}`;
}

/** Parse a stored value into a valid profile, or null if absent/corrupt/missing-id. */
function parseStored(raw: string | null): LocalProfile | null {
  if (raw === null) return null;
  try {
    const obj = JSON.parse(raw) as unknown;
    if (
      typeof obj === "object" &&
      obj !== null &&
      typeof (obj as { userId?: unknown }).userId === "string" &&
      (obj as { userId: string }).userId.length > 0
    ) {
      return obj as LocalProfile;
    }
  } catch {
    // fall through — re-mint below
  }
  return null;
}

/** Resolve a default storage (real `localStorage` in the browser, else null). */
function defaultStorage(): ProfileStorage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Access can throw (e.g. privacy mode) — degrade to ephemeral.
  }
  return null;
}

/**
 * Load the local profile, minting + persisting a stable `userId` on first use.
 *
 * - Pre-seeded, valid store → returns the stored profile unchanged (no churn).
 * - Absent / corrupt / missing-id → mints a `local-…` id, persists it, returns it.
 * - Idempotent: a second call (same store) returns the same id.
 *
 * If no storage is available (no `localStorage`, none injected) the profile is
 * returned but ephemeral — minted fresh each call.
 */
export function loadLocalProfile(store?: ProfileStorage): LocalProfile {
  const storage = store ?? defaultStorage();

  const existing = storage ? parseStored(storage.getItem(LOCAL_PROFILE_KEY)) : null;
  if (existing) return existing;

  const profile: LocalProfile = { userId: `local-${mintToken()}` };
  if (storage) {
    try {
      storage.setItem(LOCAL_PROFILE_KEY, JSON.stringify(profile));
    } catch {
      // Persistence is best-effort; an unwritable store just makes it ephemeral.
    }
  }
  return profile;
}

/**
 * Merge a patch into the persisted profile and write it back (#19.4 — the join
 * prompt stores the chosen `displayName` / the `namePromptSeen` flag here). The
 * stable `userId` can never be patched away: it always comes from the loaded
 * (or freshly minted) profile. Returns the merged profile; persistence stays
 * best-effort like `loadLocalProfile`.
 */
export function updateLocalProfile(
  patch: Partial<Omit<LocalProfile, "userId">>,
  store?: ProfileStorage,
): LocalProfile {
  const storage = store ?? defaultStorage();
  const current = storage ? loadLocalProfile(storage) : loadLocalProfile();
  const next: LocalProfile = { ...current, ...patch, userId: current.userId };
  if (storage) {
    try {
      storage.setItem(LOCAL_PROFILE_KEY, JSON.stringify(next));
    } catch {
      // best-effort
    }
  }
  return next;
}
