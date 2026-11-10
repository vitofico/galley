import { CollabProject, registerAuthor, type BinaryAsset } from "@galley/collab";
import type { Author } from "@galley/shared";
import * as Y from "yjs";
import { applyMinimalDiff } from "./apply-minimal-diff.js";

/**
 * Apply an accepted source to a project FILE as the AGENT acting as a DISTINCT
 * peer, so the new spans attribute to the agent (ADR-0012) — the project sibling
 * of `applyAcceptedSourceAsAgent`. Cross-peer attribution keys off each item's
 * originating Yjs `clientID`, and a `Y.Doc` has exactly one, so we spin up a
 * transient agent `CollabProject` mirroring the main one, register it as the
 * agent, apply the minimal-diff to THAT file's `Y.Text` there (minting items
 * under the agent's clientID), then merge just that delta back. No clobber: it's
 * the same minimal prefix/suffix diff as the human path.
 */
export function applyAcceptedFileAsAgent(
  project: CollabProject,
  fileId: string,
  target: string,
  runId: string,
): void {
  const live = project.fileText(fileId);
  if (!live || live.toString() === target) return;
  const agent: Author = { kind: "agent", runId };
  const agentProject = new CollabProject(new Y.Doc());
  agentProject.applyUpdate(project.encodeState());
  registerAuthor(agentProject, agent);
  const ytext = agentProject.fileText(fileId);
  if (!ytext) {
    agentProject.destroy();
    return;
  }
  agentProject.transactFile(fileId, (t) => applyMinimalDiff(t, target), agent);
  project.applyUpdate(
    Y.encodeStateAsUpdate(agentProject.doc, Y.encodeStateVector(project.doc)),
  );
  agentProject.destroy();
}

/**
 * Apply a whole accepted MULTI-FILE change set as the agent peer in ONE merged
 * update (the `propose_files` Accept). Every create + edit is staged on a
 * transient agent-cloned project, then the single resulting delta is merged back
 * into the live project — so the live doc's observers see ONE atomic update with
 * no partial landing and no empty-file intermediate, and a mid-apply failure
 * leaves the live project untouched (the throw is contained in the clone). The
 * caller MUST have validated every op against the live snapshot first
 * (`planFileProposalAccept`); this only stages the pre-resolved plan.
 */
export function applyAcceptedFileSetAsAgent(
  project: CollabProject,
  plan: {
    creates: { path: string; text: string }[];
    edits: { fileId: string; source: string }[];
    renames?: { fileId: string; newPath: string; binary?: true }[];
    deletes?: { fileId: string; binary?: true }[];
    /**
     * A2: new binary files — a path + a content-addressed pointer. The CALLER
     * (the accept orchestrator) MUST have verified every blob's bytes are present
     * in the store before calling this; here we only write the CRDT pointer.
     */
    binaryCreates?: { path: string; asset: BinaryAsset }[];
  },
  runId: string,
): void {
  const renames = plan.renames ?? [];
  const deletes = plan.deletes ?? [];
  const binaryCreates = plan.binaryCreates ?? [];
  if (
    plan.creates.length === 0 &&
    plan.edits.length === 0 &&
    renames.length === 0 &&
    deletes.length === 0 &&
    binaryCreates.length === 0
  )
    return;
  const agent: Author = { kind: "agent", runId };
  const agentProject = new CollabProject(new Y.Doc());
  agentProject.applyUpdate(project.encodeState());
  registerAuthor(agentProject, agent);
  try {
    for (const c of plan.creates) {
      // Create empty then diff in the body so the new spans attribute to the
      // agent's clientID (ADR-0012) — same shape as the single-file path.
      const id = agentProject.create(c.path, "", agent);
      if (c.text.length > 0) {
        agentProject.transactFile(
          id,
          (t) => applyMinimalDiff(t, c.text),
          agent,
        );
      }
    }
    for (const e of plan.edits) {
      const live = agentProject.fileText(e.fileId);
      if (live && live.toString() !== e.source) {
        agentProject.transactFile(
          e.fileId,
          (t) => applyMinimalDiff(t, e.source),
          agent,
        );
      }
    }
    // Rename is metadata-only (path is not the key) so the Y.Text + its
    // attribution history survive; delete sets the recoverable soft-delete flag.
    for (const r of renames) {
      if (r.binary) agentProject.renameBinary(r.fileId, r.newPath, agent);
      else agentProject.rename(r.fileId, r.newPath, agent);
    }
    for (const d of deletes) {
      if (d.binary) agentProject.deleteBinary(d.fileId, agent);
      else agentProject.delete(d.fileId, agent);
    }
    // A2: write the binary file POINTER (path + {hash,size,mime}); the bytes are
    // already in the project blob store (the orchestrator verified them before
    // calling us). createBinary never sets main (the compile entry is text).
    for (const b of binaryCreates) {
      agentProject.createBinary(b.path, b.asset, agent);
    }
    project.applyUpdate(
      Y.encodeStateAsUpdate(agentProject.doc, Y.encodeStateVector(project.doc)),
    );
  } finally {
    agentProject.destroy();
  }
}

