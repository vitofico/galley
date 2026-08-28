/**
 * Roadmap 14-D (authoring surface) — pure helpers for the `.galley/instructions`
 * editor, kept OUT of the ProjectApp hotspot so the wiring there stays minimal.
 *
 * The READ path (`readProjectInstructions` in instructions-vfs.ts) parses the file
 * into the agent's `AgentInstructions`. THESE helpers are the EDIT side: locate
 * the live file(s), read raw text, and seed a parse-clean starter for a new file.
 * All pure; none throw.
 */

import { INSTRUCTIONS_PATHS } from "./instructions-vfs.js";

/** The canonical path a NEW instructions file is created at (leading-slash form). */
export const INSTRUCTIONS_CANONICAL_PATH = "/.galley/instructions" as const;

/** The minimal file shape these editor helpers read (a subset of a snapshot file). */
export interface InstructionsEditFile {
  fileId: string;
  path: string;
  text: string;
  /** A soft-deleted (tombstoned) file is treated as absent. */
  deleted?: boolean;
}

/** A located live instructions file. */
export interface LocatedInstructions {
  fileId: string;
  path: string;
}

/**
 * A parse-clean starter for a new `.galley/instructions` file: freeform steering
 * prose (interpreted by the model, never by us) followed by a real `## Constraints`
 * section with one valid deterministic key. `parseInstructions(INSTRUCTIONS_SEED)`
 * yields ZERO warnings (asserted in the unit test) — so it never puts commented or
 * `#`-prefixed lines inside the Constraints section (those would warn/misparse).
 */
export const INSTRUCTIONS_SEED = `Write in a clear, concise academic voice. Cite sources with numbered references and keep the tone formal but readable.

## Constraints

max-words: 800`;

/**
 * The live instructions file's id + path in `INSTRUCTIONS_PATHS` preference order
 * (the same order the reader picks), or undefined if none is live.
 */
export function findInstructionsFile(
  files: InstructionsEditFile[],
): LocatedInstructions | undefined {
  for (const wanted of INSTRUCTIONS_PATHS) {
    const hit = files.find((f) => f.path === wanted && f.deleted !== true);
    if (hit) return { fileId: hit.fileId, path: hit.path };
  }
  return undefined;
}

/**
 * ALL live instructions files in preference order — used to COALESCE duplicates:
 * the caller edits/keeps the first and tombstones the rest, so a split never
 * forms (the reader always picks the first by preference order).
 */
export function findAllInstructionsFiles(
  files: InstructionsEditFile[],
): LocatedInstructions[] {
  const out: LocatedInstructions[] = [];
  for (const wanted of INSTRUCTIONS_PATHS) {
    for (const f of files) {
      if (f.path === wanted && f.deleted !== true) out.push({ fileId: f.fileId, path: f.path });
    }
  }
  return out;
}

/** The live instructions file's raw text (preference order), or undefined if absent. */
export function readInstructionsText(files: InstructionsEditFile[]): string | undefined {
  for (const wanted of INSTRUCTIONS_PATHS) {
    const hit = files.find((f) => f.path === wanted && f.deleted !== true);
    if (hit) return hit.text;
  }
  return undefined;
}
