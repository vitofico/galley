/**
 * A FAKE browser responder for kernel tests (#16.3a, ADR-0021) — and the
 * REFERENCE IMPLEMENTATION of the responder side of the control-mailbox
 * contract: the browser slice (apps/web's Agent Access surface) must follow
 * exactly this loop. Test-only in apps/mcp; never imported by the kernel
 * runtime.
 *
 * The responder contract (what the browser must do):
 *   1. JOIN the control room it minted (here: over the real relay, as a peer).
 *   2. WAKE on `observeControlRequests` (and once at startup, for requests
 *      that replicated before the observer attached) and pull the work list
 *      via `readControlRequests` — well-formed, unanswered, oldest-first,
 *      already capped by the mailbox.
 *   3. ANSWER each request EXACTLY ONCE via `publishControlResponse` —
 *      tracked by the LOCAL answered-set; the read uses `includeAnswered` and
 *      the publish uses `overwrite: true` (HIGH-1 anti-squatting), and every
 *      response is HMAC-SIGNED with the out-of-band response key:
 *        - `list_projects` {}            → ok: [{ projectId, name, lastModified? }]
 *        - `list_versions` { projectId } → ok: [{ id, name, message?, createdAt? }]
 *          (metadata ONLY — never file contents)
 *        - `open_project`  { projectId } → the browser OPENS the project
 *          visibly, mints a FRESH `share-<random>` room, joins it with the
 *          project's live doc, and answers
 *          ok: { syncUrl, room, projectId, mainFile } — echoing the REQUESTED
 *          projectId and pointing at the SAME relay the control room lives on.
 *        - unknown op / unknown project  → ok: false with a short error (the
 *          authority refuses; it never guesses).
 *   4. PRUNE on every wake (`pruneControlMailbox`) — answered or not. The
 *      responder is the mailbox's garbage collector of last resort: the
 *      hard-bounds pass (malformed/orphan/expired/total-caps) must run even
 *      when a drain tick answered nothing, or a garbage-only flood would
 *      accumulate unchecked.
 *
 * Hostile-test hooks (`answer`, `mintRoom`, `projectSyncUrl`) let tests script
 * a misbehaving responder; the defaults are the honest reference behavior.
 */
import * as Y from "yjs";
import { WebSocket as WS } from "ws";
import type { Author } from "@galley/shared";
import {
  CollabProject,
  CollabConnection,
  WebSocketTransport,
  publishControlResponse,
  readControlRequests,
  observeControlRequests,
  pruneControlMailbox,
  controlResponseSigningString,
  hmacControlResponse,
  type ControlRequest,
  type ControlResponseInput,
  type DocHost,
  type WebSocketLike,
} from "@galley/collab";

const BROWSER: Author = { kind: "human", userId: "fake-browser" };

/**
 * A ws socket whose 'error' events are observed — tests can stop the responder
 * while a socket is still CONNECTING; with no listener the `ws` package's
 * async abort error would become an uncaught exception.
 */
function quietSocket(url: string): WebSocketLike {
  const socket = new WS(url);
  socket.addEventListener("error", () => {});
  return socket as unknown as WebSocketLike;
}

/** One project the fake browser "has in its library". */
export interface FakeProject {
  projectId: string;
  name: string;
  lastModified?: number;
  /** The main file the open_project handoff names. */
  mainFile: string;
  /** path → text; seeded into the project room when the project is opened. */
  files: Record<string, string>;
  versions?: { id: string; name: string; message?: string; createdAt?: number }[];
}

export interface FakeResponderOptions {
  /** The relay base URL (e.g. ws://127.0.0.1:<port>) — control AND project rooms. */
  syncUrl: string;
  /** The control room to join and answer in. */
  controlRoom: string;
  projects: FakeProject[];
  /**
   * Script hook: intercept a request before the default answer. Return a
   * response to send it, or null to STAY SILENT (the requester must time out).
   * `byDefault()` computes (and for open_project, performs) the honest answer.
   */
  answer?: (
    request: ControlRequest,
    byDefault: () => ControlResponseInput,
  ) => ControlResponseInput | null;
  /** Override the fresh project-room id (default: CSPRNG share-<uuid>). */
  mintRoom?: () => string;
  /** Override the syncUrl returned by open_project (default: opts.syncUrl). */
  projectSyncUrl?: () => string;
  /** Override the per-grant token returned by open_project (default: a uuid). */
  grantId?: () => string;
  /**
   * The per-session response-auth key (HIGH-1). When present, EVERY response is
   * HMAC-signed (the reference responder behavior) and published with the
   * responder's `overwrite` privilege; when absent the responder answers
   * UNSIGNED — the hostile-test mode proving the kernel ignores such answers.
   */
  responseKey?: Uint8Array;
}

export interface FakeResponder {
  /** Project rooms this responder opened (room id → seeded project), for assertions. */
  openedRooms: Map<string, CollabProject>;
  stop(): void;
}

function mintShareRoom(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") return `share-${c.randomUUID()}`;
  throw new Error("fake-control-responder: a secure random source is required");
}

/** A per-grant token (ADR-0023 §1) — a uuid is a valid base64url grantId. */
function mintGrantId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  throw new Error("fake-control-responder: a secure random source is required");
}

/** Start the fake browser: join the control room and answer requests forever. */
export function startFakeControlResponder(opts: FakeResponderOptions): FakeResponder {
  const host: DocHost = { doc: new Y.Doc() };
  const url = `${opts.syncUrl}/${encodeURIComponent(opts.controlRoom)}`;
  const connection = new CollabConnection(
    host,
    new WebSocketTransport(() => quietSocket(url)),
    { author: BROWSER },
  );
  connection.connect();

  const openedRooms = new Map<string, CollabProject>();
  const openedConnections: CollabConnection[] = [];
  const answered = new Set<string>();
  let stopped = false;

  /** The honest default answer — the reference responder semantics. */
  const defaultAnswer = (request: ControlRequest): ControlResponseInput => {
    const { id, op, params } = request;
    if (op === "list_projects") {
      return {
        id,
        ok: true,
        result: opts.projects.map((p) => ({
          projectId: p.projectId,
          name: p.name,
          ...(p.lastModified !== undefined ? { lastModified: p.lastModified } : {}),
        })),
      };
    }
    const project = opts.projects.find((p) => p.projectId === params["projectId"]);
    if (op === "list_versions") {
      if (project === undefined) return { id, ok: false, error: "unknown project" };
      return { id, ok: true, result: project.versions ?? [] };
    }
    if (op === "open_project") {
      if (project === undefined) return { id, ok: false, error: "unknown project" };
      // "The browser opens the project visibly": seed its live doc into a
      // FRESH share room on the same relay, then hand the kernel the room.
      const room = (opts.mintRoom ?? mintShareRoom)();
      const collab = new CollabProject();
      for (const [path, text] of Object.entries(project.files)) {
        collab.create(path, text, BROWSER);
      }
      const projectUrl = `${opts.syncUrl}/${encodeURIComponent(room)}`;
      const projectConnection = new CollabConnection(
        collab,
        new WebSocketTransport(() => quietSocket(projectUrl)),
        { author: BROWSER },
      );
      projectConnection.connect();
      openedRooms.set(room, collab);
      openedConnections.push(projectConnection);
      return {
        id,
        ok: true,
        result: {
          syncUrl: (opts.projectSyncUrl ?? (() => opts.syncUrl))(),
          room,
          projectId: project.projectId,
          mainFile: project.mainFile,
          grantId: (opts.grantId ?? mintGrantId)(),
        },
      };
    }
    return { id, ok: false, error: `unsupported op: ${op}` };
  };

  const drainAsync = async (): Promise<void> => {
    if (stopped) return;
    // includeAnswered (HIGH-1 anti-squatting, mirroring the browser mount): a
    // forged response squatting a request must not silence this responder —
    // it skips only what IT answered and publishes with overwrite.
    for (const request of readControlRequests(host, { includeAnswered: true })) {
      if (answered.has(request.id)) continue;
      const response = opts.answer
        ? opts.answer(request, () => defaultAnswer(request))
        : defaultAnswer(request);
      answered.add(request.id);
      if (response === null) continue; // scripted silence — the kernel must time out
      const signed =
        opts.responseKey !== undefined
          ? {
              ...response,
              sig: await hmacControlResponse(
                opts.responseKey,
                controlResponseSigningString(response),
              ),
            }
          : response;
      if (stopped) return;
      publishControlResponse(host, signed, BROWSER, { overwrite: true });
    }
    // Responder GC (contract step 4): the hard-bounds pass runs on EVERY wake
    // — answered or not (Security round 2, finding 1: a malformed-only or
    // orphan-response flood must not survive a drain tick). It returns 0
    // WITHOUT a transaction when already in bounds, so this observer-driven
    // call cannot ping-pong.
    pruneControlMailbox(host, BROWSER);
  };
  const drain = (): void => {
    void drainAsync();
  };

  const unobserve = observeControlRequests(host, drain);
  drain(); // requests that replicated before the observer attached

  return {
    openedRooms,
    stop(): void {
      stopped = true;
      unobserve();
      connection.destroy();
      for (const c of openedConnections) c.destroy();
      for (const p of openedRooms.values()) p.destroy();
      host.doc.destroy();
    },
  };
}
