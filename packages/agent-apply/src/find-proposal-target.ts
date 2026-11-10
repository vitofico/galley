import type { ProjectFileSnapshot } from "@galley/collab";

/**
 * Resolve a proposal's target file STRICTLY (Security-Analyst finding 3): the
 * proposal carries a path, and paths can legitimately duplicate during a CRDT
 * conflict (`CollabProject.duplicatePaths`). Accept must know exactly which
 * file it would mutate — zero or multiple live matches block the apply with a
 * calm notice instead of guessing.
 */
export function findProposalTarget(
  files: ProjectFileSnapshot[],
  filePath: string,
):
  | { ok: true; file: ProjectFileSnapshot }
  | { ok: false; reason: "missing" | "duplicate"; count: number } {
  const matches = files.filter((f) => !f.deleted && f.path === filePath);
  if (matches.length === 1) return { ok: true, file: matches[0]! };
  return matches.length === 0
    ? { ok: false, reason: "missing", count: 0 }
    : { ok: false, reason: "duplicate", count: matches.length };
}

