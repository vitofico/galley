/**
 * Reaching a connected project (ADR-0033 §2): the connector is a PEER, never a
 * file writer. For one tool call it joins the project's room on the relay over
 * a websocket, waits for the relay's copy, runs the call against that replica
 * and leaves. It keeps nothing between calls and never opens the relay's files
 * (the store is single-writer and has no cross-process locks).
 *
 * The room id is a capability. It never appears in an error or a log line.
 */
import { WebSocket as WS } from "ws";
import {
  CollabConnection,
  CollabProject,
  WebSocketTransport,
  type WebSocketLike,
} from "@galley/collab";

/** How long one call waits for the relay's copy before giving up. */
export const SYNC_TIMEOUT_MS = 10_000;

/** The project could not be read from the relay (refused, down, or too slow). */
export class ProjectUnavailableError extends Error {
  constructor() {
    super("project unavailable");
  }
}

/** Run `fn` against a freshly synced replica of the room, then leave. */
export type ProjectRunner = <T>(
  roomId: string,
  fn: (project: CollabProject) => T | Promise<T>,
) => Promise<T>;

export function createProjectRunner(
  syncUrl: string,
  opts: {
    timeoutMs?: number;
    socketFactory?: (url: string) => WebSocketLike;
  } = {},
): ProjectRunner {
  const timeoutMs = opts.timeoutMs ?? SYNC_TIMEOUT_MS;
  const makeSocket =
    opts.socketFactory ??
    ((url: string) => {
      const socket = new WS(url);
      // Without a listener `ws` escalates a failed upgrade to an uncaught
      // exception. The failure itself surfaces as the "disconnected" status
      // below; the event text may embed the room id, so it is dropped.
      socket.addEventListener("error", () => {});
      return socket as unknown as WebSocketLike;
    });

  return async (roomId, fn) => {
    const project = new CollabProject();
    const url = `${syncUrl}/${encodeURIComponent(roomId)}`;
    // No presence: a read is not a collaborator in the room's roster. No
    // reconnect: one call gets one attempt, and a refusal is final.
    const connection = new CollabConnection(
      project,
      new WebSocketTransport(() => makeSocket(url), {
        reconnect: { enabled: false },
      }),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = () => reject(new ProjectUnavailableError());
        const timer = setTimeout(fail, timeoutMs);
        connection.onSynced(() => {
          clearTimeout(timer);
          resolve();
        });
        connection.onStatus((status) => {
          if (status === "disconnected" && !connection.synced) {
            clearTimeout(timer);
            fail();
          }
        });
        connection.connect();
      });
      return await fn(project);
    } finally {
      connection.destroy();
      project.destroy();
    }
  };
}
