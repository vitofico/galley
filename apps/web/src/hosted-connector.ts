/**
 * Browser side of the hosted connector (ADR-0033 §1, §3): connecting a project
 * and keeping its server replica current.
 *
 * A connected project has a durable `connector` room on the relay. While the
 * project is open here, {@link openConnectorReplica} keeps it synced into that
 * room over its OWN connection, beside (never instead of) a Share connection:
 * the room id is never shown as a link, so sharing and connecting stay two
 * separate capabilities.
 *
 * DEFAULT OFF: every entry point is gated on {@link hostedConnectorEnabled} —
 * the served runtime config's literal `hostedConnector: true` on a signed-in
 * deployment. Without it nothing here touches the network, so local mode is
 * unchanged. Pure of React and the DOM (injectable fetch and socket).
 */
import {
  CollabConnection,
  WebSocketTransport,
  type DocHost,
  type WebSocketLike,
} from "@galley/collab";
import {
  CONNECTOR_REVIEW_MODES,
  isCapabilityRoomId,
  type ConnectorReviewMode,
} from "@galley/shared";
import { isAuthEnabled } from "./auth-gate.js";
import {
  CAPABILITY_FETCH_TIMEOUT_MS,
  timeoutSignal,
  type CapabilityFetch,
} from "./capability-rooms-client.js";
import { mintShareRoom } from "./share.js";

/** One connected project, as the server reports it to its owner. */
export interface ConnectedProject {
  roomId: string;
  projectId: string;
  reviewMode: ConnectorReviewMode;
  connectedAtMs: number;
}

export type ConnectorResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

/** Whether this deployment offers the hosted connector (operator switch + sign-in). */
export function hostedConnectorEnabled(
  config: unknown = (globalThis as { __GALLEY_CONFIG__?: unknown })
    .__GALLEY_CONFIG__,
): boolean {
  return (
    isAuthEnabled(config) &&
    (config as { hostedConnector?: unknown }).hostedConnector === true
  );
}

const ERROR_NOT_SIGNED_IN = "You're not signed in. Sign in and try again.";
const ERROR_EXISTS =
  "This project is already connected. Reload to see its current state.";
const ERROR_CAP =
  "You have reached the limit of connected projects on this server. Disconnect one and try again.";
const ERROR_GENERIC =
  "The server did not answer. Nothing was changed; try again.";

const defaultFetch = (): CapabilityFetch => fetch as unknown as CapabilityFetch;

/** One same-origin, cookie-authenticated call; never throws. */
async function call(
  path: string,
  body: unknown,
  fetchImpl: CapabilityFetch,
): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  try {
    const signal = timeoutSignal(CAPABILITY_FETCH_TIMEOUT_MS);
    const res = await fetchImpl(path, {
      credentials: "same-origin",
      ...(body !== undefined
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined; // a non-JSON body: fall through to the status mapping
    }
    if (res.ok) return { ok: true, json };
    const code = (json as { code?: unknown } | undefined)?.code;
    if (res.status === 401) return { ok: false, error: ERROR_NOT_SIGNED_IN };
    if (code === "exists") return { ok: false, error: ERROR_EXISTS };
    if (code === "cap-exceeded") return { ok: false, error: ERROR_CAP };
    return { ok: false, error: ERROR_GENERIC };
  } catch {
    return { ok: false, error: ERROR_GENERIC };
  }
}

function parseConnected(value: unknown): ConnectedProject | null {
  if (typeof value !== "object" || value === null) return null;
  const { roomId, projectId, reviewMode, connectedAtMs } = value as Record<
    string,
    unknown
  >;
  if (
    !isCapabilityRoomId(roomId) ||
    typeof projectId !== "string" ||
    !CONNECTOR_REVIEW_MODES.includes(reviewMode as ConnectorReviewMode) ||
    typeof connectedAtMs !== "number"
  )
    return null;
  return {
    roomId,
    projectId,
    reviewMode: reviewMode as ConnectorReviewMode,
    connectedAtMs,
  };
}

/** The signed-in person's connected projects. Malformed rows are dropped. */
export async function listConnectedProjects(
  fetchImpl: CapabilityFetch = defaultFetch(),
): Promise<ConnectorResult<{ projects: ConnectedProject[] }>> {
  const res = await call("/auth/connector/projects", undefined, fetchImpl);
  if (!res.ok) return res;
  const rows = (res.json as { projects?: unknown } | undefined)?.projects;
  if (!Array.isArray(rows)) return { ok: false, error: ERROR_GENERIC };
  return {
    ok: true,
    projects: rows.flatMap((row) => parseConnected(row) ?? []),
  };
}

/**
 * Connect a project: mint its room and register it as the project's grant, in
 * Ask mode. The server copy fills the next time the project is open here.
 */
export async function connectProject(
  projectId: string,
  fetchImpl: CapabilityFetch = defaultFetch(),
): Promise<ConnectorResult<{ project: ConnectedProject }>> {
  let roomId: string;
  try {
    roomId = mintShareRoom(); // CSPRNG-backed; throws without a secure source
  } catch {
    return {
      ok: false,
      error:
        "This browser has no secure random source, so a private room can't be created. Open Galley over HTTPS and try again.",
    };
  }
  const res = await call(
    "/auth/capability-rooms",
    { roomId, kind: "connector", projectId },
    fetchImpl,
  );
  if (!res.ok) return res;
  return {
    ok: true,
    project: {
      roomId,
      projectId,
      reviewMode: "ask",
      connectedAtMs: Date.now(),
    },
  };
}

/** Switch a connected project between Ask and Auto. */
export async function setConnectedProjectReviewMode(
  roomId: string,
  reviewMode: ConnectorReviewMode,
  fetchImpl: CapabilityFetch = defaultFetch(),
): Promise<ConnectorResult> {
  const res = await call(
    `/auth/connector/projects/${encodeURIComponent(roomId)}/review-mode`,
    { reviewMode },
    fetchImpl,
  );
  return res.ok ? { ok: true } : res;
}

/**
 * Disconnect a project: revoke its room. The relay then drops the connection
 * and erases the server copy. Unlike a Share teardown this is NOT best-effort:
 * the caller must know whether the server still holds the project.
 */
export async function disconnectProject(
  roomId: string,
  fetchImpl: CapabilityFetch = defaultFetch(),
): Promise<ConnectorResult> {
  const res = await call(
    `/auth/capability-rooms/${encodeURIComponent(roomId)}/revoke`,
    {},
    fetchImpl,
  );
  return res.ok ? { ok: true } : res;
}

/**
 * Keep an open project synced into its connector room. A second, presence-less
 * connection on the project's own document: local edits and anything arriving
 * over a Share connection flow to the server replica, and changes the hosted
 * connector made while no tab was open flow back and merge. The caller
 * destroys it when the project closes.
 */
export function openConnectorReplica(
  project: DocHost,
  syncUrl: string,
  roomId: string,
  socketFactory: (url: string) => WebSocketLike = (url) =>
    new WebSocket(url) as unknown as WebSocketLike,
): CollabConnection {
  const url = `${syncUrl.replace(/\/+$/, "")}/${encodeURIComponent(roomId)}`;
  const connection = new CollabConnection(
    project,
    new WebSocketTransport(() => socketFactory(url)),
  );
  connection.connect();
  return connection;
}
