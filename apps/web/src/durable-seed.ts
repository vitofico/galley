/**
 * Durable, consume-once seed handoff — the persistent twin of the in-memory
 * `pending-seed.ts`.
 *
 * `pending-seed.ts` lives in the page heap, so a seed only survives if the
 * created project is opened in the SAME session (the create→navigate path). The
 * Einstein-demo "one preexisting project" is created on the Projects page but
 * opened LATER (and possibly across a reload), so its seed intent must persist.
 * This module records a tiny `{kind,name}` record in localStorage keyed by
 * project id; `unified-root`'s `resolveBootSeed` consumes it on first boot and
 * the pristine-gated `seedIfPristine` remains the single writer.
 *
 * It also owns the "seed Einstein once" flag so a deleted demo never resurrects.
 *
 * Pure + storage-edge like `onboarding-nudge.ts`: an injectable Storage slice so
 * the Node unit gate passes a Map-backed fake; the browser default degrades to
 * "no durable seed / don't seed" when storage is unavailable (a seed that can't
 * be remembered must not be re-applied or re-created on every load).
 */
import type { SeedKind } from "./pending-seed.js";

/** The persisted seed intent — minimal; content is reconstructed from `kind`. */
export interface DurableSeed {
  kind: SeedKind;
  name: string;
}

/** The slice of `Storage` we use — injectable so tests pass a fake. */
export interface SeedStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Per-project durable-seed key. */
const SEED_KEY_PREFIX = "galley.seed.";
/** Flag recording that the one-time Einstein demo project has been created. */
export const EINSTEIN_SEEDED_KEY = "galley.einstein.seeded";

function seedKey(projectId: string): string {
  return `${SEED_KEY_PREFIX}${projectId}`;
}

/** Resolve a default storage (real `localStorage` in the browser, else null). */
function defaultStorage(): SeedStorage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Access can throw (privacy mode) — treat as unavailable.
  }
  return null;
}

function isSeedKind(v: unknown): v is SeedKind {
  return v === "blank" || v === "einstein" || v === "lowry" || v === "import";
}

/** Stash a durable seed for `projectId`, to be consumed by its first boot. */
export function setDurableSeed(
  projectId: string,
  seed: DurableSeed,
  store: SeedStorage | null = defaultStorage(),
): void {
  if (!store) return;
  try {
    store.setItem(seedKey(projectId), JSON.stringify(seed));
  } catch {
    // best-effort — a blocked store just falls back to the blank starter.
  }
}

/**
 * Return AND delete the durable seed for `projectId` (consume-once). Returns
 * `null` when there is none or storage is unavailable. The record is removed
 * BEFORE parsing so a malformed entry can never wedge boot.
 */
export function takeDurableSeed(
  projectId: string,
  store: SeedStorage | null = defaultStorage(),
): DurableSeed | null {
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(seedKey(projectId));
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    store.removeItem(seedKey(projectId));
  } catch {
    // best-effort — pristine-gating still prevents a double seed.
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DurableSeed>;
    if (isSeedKind(parsed.kind) && typeof parsed.name === "string") {
      return { kind: parsed.kind, name: parsed.name };
    }
  } catch {
    // malformed JSON → no seed.
  }
  return null;
}

/**
 * Whether the one-time Einstein demo project should be created. True only when
 * storage is AVAILABLE and the flag is absent — without storage the "created
 * once" fact couldn't persist, so we skip rather than inject a fresh demo on
 * every load.
 */
export function shouldSeedEinsteinDemo(store: SeedStorage | null = defaultStorage()): boolean {
  if (!store) return false;
  try {
    return store.getItem(EINSTEIN_SEEDED_KEY) === null;
  } catch {
    return false;
  }
}

/** Record that the Einstein demo has been created (so a delete never re-creates it). */
export function markEinsteinDemoSeeded(store: SeedStorage | null = defaultStorage()): void {
  if (!store) return;
  try {
    store.setItem(EINSTEIN_SEEDED_KEY, "1");
  } catch {
    // best-effort
  }
}
