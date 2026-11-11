/**
 * Going back from a change the hosted connector applied on its own (ADR-0033
 * §4). Before each such change the connector saves a checkpoint of the whole
 * project on the server. This module shows those checkpoints in the History
 * panel of the connected project, beside the versions saved in this browser,
 * and restores one the same way any version is restored: as the person's own
 * action, re-applied as edits.
 *
 * A checkpoint is listed only when the document may really have changed after
 * it (a change that hit a conflict applied nothing) and while the server still
 * keeps it. If the server cannot be asked, the local versions are listed alone.
 */
import type { CollabProject } from "@galley/collab";
import type { Author, Version, VersionStore } from "@galley/shared";
import type { CapabilityFetch } from "./capability-rooms-client.js";
import {
  fetchConnectorCheckpoint,
  listConnectorActivity,
} from "./hosted-connector.js";
import { restoreTreeAndBinaries } from "./hosted-history.js";

const PREFIX = "connector:";

type DatedVersion = Version & { createdAt?: number };
type DatedStore = VersionStore & {
  listVersionMetadata?: (projectId: string) => Promise<DatedVersion[]>;
};

const checkpointOf = (versionId: string): string | null =>
  versionId.startsWith(PREFIX) ? versionId.slice(PREFIX.length) : null;

/** Project paths of a checkpoint's text files (its tree uses relative ones). */
const textPaths = (files: readonly { path: string }[]): string[] =>
  files.map((f) => (f.path.startsWith("/") ? f.path : `/${f.path}`));

/**
 * `getRoom` returns the open project's connector room while it is connected,
 * else undefined: then this store is exactly `local`.
 */
export function createConnectorHistoryVersionStore(
  local: DatedStore,
  getRoom: () => string | undefined,
  fetchImpl?: CapabilityFetch,
): DatedStore {
  const dated = async (projectId: string): Promise<DatedVersion[]> => {
    const own: DatedVersion[] = local.listVersionMetadata
      ? await local.listVersionMetadata(projectId)
      : await local.listVersions(projectId);
    const room = getRoom();
    if (room === undefined) return own;
    const activity = await listConnectorActivity(room, fetchImpl);
    if (!activity.ok) return own;
    const rows = own.map((version, index) => ({
      version,
      time: version.createdAt ?? 0,
      index,
    }));
    for (const change of activity.changes) {
      if (!change.restorable || change.state === "conflict") continue;
      rows.push({
        version: {
          id: `${PREFIX}${change.checkpointId}`,
          projectId,
          name: `Before the connector's change: ${change.request}`.slice(0, 200),
          // The checkpoint's own time (the first 13 digits of its id).
          createdAt: Number(change.checkpointId.slice(0, 13)),
        },
        time: Number(change.checkpointId.slice(0, 13)),
        index: rows.length,
      });
    }
    // Oldest first, like every version store; undated local rows keep their order.
    rows.sort((a, b) => a.time - b.time || a.index - b.index);
    return rows.map((row) => row.version);
  };
  return {
    createVersion: (projectId, input, files) =>
      local.createVersion(projectId, input, files),
    listVersionMetadata: dated,
    listVersions: async (projectId) =>
      (await dated(projectId)).map(({ createdAt: _, ...version }) => version),
    async getVersionTree(versionId) {
      const id = checkpointOf(versionId);
      const room = getRoom();
      if (id === null) return local.getVersionTree(versionId);
      if (room === undefined) return null;
      return (await fetchConnectorCheckpoint(room, id, fetchImpl))?.files ?? null;
    },
  };
}

/**
 * Restore a connector checkpoint into the live project. Returns false for any
 * other kind of version (the caller restores those itself). Throws when the
 * checkpoint is gone or unsafe; nothing is changed then.
 */
export async function restoreConnectorCheckpoint(
  project: CollabProject,
  versionId: string,
  room: string | undefined,
  author: Author,
  fetchImpl?: CapabilityFetch,
): Promise<boolean> {
  const id = checkpointOf(versionId);
  if (id === null) return false;
  const checkpoint =
    room === undefined
      ? null
      : await fetchConnectorCheckpoint(room, id, fetchImpl);
  if (checkpoint === null)
    throw new Error("The server no longer keeps this checkpoint");
  restoreTreeAndBinaries(
    project,
    checkpoint.files,
    checkpoint.binaryFiles,
    textPaths(checkpoint.files),
    author,
  );
  return true;
}
