/**
 * 14-D — the SINGLE write seam for the project's `.galley/instructions` config.
 *
 * Every path that persists instructions into the live CRDT goes through
 * {@link writeProjectInstructions}: the InstructionsPanel's Save (via ProjectApp)
 * and the import side of the export round-trip (`restoreProjectFromTree` applying
 * a fetched tree that carries `.galley/instructions`). Centralizing it keeps the
 * wave-23 invariants in one place:
 *
 *  - **Coalescing**: the CRDT can hold duplicate live instructions files (both
 *    path forms, or concurrent creates). The write edits/keeps the FIRST by the
 *    reader's preference order and tombstones the rest — never a raw `create`
 *    next to an existing one, so a split never forms.
 *  - **Minimal-diff**: an existing file's content is updated with the same
 *    prefix/suffix minimal diff the editor uses, so a disjoint concurrent edit
 *    still merges and an identical re-write is a no-op (idempotent re-import).
 *
 * Operates on a live `CollabProject` (not pure), but offline-testable with an
 * in-memory project — no DOM, no network.
 */

import type { CollabProject } from "@galley/collab";
import type { Author } from "@galley/shared";
import { applyMinimalDiff } from "./collab-session.js";
import {
  findAllInstructionsFiles,
  INSTRUCTIONS_CANONICAL_PATH,
  type InstructionsEditFile,
} from "./instructions-edit.js";

/** The live (non-deleted) files in the minimal shape the locator wants. */
function liveFiles(project: CollabProject): InstructionsEditFile[] {
  return project
    .snapshot()
    .files.filter((f) => !f.deleted)
    .map((f) => ({ fileId: f.fileId, path: f.path, text: "" }));
}

/**
 * Create-or-replace the project's instructions with `text`, attributed to
 * `author`. Creates at the canonical `/.galley/instructions` when none exists;
 * otherwise minimal-diffs the first live file (preference order) and tombstones
 * every duplicate. Idempotent: writing the current text changes nothing.
 */
export function writeProjectInstructions(
  project: CollabProject,
  text: string,
  author: Author,
): void {
  const all = findAllInstructionsFiles(liveFiles(project));
  if (all.length === 0) {
    project.create(INSTRUCTIONS_CANONICAL_PATH, text, author);
    return;
  }
  // Edit/keep the FIRST (by preference order); minimal-diff its content so a
  // disjoint concurrent edit can still merge.
  const keep = all[0]!;
  const yt = project.fileText(keep.fileId);
  if (yt) {
    project.transactFile(keep.fileId, (t) => applyMinimalDiff(t, text), author);
  } else {
    // Malformed CRDT state (file metadata without a text body) — never silently
    // drop a save: retire the broken entry and create a fresh canonical file.
    project.delete(keep.fileId, author);
    project.create(INSTRUCTIONS_CANONICAL_PATH, text, author);
  }
  // COALESCE duplicates: tombstone every other live instructions file so the
  // reader (which picks the first) never sees a split.
  for (const dup of all.slice(1)) project.delete(dup.fileId, author);
}
