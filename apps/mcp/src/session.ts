/**
 * The kernel's room session (#16.1, ADR-0020): join the shared project's Yjs
 * room as a PEER over the existing apps/sync relay (`CollabConnection` +
 * `WebSocketTransport` over the `ws` package — the same client the sync-server
 * tests build), replicate the `CollabProject`, and hand the tool layer ONLY the
 * wrapped read+propose surface (surface.ts).
 *
 * The kernel only ever JOINS the room named in its config (an unguessable
 * capability copied from the browser's Share surface) — it never creates,
 * lists, or probes rooms. It presents itself in presence as an agent peer, so
 * collaborators can see it in the editor count.
 */
import { WebSocket as WS } from "ws";
import {
  CollabProject,
  CollabConnection,
  WebSocketTransport,
  registerAuthor,
  deriveProposalKey,
  signProposal,
  type WebSocketLike,
  type ProposalScope,
  type ProposalSigner,
} from "@galley/collab";
import type { Author } from "@galley/shared";
import { roomFingerprint } from "./config.js";
import { createToolSurface, type ReadLimitOverrides, type ToolSurface } from "./surface.js";
import { createKernelBlobSession, type KernelBlobSession } from "./blob-session.js";
import { buildBlobTerminalAuth } from "@galley/collab";

/** The kernel's stable agent identity (proposals + presence are tagged with it). */
export const MCP_AUTHOR: Author = { kind: "agent", runId: "mcp" };

/**
 * Honest, room-derived liveness (ADR-0024 §1). EVERY field is observed from the
 * room — the kernel's own relay socket plus the y-protocols Awareness roster —
 * never inferred from the local replica. A successful read therefore NEVER
 * implies a browser is attached: a browser that left the room disappears from
 * awareness (deterministic awareness lifecycle, no 30 s ghost), so a stale-but-
 * plausible replica can no longer mask a dead surface.
 */
export interface Liveness {
  /** The kernel's own socket to the relay is open (tracked via onStatus). */
  relayConnected: boolean;
  /** ≥1 NON-agent (human) peer is present in the room right now. */
  browserAttached: boolean;
  /** Count of non-agent awareness peers (the kernel's own presence excluded). */
  humanPeers: number;
  /** Monotonic ms of the most recent awareness change that saw a human peer. */
  lastBrowserSeenMs: number | null;
}

/** The scope coordinates (minus the per-mailbox name) a signer binds to (ADR-0023 §1). */
export interface ProposalSignerBase {
  grantId: string;
  controlRoom: string;
  syncUrl: string;
  projectId: string;
  shareRoom: string;
}

/**
 * Build the per-grant {@link ProposalSigner} (ADR-0023 §1): for each mailbox it
 * derives `K = HKDF(responseKey; scope)` ONCE (cached — the same key signs every
 * proposal to that mailbox) and HMAC-signs the canonical proposal bytes. The
 * browser re-derives the SAME `K` from the SAME `responseKey` + scope and
 * verifies; a mere room peer, lacking `responseKey`, cannot forge a signature.
 * Extracted (and exported) so the derive→sign roundtrip is unit-testable without
 * a live socket. Key derivation is lazy + memoized so building a signer is cheap.
 */
export function buildProposalSigner(
  base: ProposalSignerBase,
  responseKey: Uint8Array,
): ProposalSigner {
  const keys = new Map<string, ReturnType<typeof deriveProposalKey>>();
  return (signable, mailbox) => {
    const scope: ProposalScope = { ...base, mailbox };
    let keyP = keys.get(mailbox);
    if (keyP === undefined) {
      keyP = deriveProposalKey(responseKey, scope);
      keys.set(mailbox, keyP);
    }
    return keyP.then((key) => signProposal(key, scope, signable));
  };
}

export interface KernelSession {
  surface: ToolSurface;
  /**
   * The per-grant token bound at open_project (ADR-0023 §1), or undefined for a
   * local/un-paired join (no control handoff minted one). Task 4 reads it to
   * derive the per-grant signing key and sign every published proposal.
   */
  grantId?: string;
  /**
   * Resolves once the target file is live in the replicated doc — i.e. the
   * initial sync delivered the shared project and the scoped file exists.
   * Rejects (structured message, no stack secrets) on timeout: an absent room
   * or file is a config error the user must see, not something to serve
   * half-synced tools over.
   */
  whenFileReady(timeoutMs?: number): Promise<void>;
  /**
   * Honest, room-derived liveness (ADR-0024 §1) — read on demand from the relay
   * socket + the awareness roster. server.ts merges it into every per-project
   * tool result so the agent (and the operator) can see whether anybody is
   * actually watching, instead of trusting the local replica.
   */
  liveness(): Liveness;
  /**
   * The galley-blob-v1 byte channel for this room (Phase 1 byte-transport), or
   * undefined when no blob socket could be minted (a test that injects only a
   * sync `socketFactory` and no `blobSocketFactory` runs WITHOUT a blob channel,
   * so existing tests are unaffected). OPT-IN (rework §E14): present but NOT
   * connected — a later phase (A1/A2) calls `blob.connect()` then
   * `blob.expect()`/`blob.putBlob()`/`blob.onBlob()` to wire an image-transport
   * MCP tool. THIS phase wires no tool, so the idle kernel opens no blob socket.
   */
  blob?: KernelBlobSession;
  destroy(): void;
}

export interface JoinRoomOptions {
  /** Injectable socket for tests; defaults to the `ws` package. */
  socketFactory?: (url: string) => WebSocketLike;
  /**
   * Injectable blob-channel socket factory (Phase 1 byte-transport). When the
   * default `ws`-package sync socket is in use (no injected `socketFactory`), the
   * blob channel is minted automatically over the same `ws` package. When a test
   * injects a custom sync `socketFactory` it must ALSO inject this to get a blob
   * channel — otherwise none is created and `session.blob` is undefined, keeping
   * existing in-process-network tests (which have no blob relay) unchanged.
   */
  blobSocketFactory?: (url: string) => WebSocketLike;
  /** Injectable monotonic clock for lastBrowserSeenMs; defaults to Date.now. */
  now?: () => number;
}

export function joinRoom(
  config: {
    syncUrl: string;
    room: string;
    filePath: string;
    grantId?: string;
    /**
     * The remaining scope coordinates + the pairing secret needed to SIGN
     * proposals (ADR-0023 §1). All present together (the control open_project
     * path always supplies them) → the session signs every proposal; absent (a
     * direct/local CLI join) → proposals publish UNSIGNED, exactly as before.
     */
    controlRoom?: string;
    projectId?: string;
    responseKey?: Uint8Array;
    /** Lowered read caps from launch args (D2); absent ⇒ READ_LIMITS defaults. */
    readLimits?: ReadLimitOverrides;
  },
  opts: JoinRoomOptions = {},
): KernelSession {
  const project = new CollabProject();
  const url = `${config.syncUrl}/${encodeURIComponent(config.room)}`;
  const makeSocket =
    opts.socketFactory ??
    ((u: string) => {
      const socket = new WS(u);
      // SEC-16.3c — mirror of control.ts's control-room error listener: one
      // stderr line per socket failure (never a throw/stack; without a listener
      // `ws` escalates the error event to an uncaught exception). The room id is
      // a CAPABILITY: scrub it — plain and URL-encoded — from whatever text the
      // socket library produced (some errors embed the request URL) before the
      // line reaches stderr/support bundles.
      socket.addEventListener("error", (event) => {
        const raw = (event as { message?: string }).message ?? "connection error";
        const scrubbed = raw
          .split(config.room)
          .join("<project-room>")
          .split(encodeURIComponent(config.room))
          .join("<project-room>");
        console.error(`galley mcp kernel: project-room socket error: ${scrubbed}`);
      });
      return socket as unknown as WebSocketLike;
    });
  const connection = new CollabConnection(
    project,
    new WebSocketTransport(() => makeSocket(url)),
    { author: MCP_AUTHOR },
  );
  connection.connect();
  // Record this peer's clientID → agent identity in the doc-global authors map
  // (write-once; the kernel joins empty, so there is no seed to suppress).
  registerAuthor(project, MCP_AUTHOR);

  // --- Honest liveness (ADR-0024 §1) ----------------------------------------
  // relayConnected is OBSERVED from the socket via onStatus (the private socket
  // boolean is not exposed): false until the first open, flipped by every
  // (re)connect / drop. The in-process test network has no onStatus, but the
  // real ws transport always emits it, so the runtime path is honest.
  const now = opts.now ?? Date.now;
  let relayConnected = false;
  connection.onStatus((status) => {
    relayConnected = status === "connected";
  });

  // Count human peers from the awareness roster, EXCLUDING the kernel's own
  // (agent) presence — both by clientID and by author.kind, belt-and-braces.
  const ownClientId = connection.clientID;
  const humanPeerCount = (): number => {
    let n = 0;
    for (const [clientId, state] of connection.awareness.getStates()) {
      if (clientId === ownClientId) continue;
      const presence = state as { author?: Author; agentWorker?: unknown } | undefined;
      const author = presence?.author;
      if (author === undefined || author.kind === "agent") continue;
      // F13 (ADR-0024 §1): an in-browser HEADLESS agent-apply host attaches to keep
      // applying a paired agent's proposals while the project is NOT the active
      // editor document — i.e. with NO human watching the review surface. It carries
      // a `human` author (it IS a browser editing the doc), but it advertises the
      // honest `agentWorker: true` presence marker so it is NOT counted as a human
      // peer here. Without this exclusion an attached worker would make
      // browserAttached true and silently suppress `pending_review_unwatched`,
      // lying to the agent that a human is watching when none is. A worker is not a
      // watcher, so it must not flip the room "watched".
      if (presence?.agentWorker === true) continue;
      n += 1;
    }
    return n;
  };

  // lastBrowserSeenMs: stamp the most recent awareness change that saw a human
  // peer. A "change"/"update" listener fires on every join/leave/update, so a
  // browser that attaches (then leaves) leaves a monotonic timestamp behind.
  let lastBrowserSeenMs: number | null = null;
  const onAwareness = (): void => {
    if (humanPeerCount() > 0) lastBrowserSeenMs = now();
  };
  // "update" fires on every awareness frame (join/leave/update/keepalive) — the
  // same event the connection itself binds — so it is guaranteed present and
  // catches a human peer the moment its presence lands.
  connection.awareness.on("update", onAwareness);
  // Seed the timestamp if a human is somehow already present at join time.
  onAwareness();

  // --- galley-blob-v1 byte channel (Phase 1) --------------------------------
  // Mint the kernel blob session beside the sync connection, over the SAME room +
  // relay. OPT-IN (rework §E14): it is CONSTRUCTED but NOT connected — the idle
  // kernel exposes no blob surface until a consumer (a future A1/A2 tool) calls
  // `session.blob.connect()`. Optional + additive: created only when a blob
  // socket is available —
  //  - default (no injected sync `socketFactory`): the `ws` package;
  //  - an injected sync `socketFactory`: only when `blobSocketFactory` is ALSO
  //    injected. So existing tests using the in-process network (which has no
  //    blob relay) and passing only `socketFactory` get NO blob channel and are
  //    byte-for-byte unchanged.
  //
  // TERMINAL-FRAME AUTHENTICATION (rework rd3 §1): when the control handoff
  // supplied the full grant scope + the pairing secret (the same set that gates
  // proposal signing), derive the blob-terminal {signer, verifier} so this
  // channel ENFORCES authenticated completion — putBlob resolves only on a MAC-
  // verified COMPLETE and a forged COMPLETE/ABORT from a 3rd room peer is ignored.
  // Absent (a direct/local CLI join) ⇒ no auth ⇒ completion is advisory/forgeable
  // (documented). The kernel's responseKey is already in `config` here.
  const terminalAuth =
    config.grantId !== undefined &&
    config.controlRoom !== undefined &&
    config.projectId !== undefined &&
    config.responseKey !== undefined
      ? buildBlobTerminalAuth(config.responseKey, {
          grantId: config.grantId,
          controlRoom: config.controlRoom,
          syncUrl: config.syncUrl,
          projectId: config.projectId,
          shareRoom: config.room,
        })
      : undefined;
  const blobTerminalOpts =
    terminalAuth !== undefined
      ? { terminalSigner: terminalAuth.terminalSigner, terminalVerifier: terminalAuth.terminalVerifier }
      : {};

  let blob: KernelBlobSession | undefined;
  if (opts.blobSocketFactory !== undefined) {
    blob = createKernelBlobSession(config.syncUrl, config.room, {
      socketFactory: opts.blobSocketFactory,
      ...blobTerminalOpts,
    });
  } else if (opts.socketFactory === undefined) {
    blob = createKernelBlobSession(config.syncUrl, config.room, { ...blobTerminalOpts });
  }

  const fileIsLive = (): boolean =>
    project.snapshot().files.some((f) => !f.deleted && f.path === config.filePath);

  // Bind a per-grant signer when the control handoff supplied the full scope +
  // the pairing secret (ADR-0023 §1). Any missing piece → no signer → unsigned
  // publishes (the local/un-paired path), which the browser still renders for
  // MANUAL review. The signer is the ONLY thing that makes a proposal
  // auto-acceptable.
  const signer: ProposalSigner | undefined =
    config.grantId !== undefined &&
    config.controlRoom !== undefined &&
    config.projectId !== undefined &&
    config.responseKey !== undefined
      ? buildProposalSigner(
          {
            grantId: config.grantId,
            controlRoom: config.controlRoom,
            syncUrl: config.syncUrl,
            projectId: config.projectId,
            shareRoom: config.room,
          },
          config.responseKey,
        )
      : undefined;

  // The surface owns one agent run's idle-close timer (ADR-0025 §5, Task 3); it
  // hands us a disposer so destroy() clears any in-flight timer (the surface also
  // unrefs it, so this is belt-and-braces — a finished kernel exits cleanly).
  let disposeRunTimer: (() => void) | undefined;
  return {
    surface: createToolSurface(project, config.filePath, MCP_AUTHOR, signer, {
      registerDisposer: (dispose) => {
        disposeRunTimer = dispose;
      },
      // D2: forward the kernel's lowered read caps; absent ⇒ READ_LIMITS defaults.
      ...(config.readLimits !== undefined ? { readLimits: config.readLimits } : {}),
    }),
    // Bind the per-grant token when the control handoff supplied one (ADR-0023
    // §1); exactOptionalPropertyTypes is ON, so only set the field when defined.
    ...(config.grantId !== undefined ? { grantId: config.grantId } : {}),
    // The galley-blob-v1 byte channel (Phase 1), when a blob socket was minted.
    ...(blob !== undefined ? { blob } : {}),

    whenFileReady(timeoutMs = 15_000): Promise<void> {
      if (fileIsLive()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const onUpdate = (): void => {
          if (!fileIsLive()) return;
          cleanup();
          resolve();
        };
        const timer = setTimeout(() => {
          cleanup();
          // The room id is a CAPABILITY (Security round 2, finding 2): this
          // message reaches stderr verbatim via main()'s startup catch, so it
          // carries only the non-reversible fingerprint, never the id.
          reject(
            new Error(
              `timed out waiting for ${config.filePath} in room ${roomFingerprint(config.room)} — ` +
                "check that the project is shared (the browser's Share button), the room id is " +
                "correct, and the file exists",
            ),
          );
        }, timeoutMs);
        const cleanup = (): void => {
          clearTimeout(timer);
          project.doc.off("update", onUpdate);
        };
        project.doc.on("update", onUpdate);
      });
    },

    liveness(): Liveness {
      const humanPeers = humanPeerCount();
      return {
        relayConnected,
        browserAttached: humanPeers > 0,
        humanPeers,
        lastBrowserSeenMs,
      };
    },

    destroy(): void {
      disposeRunTimer?.();
      blob?.destroy();
      connection.awareness.off("update", onAwareness);
      connection.destroy();
      project.destroy();
    },
  };
}
