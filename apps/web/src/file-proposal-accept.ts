/**
 * Conflict-aware Accept for a MULTI-FILE proposal (`propose_files`). Pure so the
 * "validate everything before mutating anything" invariant is unit-tested
 * directly rather than living only inside a React handler.
 *
 * The planner resolves EVERY op against the current project snapshot and returns
 * a fully-resolved plan ONLY if all ops are applicable; otherwise it returns a
 * reason and NO plan. The caller mutates nothing until it holds an `ok` plan, so
 * a stale/conflicting proposal never lands a partial change set (never clobbers,
 * never half-creates) — it surfaces a calm notice and stays pending.
 *
 *   - create: the path must be FREE (zero live text- or binary-file matches).
 *   - edit:   exactly ONE live text match, and `resolveAccept` must apply the
 *             blocks cleanly (the same conflict-aware gate the single-file path
 *             uses — a stale edit degrades to a surfaced conflict, never a
 *             clobber). An edit op with EMPTY blocks (a B3 restore op) is a
 *             FULL-FILE REPLACEMENT: it applies the proposed text ONLY when the
 *             live file is unchanged since the proposal (resolveAccept's fast
 *             path), else it surfaces a STALE conflict — never a silent no-op.
 *   - rename: exactly ONE live text match for the source, and the destination
 *             (`newPath`) must be FREE (move-into-folder is just a new path).
 *   - delete: exactly ONE live text match (a recoverable soft-delete on Accept).
 *
 * Every op resolves against the ORIGINAL snapshot — the planner never simulates a
 * post-apply intermediate state, so ops can't depend on each other's path changes
 * within one set (the mailbox already forbids any path appearing twice). That keeps
 * "validate everything, then apply all-or-nothing" simple and impossible to half-apply.
 */
import type { BinaryAsset, FileProposalOp, ProjectSnapshot } from "@galley/collab";
import { resolveAccept } from "./accept.js";

export interface FileProposalPlan {
  /** New files to create (in op order). */
  creates: { path: string; text: string }[];
  /** Existing files to rewrite, with the conflict-resolved final source. */
  edits: { fileId: string; source: string }[];
  /** Existing files to move to a new (free) path — metadata-only, history-preserving. */
  renames: { fileId: string; newPath: string }[];
  /** Existing files to soft-delete (recoverable). */
  deletes: { fileId: string }[];
  /**
   * New BINARY files to create (A2): a free path + a content-addressed pointer to
   * bytes that must already be present in the blob store. The PURE planner only
   * resolves the path collision (a binary path must be free of any text OR binary
   * file); the ASYNC accept orchestrator verifies the bytes are actually in the
   * store IMMEDIATELY before apply (the dangling-pointer guard) and applies
   * NOTHING if any are missing — never a CRDT pointer to absent bytes.
   */
  binaryCreates: { path: string; asset: BinaryAsset }[];
}

export type FileProposalPlanResult =
  | { ok: true; plan: FileProposalPlan }
  | { ok: false; reason: string };

export function planFileProposalAccept(
  snapshot: ProjectSnapshot,
  ops: FileProposalOp[],
): FileProposalPlanResult {
  const liveText = snapshot.files.filter((f) => !f.deleted);
  const liveBinaryPaths = new Set(
    (snapshot.binaryFiles ?? []).filter((f) => !f.deleted).map((f) => f.path),
  );
  const creates: FileProposalPlan["creates"] = [];
  const edits: FileProposalPlan["edits"] = [];
  const renames: FileProposalPlan["renames"] = [];
  const deletes: FileProposalPlan["deletes"] = [];
  const binaryCreates: FileProposalPlan["binaryCreates"] = [];
  // Guard against two ops resolving to the same NEW path within one accept
  // (the mailbox already rejects intra-proposal duplicate paths, but the
  // planner must never depend on an upstream check for correctness).
  const plannedNewPaths = new Set<string>();

  // Resolve a path that must name exactly ONE live text file (shared by edit /
  // rename / delete). Returns the file or a structured reason (missing/ambiguous).
  const resolveOne = (
    path: string,
  ): { ok: true; file: (typeof liveText)[number] } | { ok: false; reason: string } => {
    const textMatches = liveText.filter((f) => f.path === path);
    if (textMatches.length === 0) {
      return { ok: false, reason: `${path} is no longer in the project.` };
    }
    if (textMatches.length > 1 || liveBinaryPaths.has(path)) {
      // A text/binary path collision is the same ambiguity duplicatePaths() tracks
      // — Accept must never guess which file an op targets.
      const count = textMatches.length + (liveBinaryPaths.has(path) ? 1 : 0);
      return {
        ok: false,
        reason: `${count} files share the path ${path}. Resolve the duplicate-path conflict first.`,
      };
    }
    return { ok: true, file: textMatches[0]! };
  };

  for (const op of ops) {
    if (op.kind === "create") {
      const textMatches = liveText.filter((f) => f.path === op.path);
      if (textMatches.length > 0 || liveBinaryPaths.has(op.path) || plannedNewPaths.has(op.path)) {
        return { ok: false, reason: `${op.path} already exists — cannot create it.` };
      }
      plannedNewPaths.add(op.path);
      creates.push({ path: op.path, text: op.proposedText });
      continue;
    }

    if (op.kind === "create-binary") {
      // A binary create's path must be FREE of any text OR binary file (same
      // collision rule as a text create) — Accept must never create a second
      // file at a live path. The bytes-present check is the orchestrator's
      // async job (it can't run in this pure planner); the asset pointer is
      // carried through so the orchestrator can verify + apply it.
      const textMatches = liveText.filter((f) => f.path === op.path);
      if (textMatches.length > 0 || liveBinaryPaths.has(op.path) || plannedNewPaths.has(op.path)) {
        return { ok: false, reason: `${op.path} already exists — cannot create it.` };
      }
      if (op.binaryAsset === undefined) {
        // A well-formed create-binary op always carries a pointer (the mailbox
        // validator guarantees it); a missing one is a corrupt record — refuse.
        return { ok: false, reason: `${op.path} is a binary file with no asset pointer.` };
      }
      plannedNewPaths.add(op.path);
      binaryCreates.push({ path: op.path, asset: op.binaryAsset });
      continue;
    }

    if (op.kind === "delete") {
      const resolved = resolveOne(op.path);
      if (!resolved.ok) return resolved;
      deletes.push({ fileId: resolved.file.fileId });
      continue;
    }

    if (op.kind === "rename") {
      const resolved = resolveOne(op.path);
      if (!resolved.ok) return resolved;
      const dest = op.newPath!;
      const destTaken =
        liveText.some((f) => f.path === dest) ||
        liveBinaryPaths.has(dest) ||
        plannedNewPaths.has(dest);
      if (destTaken) {
        return { ok: false, reason: `${dest} already exists — cannot move ${op.path} onto it.` };
      }
      plannedNewPaths.add(dest);
      renames.push({ fileId: resolved.file.fileId, newPath: dest });
      continue;
    }

    // edit
    const resolved = resolveOne(op.path);
    if (!resolved.ok) return resolved;
    const file = resolved.file;
    const outcome = resolveAccept(file.text, op.baseText, op.proposedText, op.blocks);
    if (!outcome.applied) {
      // An empty-blocks edit (a restore op) is a full-file replacement, so its
      // conflict is a "file moved since the proposal", not a block re-match miss —
      // surface a message that fits (a stale block edit keeps its own wording).
      const reason =
        op.blocks.length === 0
          ? `${op.path} changed since the restore was proposed — re-request the restore to capture your latest edits.`
          : `${op.path} changed since the proposal (${outcome.conflicts} block(s) no longer match). Ask the agent to re-propose.`;
      return { ok: false, reason };
    }
    edits.push({ fileId: file.fileId, source: outcome.source! });
  }

  return { ok: true, plan: { creates, edits, renames, deletes, binaryCreates } };
}

/**
 * The ACCEPT-TIME blob-presence gate (A2 — the dangling-pointer guard). For each
 * `create-binary` op in a planned set, verify the bytes are ACTUALLY present (and
 * uncorrupt) in the blob store IMMEDIATELY before apply. `blobStore.get(hash)`
 * verifies-on-read (it re-hashes the stored bytes and returns undefined on any
 * mismatch), so this both proves presence AND integrity — `has()` may only check
 * backend presence, so we deliberately `get`. Returns ok ONLY when EVERY blob is
 * present; on the FIRST missing/corrupt blob it returns the offending path so the
 * orchestrator can leave the WHOLE proposal pending and apply NOTHING (all-or-
 * nothing — never a CRDT pointer to absent bytes). A plan with no binary creates
 * is trivially ok (text-only proposals never touch this path).
 */
export async function verifyBinaryBlobsPresent(
  binaryCreates: { path: string; asset: BinaryAsset }[],
  blobStore: { get(hash: string): Promise<Uint8Array | undefined> },
): Promise<{ ok: true } | { ok: false; missingPath: string }> {
  for (const b of binaryCreates) {
    // FAIL CLOSED on a store error (B3): a `get()` REJECTION (IndexedDB error,
    // quota read failure) must read as "blob not present", never escape as an
    // unhandled rejection — the accept then leaves the proposal pending exactly
    // like a missing blob, and the auto-accept path can roll its tombstone back.
    let bytes: Uint8Array | undefined;
    try {
      bytes = await blobStore.get(b.asset.hash);
    } catch {
      return { ok: false, missingPath: b.path };
    }
    if (bytes === undefined) return { ok: false, missingPath: b.path };
  }
  return { ok: true };
}

/**
 * Whether ANY binary file in `snapshot` references the content `hash` — the
 * refcount-by-snapshot guard for the A2/C1 release-orphan delete. It counts
 * SOFT-DELETED (tombstoned) binary files too: their bytes are RETAINED on purpose
 * so they can be restored (CollabProject.restoreBinary), so a tombstoned file's
 * hash must NEVER be deleted. A blob is safe to delete only when this returns false
 * (no live OR tombstoned reference) AND the proposal never published. Content-
 * addressed sharing (two files, one hash) is naturally covered — any referencing
 * entry blocks the delete. Versions are text-only, so `binaryFiles` is the complete
 * reference set. Pure, so the unit gate pins it directly.
 */
export function blobHashIsReferenced(snapshot: ProjectSnapshot, hash: string): boolean {
  return (snapshot.binaryFiles ?? []).some((f) => f.hash === hash);
}
