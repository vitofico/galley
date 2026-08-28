/**
 * Roadmap 14-D shell wiring — locate, read, and parse a project's
 * `.galley/instructions` file from the live project snapshot into the
 * `AgentInstructions` shape `runAgent` consumes (steering prose + deterministic
 * document constraints).
 *
 * ## Why this lives here (the storage finding)
 *
 * `.galley/` is the project's RESERVED namespace. `isSafeProjectPath`
 * (@galley/shared) rejects a first path segment of `.galley`, and `import`
 * gates reserved paths out of `materializeProject` — but that guard only fences
 * EXPORT/import; it does NOT gate what can live in the CRDT (`CollabProject.create`
 * canonicalizes the path and writes it with no safety check). So a
 * `.galley/instructions` file CAN exist in `project.snapshot().files`, and that
 * snapshot is the read path here. The stored form is leading-slash canonical
 * (`/.galley/instructions`); a materialized tree uses the relative form
 * (`.galley/instructions`). We accept BOTH, robustly.
 *
 * There is no creation UI for this file yet (out of scope for this slice) — so
 * in practice the file is absent for every existing project and the single-file
 * shell, in which case this helper returns `undefined` and the agent path stays
 * byte-for-byte the original behavior. The reader is wired defensively for that
 * default-OFF case.
 *
 * The helper is PURE and NEVER throws: absent/empty/garbage all return
 * `undefined` (`parseInstructions` itself never throws; we map an inert result
 * to `undefined`).
 */

import { parseInstructions, hasConstraints, type AgentInstructions } from "@galley/agent";

/** The minimal file shape this helper reads (a subset of `ProjectFileSnapshot`). */
export interface InstructionsFile {
  path: string;
  text: string;
  /** A soft-deleted (tombstoned) file is treated as absent. Optional. */
  deleted?: boolean;
}

/**
 * The canonical paths a `.galley/instructions` file may appear under, in
 * preference order: the live CRDT's leading-slash form first, then the
 * materialized (relative) form.
 */
export const INSTRUCTIONS_PATHS = ["/.galley/instructions", ".galley/instructions"] as const;

/** Accept either the snapshot's file array or a plain path -> text map. */
export type InstructionsSource = InstructionsFile[] | Record<string, string>;

/** Locate the instructions file text among the project files (live only), or undefined. */
function findInstructionsText(source: InstructionsSource): string | undefined {
  if (Array.isArray(source)) {
    for (const wanted of INSTRUCTIONS_PATHS) {
      const hit = source.find((f) => f.path === wanted && f.deleted !== true);
      if (hit) return hit.text;
    }
    return undefined;
  }
  for (const wanted of INSTRUCTIONS_PATHS) {
    if (Object.prototype.hasOwnProperty.call(source, wanted)) return source[wanted];
  }
  return undefined;
}

/**
 * Read + parse the project's `.galley/instructions` into the `AgentInstructions`
 * the agent loop wants, or `undefined` when there's nothing to steer/constrain.
 *
 * Mapping from `parseInstructions`' `ParsedInstructions`:
 *   - `steering` is carried only when non-empty (trimmed by the parser);
 *   - `constraints` is carried only when `hasConstraints` is true (an inert
 *     constraints object — a `## Constraints` heading with no usable keys — is
 *     dropped so it stays OFF, matching `runAgent`'s own inert handling);
 *   - when NEITHER is present, the whole thing is `undefined` so the agent run is
 *     byte-for-byte the default behavior.
 *
 * Warnings from the parse are intentionally NOT surfaced here (forward-compat,
 * non-fatal); a future slice could thread them to the UI.
 */
export function readProjectInstructions(
  source: InstructionsSource,
): AgentInstructions | undefined {
  const text = findInstructionsText(source);
  if (text === undefined) return undefined;

  const parsed = parseInstructions(text);
  const steering = parsed.steering.trim();
  const constraints = hasConstraints(parsed.constraints) ? parsed.constraints : undefined;

  if (!steering && !constraints) return undefined;
  return {
    ...(steering ? { steering } : {}),
    ...(constraints ? { constraints } : {}),
  };
}
