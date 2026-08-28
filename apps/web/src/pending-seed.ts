/**
 * Pending-seed handoff (project-model redesign §2) — the core seam that lets a
 * freshly-created project be seeded EXACTLY ONCE, by the mounted session, on its
 * first boot.
 *
 * `createProject` mints an id, registers the project, then stashes the desired
 * seed here keyed by `projectId` and navigates (an in-SPA `pushState`, same JS
 * context). The immediately-mounted `ProjectApp` boot resolves its seed by
 * CONSUMING this entry (`takePendingSeed`); if there is none (a reload, or an
 * existing project opened from the library) it falls back to the blank starter.
 * Either way the already-correct pristine-gated `seedIfPristine` is the single
 * writer, so correctness never depends on any IndexedDB write-flush timing.
 *
 * Consume-once: `takePendingSeed` returns the seed and DELETES it, so a reload
 * (which re-runs boot but finds a non-pristine doc anyway) never re-seeds, and a
 * stale entry can't leak into a later project that happens to reuse the id.
 *
 * In-process only: this map lives in the page's JS heap. It is never persisted —
 * a full reload legitimately drops it, which is the desired behavior.
 */
import type { SeedFile } from "@galley/collab";

/** The seed kind, surfaced for diagnostics / name derivation parity (§2 table). */
export type SeedKind = "blank" | "einstein" | "lowry" | "import";

/** A fully-resolved seed to write into a fresh project on its first boot. */
export interface PendingSeed {
  kind: SeedKind;
  files: SeedFile[];
  mainPath: string;
  /** Seed the Einstein 1905 demo version history (Einstein path only). */
  demoHistory: boolean;
  /** The human project name registered in the project store. */
  name: string;
}

const PENDING = new Map<string, PendingSeed>();

/** Stash a seed for `projectId` to be consumed by its first boot. */
export function setPendingSeed(projectId: string, seed: PendingSeed): void {
  PENDING.set(projectId, seed);
}

/**
 * Return AND delete the pending seed for `projectId` (consume-once). Returns
 * `undefined` when there is none (a reload, or an existing project).
 */
export function takePendingSeed(projectId: string): PendingSeed | undefined {
  const seed = PENDING.get(projectId);
  if (seed !== undefined) PENDING.delete(projectId);
  return seed;
}
