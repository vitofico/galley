/**
 * Browser side of server copies (ADR-0035): on a signed-in deployment every
 * project is kept on the server unless the person opts it out, so clearing the
 * browser's data no longer destroys the only copy.
 *
 * A project's copy lives in a durable `copy` room on the relay, registered for
 * the signed-in account. It is a replica and carries no grant: the hosted
 * connector cannot see it. Connecting the project turns the same room into a
 * connector room (hosted-connector.ts), so there is always exactly one server
 * replica per project.
 *
 * Every entry point is gated on {@link serverCopyEnabled}. Without an account
 * nothing here touches the network and a project stays in the browser only.
 * Pure of React (injectable fetch, socket and draft store).
 */
import { hostedStorageEnabled } from "./blob-session.js";
import { syncCopyAssets } from "./server-copy-assets.js";
import * as Y from "yjs";
import {
  CollabProject,
  type CollabConnection,
  type WebSocketLike,
} from "@galley/collab";
import { isCapabilityRoomId, isProjectReplicaKind } from "@galley/shared";
import { isAuthEnabled } from "./auth-gate.js";
import type { CapabilityFetch } from "./capability-rooms-client.js";
import { createIndexeddbDraftStore, type DraftStore } from "./collab-session.js";
import {
  call,
  connectProject,
  disconnectProject,
  openConnectorReplica,
  type ConnectorResult,
} from "./hosted-connector.js";
import { mintShareRoom } from "./share.js";

/** One project the server holds a replica of, as its owner sees it. */
export interface ServerCopy {
  roomId: string;
  projectId: string;
  /** The project's name when the copy was first kept (a label). */
  name?: string;
  /** `connector` when the project is also connected to the hosted connector. */
  kind: "copy" | "connector";
}

/** Whether this deployment keeps server copies (sign-in + a persisting relay). */
export function serverCopyEnabled(
  config: unknown = (globalThis as { __GALLEY_CONFIG__?: unknown })
    .__GALLEY_CONFIG__,
): boolean {
  return (
    isAuthEnabled(config) &&
    (config as { serverCopy?: unknown }).serverCopy === true
  );
}

const ERROR_GENERIC =
  "The server did not answer. Nothing was changed; try again.";

const defaultFetch = (): CapabilityFetch => fetch as unknown as CapabilityFetch;

function parseCopy(value: unknown): ServerCopy | null {
  if (typeof value !== "object" || value === null) return null;
  const { roomId, projectId, name, kind } = value as Record<string, unknown>;
  if (
    !isCapabilityRoomId(roomId) ||
    typeof projectId !== "string" ||
    !isProjectReplicaKind(kind)
  )
    return null;
  return {
    roomId,
    projectId,
    ...(typeof name === "string" ? { name } : {}),
    kind,
  };
}

/** The signed-in person's server copies. Malformed rows are dropped. */
export async function listServerCopies(
  fetchImpl: CapabilityFetch = defaultFetch(),
): Promise<ConnectorResult<{ copies: ServerCopy[]; localOnly: string[] }>> {
  const res = await call("/auth/project-replicas", undefined, fetchImpl);
  if (!res.ok) return res;
  const payload = res.json as {replicas?: unknown; localOnly?: unknown} | undefined;
  const rows = payload?.replicas;
  if (!Array.isArray(rows)) return { ok: false, error: ERROR_GENERIC };
  return {
    ok: true,
    localOnly: Array.isArray(payload?.localOnly)
      ? payload.localOnly.filter(
          (v): v is string => typeof v === "string",
        )
      : [],
    copies: rows.flatMap((row) => parseCopy(row) ?? []),
  };
}

/** A project name as the registry accepts it: one line, at most 120 characters. */
const projectName = (name: string): string =>
  name
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 120);

export function saveCopyPreference(projectId: string, localOnly: boolean) {
  return call(
    "/auth/project-replicas/preference",
    { projectId, localOnly, roomId: mintShareRoom() },
    defaultFetch(),
  );
}

/** Register a copy room for a project. It fills when the project is synced. */
export async function keepServerCopy(
  projectId: string,
  name: string,
  fetchImpl: CapabilityFetch = defaultFetch(),
): Promise<ConnectorResult<{ copy: ServerCopy }>> {
  let roomId: string;
  try {
    roomId = mintShareRoom(); // CSPRNG-backed; throws without a secure source
  } catch {
    return { ok: false, error: ERROR_GENERIC };
  }
  const label = projectName(name);
  const res = await call(
    "/auth/capability-rooms",
    {
      roomId,
      kind: "copy",
      projectId,
      ...(label !== "" ? { projectName: label } : {}),
    },
    fetchImpl,
  );
  if (!res.ok) return res;
  return {
    ok: true,
    copy: {
      roomId,
      projectId,
      ...(label !== "" ? { name: label } : {}),
      kind: "copy",
    },
  };
}

/** Turn a copy into a connected project, or a connected project back into a copy. */
export async function setServerCopyKind(
  roomId: string,
  kind: ServerCopy["kind"],
  fetchImpl: CapabilityFetch = defaultFetch(),
): Promise<ConnectorResult> {
  const res = await call(
    `/auth/project-replicas/${encodeURIComponent(roomId)}/kind`,
    { kind },
    fetchImpl,
  );
  return res.ok ? { ok: true } : res;
}

/**
 * Keep the copy's label at the project's current name, so a browser that
 * restores it names it as its owner last did. Best-effort: a stale label
 * loses no content.
 */
async function relabelServerCopy(
  copy: ServerCopy,
  name: string,
  fetchImpl: CapabilityFetch,
): Promise<void> {
  const label = projectName(name);
  if (label === "" || label === copy.name) return;
  await call(
    `/auth/project-replicas/${encodeURIComponent(copy.roomId)}/name`,
    { name: label },
    fetchImpl,
  );
}

/** localStorage key: the ids of projects the person keeps in this browser only. */
export const LOCAL_ONLY_KEY = "galley.serverCopy.localOnly.v1";

const RECOVERY_LOCAL_KEY = "galley.serverCopy.recoveredLocal.v1";

function localOnlyIds(key = LOCAL_ONLY_KEY): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

/** Whether the person opted this project out of its server copy. */
export function isLocalOnly(projectId: string): boolean {
  return (
    localOnlyIds().includes(projectId) ||
    localOnlyIds(RECOVERY_LOCAL_KEY).includes(projectId)
  );
}

/**
 * Record the per-project opt-out. Throws when it cannot be stored: an opt-out
 * that is forgotten on the next load would put the project back on the server.
 */
export function setLocalOnly(
  projectId: string,
  localOnly: boolean,
  key = LOCAL_ONLY_KEY,
): void {
  const ids = localOnlyIds(key).filter((id) => id !== projectId);
  if (localOnly) ids.push(projectId);
  localStorage.setItem(key, JSON.stringify(ids));
  if (
    !localOnly &&
    key !== RECOVERY_LOCAL_KEY &&
    localOnlyIds(RECOVERY_LOCAL_KEY).includes(projectId)
  )
    setLocalOnly(projectId, false, RECOVERY_LOCAL_KEY);
}

export function keepRecoveredProjectLocal(projectId: string) {
  setLocalOnly(projectId, true, RECOVERY_LOCAL_KEY);
}

/** Upgrade a browser-only opt-out once the user is signed in. A recovered
 * local project is never disclosed to an account by this migration. */
export async function migrateCopyPreference(projectId: string) {
  if (
    !localOnlyIds().includes(projectId) ||
    localOnlyIds(RECOVERY_LOCAL_KEY).includes(projectId)
  )
    return false;
  const result = await saveCopyPreference(projectId, true);
  if (result.ok) setLocalOnly(projectId, false);
  return result.ok;
}

/**
 * The copy room an open project should sync into: the one it has, or a new
 * one unless the person keeps the project in this browser only. Null means
 * the project has no server copy.
 */
export async function ensureServerCopy(
  projectId: string,
  name: string,
  fetchImpl: CapabilityFetch = defaultFetch(),
): Promise<ServerCopy | null> {
  if (isLocalOnly(projectId)) {
    await migrateCopyPreference(projectId);
    return null;
  }
  const listed = await listServerCopies(fetchImpl);
  if (!listed.ok) return null;
  const existing = listed.copies.find((c) => c.projectId === projectId);
  if (existing !== undefined) {
    await relabelServerCopy(existing, name, fetchImpl);
    return existing;
  }
  if (listed.localOnly.includes(projectId)) return null;
  const kept = await keepServerCopy(projectId, name, fetchImpl);
  return kept.ok ? kept.copy : null;
}

/** The browser database a project this device holds keeps its document in. */
export const localProjectDbName = (projectId: string): string =>
  `galley-local-project-v1-${projectId}`;

export interface ServerCopySyncDeps {
  socketFactory?: (url: string) => WebSocketLike;
  draftStore?: (dbName: string, doc: Y.Doc) => DraftStore;
  /** How long to wait for the relay before giving up. */
  timeoutMs?: number;
  fetchImpl?: CapabilityFetch;
}

const hasContent = (doc: Y.Doc): boolean =>
  Y.decodeStateVector(Y.encodeStateVector(doc)).size > 0;

/** Resolves true once the relay's state has merged, false at the timeout. */
function whenSynced(
  connection: CollabConnection,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    connection.onSynced(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Bring the server copy of a project that is NOT open up to date, from the
 * document this browser holds, registering the copy first when the project
 * has none. `empty` means the browser holds no document for it yet (a project
 * never opened), so nothing is registered and nothing is kept.
 */
export async function uploadServerCopy(
  held: { id: string; name: string },
  existing: ServerCopy | undefined,
  syncUrl: string,
  deps: ServerCopySyncDeps = {},
): Promise<"synced" | "assets" | "empty" | "failed"> {
  const project = new CollabProject();
  const store = (deps.draftStore ?? createIndexeddbDraftStore)(
    localProjectDbName(held.id),
    project.doc,
  );
  let connection: CollabConnection | undefined;
  try {
    await store.whenSynced;
    if (!hasContent(project.doc)) return "empty";
    let copy = existing;
    if (copy === undefined) {
      const kept = await keepServerCopy(held.id, held.name, deps.fetchImpl);
      if (!kept.ok) return "failed";
      copy = kept.copy;
    } else {
      await relabelServerCopy(
        copy,
        held.name,
        deps.fetchImpl ?? defaultFetch(),
      );
    }
    connection = openConnectorReplica(
      project,
      syncUrl,
      copy.roomId,
      deps.socketFactory,
    );
    if (!(await whenSynced(connection, deps.timeoutMs ?? 30_000)))
      return "failed";
    if (
      hostedStorageEnabled() &&
      !(await connection.confirmPersisted(deps.timeoutMs ?? 30_000))
    ) return "failed";
    try {
      await syncCopyAssets(project, held.id, syncUrl, copy.roomId);
    } catch {
      return "assets";
    }
    return "synced";
  } catch {
    return "failed";
  } finally {
    connection?.destroy();
    store.destroy();
    project.destroy();
  }
}

/**
 * Write a project this browser does not hold into its storage, from the
 * server copy. The document is fetched first and stored only once it is
 * whole, so the project never opens on starter content that would then merge
 * into the copy. `empty` means the server holds nothing for it yet.
 */
export async function restoreServerCopy(
  copy: ServerCopy,
  syncUrl: string,
  deps: ServerCopySyncDeps = {},
): Promise<"restored" | "empty" | "failed"> {
  const project = new CollabProject();
  let connection: CollabConnection | undefined;
  let store: DraftStore | undefined;
  try {
    connection = openConnectorReplica(
      project,
      syncUrl,
      copy.roomId,
      deps.socketFactory,
    );
    if (!(await whenSynced(connection, deps.timeoutMs ?? 30_000)))
      return "failed";
    if (!hasContent(project.doc)) return "empty";
    // Copies created before hosted assets can contain pointers whose bytes
    // were never uploaded. Preserve their text; the editor retries the assets
    // and displays an incomplete-copy status while any are missing.
    await syncCopyAssets(
      project,
      copy.projectId,
      syncUrl,
      copy.roomId,
      true,
    ).catch(() => undefined);
    store = (deps.draftStore ?? createIndexeddbDraftStore)(
      localProjectDbName(copy.projectId),
      project.doc,
    );
    await store.whenSynced;
    return "restored";
  } catch {
    return "failed";
  } finally {
    connection?.destroy();
    store?.destroy();
    project.destroy();
  }
}

/**
 * Erase a project's server replica: revoke its room, which the relay then
 * drops and erases. Succeeds when the project has none. NOT best-effort: the
 * caller must know whether the server still holds the project.
 */
export async function eraseServerCopy(
  projectId: string,
  fetchImpl: CapabilityFetch = defaultFetch(),
): Promise<ConnectorResult> {
  const listed = await listServerCopies(fetchImpl);
  if (!listed.ok) return listed;
  const copy = listed.copies.find((c) => c.projectId === projectId);
  return copy === undefined
    ? { ok: true }
    : disconnectProject(copy.roomId, fetchImpl);
}

/**
 * Connect a project to the hosted connector. Where the server already keeps a
 * copy of it, that same replica becomes the connector room, so a project never
 * has two.
 */
export async function connectKeepingCopy(
  projectId: string,
  name: string,
  fetchImpl: CapabilityFetch = defaultFetch(),
): Promise<ConnectorResult> {
  if (!serverCopyEnabled()) return connectProject(projectId, name, fetchImpl);
  const listed = await listServerCopies(fetchImpl);
  if (!listed.ok) return listed;
  const copy = listed.copies.find((c) => c.projectId === projectId);
  return copy === undefined
    ? connectProject(projectId, name, fetchImpl)
    : setServerCopyKind(copy.roomId, "connector", fetchImpl);
}

/**
 * Disconnect a project from the hosted connector. Its replica stays on as a
 * plain server copy, out of the connector's reach, unless this deployment
 * keeps no copies or the person keeps the project in this browser only; then
 * the room is revoked and the replica erased.
 */
export async function disconnectKeepingCopy(
  roomId: string,
  projectId: string,
  fetchImpl: CapabilityFetch = defaultFetch(),
): Promise<ConnectorResult> {
  return serverCopyEnabled() && !isLocalOnly(projectId)
    ? setServerCopyKind(roomId, "copy", fetchImpl)
    : disconnectProject(roomId, fetchImpl);
}

/** Remove the document this browser holds for a project. Best-effort. */
export function deleteLocalProjectDb(projectId: string): void {
  try {
    indexedDB.deleteDatabase(localProjectDbName(projectId));
  } catch {
    // No IndexedDB here: there is nothing to remove.
  }
}
