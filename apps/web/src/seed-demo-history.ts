/**
 * `seedDemoHistory` (roadmap #20.2, spec §4) — after a TRUE first seed of the
 * "Annus Mirabilis" workspace, write the four pre-dated 1905 versions into the
 * `VersionStore` so a fresh boot's History panel already tells the story of the
 * year (ending with E = mc² appearing in Version Compare).
 *
 * GUARDS (Architect-ruled, both required):
 *  1. The CALLER gates on the actual fresh-seed signal — the non-null return of
 *     `seedIfPristine` in `project-session.ts`. An empty version list is NOT a
 *     fresh-seed signal by itself (existing projects may legitimately have zero
 *     saved versions), so this function must never be invoked merely because
 *     `listVersions()` came back empty.
 *  2. This function ADDITIONALLY guards `listVersions(projectId).length === 0`
 *     for exactly-once semantics: it never touches a project that already has
 *     versions, even if the caller's signal misfires.
 *
 * FAIL-SOFT: a version-store failure must never break boot — any error resolves
 * `false` with at most a console.warn (the workspace itself is already seeded).
 */
import type { ProjectId, VersionStore } from "@galley/shared";
import { DEMO_HISTORY } from "./demo/einstein-1905.js";

/**
 * Write the four `DEMO_HISTORY` versions (oldest first, names verbatim) for
 * `projectId`. Returns `true` iff the versions were written by THIS call.
 * Only call after a true fresh seed (guard 1 above lives at the call site).
 */
export async function seedDemoHistory(
  store: VersionStore,
  projectId: ProjectId,
): Promise<boolean> {
  try {
    // Exactly-once: a project that already has ANY version is never touched.
    const existing = await store.listVersions(projectId);
    if (existing.length > 0) return false;
    // Oldest first — the store preserves insertion order, so the History panel
    // (newest-first) shows September at the top and March at the bottom.
    for (const version of DEMO_HISTORY) {
      await store.createVersion(projectId, { name: version.name }, version.tree);
    }
    return true;
  } catch (err) {
    // Fail-soft: history is a garnish; the seeded workspace must still boot.
    console.warn("seedDemoHistory: skipped (version store unavailable)", err);
    return false;
  }
}
