/**
 * Building a proposal from a tool call's TEXT operations, shared by the local
 * bridge (server.ts) and the hosted connector (hosted/tools.ts). Nothing here
 * publishes or applies: each function validates one caller-supplied operation
 * against the live replica and returns either the proposal op or a structured
 * refusal the caller relays as data.
 *
 * The edit contract is the agent's (apply-edits.ts): blocks are applied to a
 * SCRATCH copy, all-or-nothing, each `search` matching exactly once. The
 * proposed text is always computed here, never taken from the model.
 */
import { z } from "zod";
import { applyEdits } from "@galley/agent";
import { FILE_PROPOSAL_LIMITS, type FileProposalOp } from "@galley/collab";
import {
  isSafeProjectPath,
  type EditBlock,
  type EditFailure,
} from "@galley/shared";
import { READ_LIMITS, type ToolSurface } from "./surface.js";

/** A structured "nothing was published" payload: `status` plus its details. */
export type Refusal = { status: string } & Record<string, unknown>;

/** Max characters of a failing block's `search` echoed back in `edit_failed`. */
const MAX_FAILURE_ECHO_CHARS = 200;

function truncateEcho(text: string): string {
  return text.length <= MAX_FAILURE_ECHO_CHARS
    ? text
    : `${text.slice(0, MAX_FAILURE_ECHO_CHARS)}… [truncated]`;
}

/**
 * The failing blocks, as data the client model can act on. Only a bounded
 * prefix of each `search` is echoed: a failure payload must not become a
 * second oversized channel.
 */
export function describeEditFailures(failures: EditFailure[]) {
  return failures.map((f) => ({
    reason: f.reason,
    ...(f.matchCount !== undefined ? { matchCount: f.matchCount } : {}),
    search: truncateEcho(f.block.search),
  }));
}

/**
 * Claim a caller-supplied path for this proposal: it must be a safe in-tree
 * path and no other op of the same proposal may target it. Returns the refusal,
 * or null after recording the path in `seen`.
 */
export function claimPath(seen: Set<string>, path: string): Refusal | null {
  if (!isSafeProjectPath(path)) {
    return {
      status: "invalid_path",
      path,
      message: `No proposal was published: ${path} is not a safe in-tree project path (needs a leading slash, no traversal, not under /.galley).`,
    };
  }
  if (seen.has(path)) {
    return {
      status: "duplicate_path",
      path,
      message: `No proposal was published: two ops target ${path}. Combine them into one op.`,
    };
  }
  seen.add(path);
  return null;
}

/**
 * The input schemas of the four text operations of `propose_files`, shared so
 * both connections accept exactly the same shapes.
 */
export const TEXT_OP_SCHEMAS = [
  z.object({
    kind: z.literal("create"),
    path: z
      .string()
      .min(1)
      .max(READ_LIMITS.maxPathChars)
      .describe("Canonical path of the NEW file, e.g. /chapters/intro.typ."),
    text: z
      .string()
      .max(FILE_PROPOSAL_LIMITS.maxTextBytes)
      .describe("Full text of the new file."),
  }),
  z.object({
    kind: z.literal("edit"),
    path: z
      .string()
      .min(1)
      .max(READ_LIMITS.maxPathChars)
      .describe(
        "Exact path of the EXISTING file to edit (as listed by list_files).",
      ),
    edits: z
      .array(
        z.object({
          search: z
            .string()
            .max(FILE_PROPOSAL_LIMITS.maxBlockBytes)
            .describe(
              "Exact text to find in this file — must match exactly once.",
            ),
          replace: z
            .string()
            .max(FILE_PROPOSAL_LIMITS.maxBlockBytes)
            .describe("Replacement text."),
        }),
      )
      .min(1)
      .max(FILE_PROPOSAL_LIMITS.maxBlocks)
      .describe(
        "Search/replace blocks, applied in order against this file's text.",
      ),
  }),
  z.object({
    kind: z.literal("rename"),
    path: z
      .string()
      .min(1)
      .max(READ_LIMITS.maxPathChars)
      .describe(
        "Exact CURRENT path of the EXISTING file to move (as listed by list_files).",
      ),
    newPath: z
      .string()
      .min(1)
      .max(READ_LIMITS.maxPathChars)
      .describe(
        "Destination path — also moves into a folder (e.g. /draft.typ → /chapters/intro.typ). " +
          "Must be a free, safe in-tree path. References (#include/#image) are NOT auto-rewritten — " +
          "bundle the corrective `edit` ops in the same proposal.",
      ),
  }),
  z.object({
    kind: z.literal("delete"),
    path: z
      .string()
      .min(1)
      .max(READ_LIMITS.maxPathChars)
      .describe(
        "Exact path of the EXISTING file to remove (recoverable soft-delete on Accept).",
      ),
  }),
] as const;

/** The text operations a client may ask for; `path` is already claimed. */
export type TextOpInput =
  | { kind: "create"; path: string; text: string }
  | { kind: "edit"; path: string; edits: { search: string; replace: string }[] }
  | { kind: "rename"; path: string; newPath: string }
  | { kind: "delete"; path: string };

/** Build one text op of a multi-file proposal, after {@link claimPath}(op.path). */
export function buildTextOp(
  surface: ToolSurface,
  op: TextOpInput,
  seen: Set<string>,
): { op: FileProposalOp } | { refusal: Refusal } {
  if (op.kind === "create") {
    return {
      op: {
        kind: "create",
        path: op.path,
        baseText: "",
        proposedText: op.text,
        blocks: [],
      },
    };
  }
  if (op.kind === "rename") {
    // The destination is caller-supplied too: same safety + uniqueness rules.
    const refusal = claimPath(seen, op.newPath);
    if (refusal !== null) return { refusal };
    return {
      op: {
        kind: "rename",
        path: op.path,
        newPath: op.newPath,
        baseText: "",
        proposedText: "",
        blocks: [],
      },
    };
  }
  if (op.kind === "delete") {
    return {
      op: {
        kind: "delete",
        path: op.path,
        baseText: "",
        proposedText: "",
        blocks: [],
      },
    };
  }
  // edit: read the live file and apply the blocks to a SCRATCH copy only.
  const read = surface.readFile(op.path);
  if (!read.ok) {
    return {
      refusal: {
        status: "file_unreadable",
        path: op.path,
        message: `No proposal was published: could not read ${op.path} — ${read.error}.`,
      },
    };
  }
  // A3: a binary file has no text body to take search/replace blocks.
  if ("kind" in read) {
    return {
      refusal: {
        status: "file_unreadable",
        path: op.path,
        message: `No proposal was published: ${op.path} is a binary file (${read.mime}) and cannot be edited as text.`,
      },
    };
  }
  const blocks: EditBlock[] = op.edits.map((e) => ({
    search: e.search,
    replace: e.replace,
  }));
  const result = applyEdits(read.text, blocks);
  if (!result.ok) {
    return {
      refusal: {
        status: "edit_failed",
        path: op.path,
        message: `No proposal was published: one or more blocks did not apply to ${op.path}. Fix the failing blocks and retry.`,
        failures: describeEditFailures(result.failures),
      },
    };
  }
  return {
    op: {
      kind: "edit",
      path: op.path,
      baseText: read.text,
      proposedText: result.source,
      blocks,
    },
  };
}
