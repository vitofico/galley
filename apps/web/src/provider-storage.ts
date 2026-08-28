/**
 * Shared AI-provider persistence (#19.7) — the ONE storage seam every shell
 * reads the configured `ProviderConfig` through.
 *
 * History: the provider form lived only in the legacy single-file shell
 * (`App.tsx`), which persists the config under `localStorage["galley.provider"]`;
 * `ProjectApp` (the default boot) read the same key with a private copy of the
 * loader but had NO UI to write it — the headline reachability gap #19.7 closes.
 * The `/settings` AI-provider section now writes through this module and
 * ProjectApp reads through it, so the default shell, the settings surface AND
 * the untouched legacy form all share one stored config.
 *
 * Mirrors the established storage-edge convention (`theme.ts`,
 * `editor-prefs.ts`, `compiler-mode.ts`): zero side effects at import time,
 * guarded best-effort storage access, and an injectable store so the Node unit
 * gate exercises it with a plain Map-backed fake.
 *
 * SECURITY: a direct-mode API key lives inside the stored config — in THIS
 * browser's localStorage only, exactly as the legacy shell has always kept it.
 * This module adds no new movement of the key.
 */
import type { ProviderConfig } from "@galley/shared";

/** The localStorage key — UNCHANGED from the legacy shell (`App.tsx`), so a
 * provider configured in either era keeps working everywhere. */
export const PROVIDER_KEY = "galley.provider";

/** The slice of `Storage` we use — injectable so tests pass a fake. */
export interface ProviderStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Resolve the guarded default storage (real `localStorage`, else null). */
function defaultStorage(): ProviderStorage | null {
  try {
    if (typeof globalThis !== "undefined" && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    // Accessing localStorage can throw (e.g. blocked by the browser).
  }
  return null;
}

/**
 * Load the stored provider config, or null when nothing usable is stored.
 * Same fail-soft semantics as the legacy loader (malformed JSON → null), plus
 * a minimal shape check so a corrupted value can't masquerade as a config.
 */
export function loadStoredProvider(store?: ProviderStorage): ProviderConfig | null {
  const storage = store ?? defaultStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(PROVIDER_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { kind?: unknown }).kind === "string"
    ) {
      return parsed as ProviderConfig;
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist the provider config. Best-effort: a failed write never throws. */
export function saveStoredProvider(config: ProviderConfig, store?: ProviderStorage): void {
  const storage = store ?? defaultStorage();
  if (!storage) return;
  try {
    storage.setItem(PROVIDER_KEY, JSON.stringify(config));
  } catch {
    // quota / private mode — the in-memory config still applies this session
  }
}

/** Remove the stored config ("Use Demo" — back to the offline model). */
export function clearStoredProvider(store?: ProviderStorage): void {
  const storage = store ?? defaultStorage();
  if (!storage) return;
  try {
    storage.removeItem(PROVIDER_KEY);
  } catch {
    // best-effort
  }
}
