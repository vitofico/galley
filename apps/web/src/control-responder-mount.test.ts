import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";
import {
  publishControlRequest,
  publishControlResponse,
  withdrawControlRequest,
  getControlResponse,
  readControlRequests,
  CONTROL_LIMITS,
  bytesToBase64Url,
  type DocHost,
  type ControlResponse,
} from "@galley/collab";
import type { Author } from "@galley/shared";
import {
  __resetControlResponderManagerForTests,
  __answeredCacheSizeForTests,
  __responseKeyForTests,
  getControlResponderManager,
  buildPairingCommand,
  loopbackCompileUrl,
  ANSWERED_CACHE_CAP,
  AGENT_ACCESS_SESSION_KEY,
  NO_OPEN_HANDLER_REFUSAL,
  CONTENT_CONSENT_REQUIRED_ERROR,
  TOOL_PROJECT_ID_REQUIRED_ERROR,
  TOOL_FAILED_ERROR,
  type ControlResponderMountDeps,
  type ControlLink,
  type ProjectToolFiles,
} from "./control-responder-mount.js";
import {
  AGENT_CONTENT_GRANTS_KEY,
  grantContentAccess,
  isContentGranted,
  readContentGrants,
  revokeContentAccess,
} from "./agent-content-consent.js";
import { createAgentOpenHandler } from "./agent-open-handler.js";
import type { OpenedProject } from "./control-responder.js";

/**
 * Offline unit tests for the Agent Access RESPONDER MOUNT (#16.3 responder-mount
 * slice, ADR-0021). The manager is the module-scope singleton that the /settings
 * "Agent Access" surface drives; these tests inject FAKES for every side effect
 * (room mint, the control-room join/link, the idb-backed seams) so the suite is
 * fully offline — no relay, no IndexedDB, no DOM (the gate runs in `node`).
 *
 * What they pin (the lane contract):
 *   - DEFAULT-OFF / inert: a fresh manager mints no room, joins nothing, observes
 *     nothing, and reports disabled.
 *   - enable() mints a control room + starts the drain loop.
 *   - list_projects / list_versions are answered via the pure core with the live
 *     fake seams (metadata only).
 *   - open_project gets an explicit ok:false refusal and NEVER mints a share room.
 *   - revoke()/disable() tears everything down; a re-enable mints a FRESH room.
 *   - enable() is idempotent (double-call = one responder, one room).
 *   - cross-reload persistence: enable() PERSISTS the capability; construction
 *     RESUMES a valid persisted session (same room + key, keeps grants); a
 *     malformed blob never resumes; Revoke clears it.
 */

const REQUESTER: Author = { kind: "human", userId: "test-kernel" };
/** A base64url-shaped per-grant token (ADR-0023 §1) the open handoffs carry. */
const A_GRANT = "g0aBcDeF1234_-ZyXwVu";

/**
 * A FAKE control link: an in-process shared Y.Doc that stands in for the joined
 * control room. The "kernel side" host lets the test publish requests and read
 * responses; the manager is handed the SAME doc as its responder host, so a
 * publish is visible to the manager's observer synchronously (single process,
 * no relay).
 */
interface FakeLink {
  link: ControlLink;
  kernelHost: DocHost;
  joinCount: number;
  destroyed: boolean;
}

function makeFakeLinkFactory(): {
  joinControlRoom: ControlResponderMountDeps["joinControlRoom"];
  state: FakeLink;
} {
  const doc = new Y.Doc();
  const kernelHost: DocHost = { doc };
  const state: FakeLink = {
    link: undefined as unknown as ControlLink,
    kernelHost,
    joinCount: 0,
    destroyed: false,
  };
  const joinControlRoom: ControlResponderMountDeps["joinControlRoom"] = () => {
    state.joinCount += 1;
    const link: ControlLink = {
      host: kernelHost, // share the doc so kernel publishes reach the manager
      destroy() {
        state.destroyed = true;
      },
    };
    state.link = link;
    return link;
  };
  return { joinControlRoom, state };
}

let mintedRooms: string[] = [];
let openProjectCalls = 0;
/** Names passed to the create_project seam (F1) — asserted by the create test. */
let createProjectNames: string[] = [];

function baseDeps(over: Partial<ControlResponderMountDeps> = {}): ControlResponderMountDeps {
  const { joinControlRoom } = makeFakeLinkFactory();
  return {
    mintControlRoom: () => {
      const room = `share-test${mintedRooms.length}0000000000000000`;
      mintedRooms.push(room);
      return room;
    },
    resolveSyncUrl: () => "ws://127.0.0.1:1234",
    currentUserId: () => "local-test-user",
    listProjects: async () => [
      { projectId: "proj-1", name: "Alpha", lastModified: 100 },
      { projectId: "proj-2", name: "Beta" },
    ],
    listVersions: async (projectId) =>
      projectId === "proj-1"
        ? [{ id: "v1", name: "Draft", message: "first", createdAt: 5 }]
        : null,
    // create_project (F1) flows through the metadata core like list_projects (no
    // content-consent gate). The fake records the name + returns a fixed id.
    createProject: async (name) => {
      createProjectNames.push(name);
      return { projectId: "proj-created", name };
    },
    // The open seam now flows through (the pre-filter is gone). This baseline
    // fake returns a valid handoff; the open-project describe blocks below
    // override it per-case to assert the registry / refusal / guardrail paths.
    openProjectForControl: async () => {
      openProjectCalls += 1;
      return { room: "share-openproj00000000000000", syncUrl: "ws://127.0.0.1:1234", mainFile: "main.typ", grantId: A_GRANT };
    },
    joinControlRoom,
    // B2 (ADR-0026): a fake pairing-room join + a deterministic code minter so the
    // default deps exercise the code-pairing path (the surfaced --pairing-code).
    joinPairingRoom: () => {
      const link: ControlLink = { host: { doc: new Y.Doc() }, destroy() {} };
      return link;
    },
    mintPairingCode: () => {
      // base64url of exactly 16 bytes (the production invariant deriveBootstrap
      // now enforces): "pairCodeAAAAAAAAAAAAAA" decodes to 16 bytes; vary one char.
      const v = "ABCDEFGHIJ"[mintedCodes.length % 10]!;
      const code = `pairCode${v}AAAAAAAAAAAAA`;
      mintedCodes.push(code);
      return code;
    },
    sessionStore: makeMemoryStore(),
    ...over,
  };
}

let mintedCodes: string[] = [];

/** A minimal in-memory sessionStorage-like store for tests. */
function makeMemoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    _map: m,
  };
}

/** Drain the async answer pipeline. TIMER turns, not bare microtasks: since
 * HIGH-1 every response awaits WebCrypto's `subtle.sign` (importKey + sign),
 * whose completions land via the event loop's timer/poll phases. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  __resetControlResponderManagerForTests();
  mintedRooms = [];
  mintedCodes = [];
  openProjectCalls = 0;
  createProjectNames = [];
});

describe("control-responder-mount — default OFF / inert", () => {
  it("a fresh manager is disabled, mints no room, joins nothing", () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    expect(mgr.isEnabled()).toBe(false);
    expect(mgr.getState().enabled).toBe(false);
    expect(mgr_room(mgr)).toBeNull();
    expect(state.joinCount).toBe(0);
    expect(mintedRooms).toHaveLength(0);
  });

  it("getState() reports no control room / no pairing string when disabled", () => {
    const mgr = getControlResponderManager(baseDeps());
    const s = mgr.getState();
    expect(s.controlRoom).toBeNull();
    expect(s.syncUrl).toBeNull();
    expect(s.pairingCommand).toBeNull();
  });
});

function mgr_room(mgr: ReturnType<typeof getControlResponderManager>): string | null {
  return mgr.getState().controlRoom;
}

describe("control-responder-mount — enable()", () => {
  it("mints a control room, joins it, and exposes a pairing command", () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable();
    expect(mgr.isEnabled()).toBe(true);
    expect(state.joinCount).toBe(1);
    expect(mintedRooms).toHaveLength(1);
    const s = mgr.getState();
    expect(s.controlRoom).toBe(mintedRooms[0]);
    expect(s.syncUrl).toBe("ws://127.0.0.1:1234");
    expect(s.pairingCommand).toContain("galley-mcp");
    expect(s.pairingCommand).toContain("--sync ws://127.0.0.1:1234");
    // B2 (ADR-0026): the command carries the one-time CODE, NEVER the room or key.
    expect(s.pairingCommand).toContain(`--pairing-code ${mintedCodes[0]}`);
    expect(s.pairingCommand).not.toContain("--control-room");
    expect(s.pairingCommand).not.toContain("--response-key");
  });

  it("is idempotent: a second enable() does not mint a second room or re-join", () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable();
    mgr.enable();
    expect(state.joinCount).toBe(1);
    expect(mintedRooms).toHaveLength(1);
  });
});

describe("control-responder-mount — drain loop answers via the core", () => {
  it("answers list_projects with metadata-only rows", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable();
    const id = publishControlRequest(state.kernelHost, { op: "list_projects", params: {} }, REQUESTER);
    await flush();
    const resp = getControlResponse(state.kernelHost, id);
    expect(resp?.ok).toBe(true);
    expect((resp as Extract<ControlResponse, { ok: true }>).result).toEqual([
      { projectId: "proj-1", name: "Alpha", lastModified: 100 },
      { projectId: "proj-2", name: "Beta" },
    ]);
  });

  it("answers list_versions for a known project", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable();
    const id = publishControlRequest(
      state.kernelHost,
      { op: "list_versions", params: { projectId: "proj-1" } },
      REQUESTER,
    );
    await flush();
    const resp = getControlResponse(state.kernelHost, id);
    expect(resp?.ok).toBe(true);
    expect((resp as Extract<ControlResponse, { ok: true }>).result).toEqual([
      { id: "v1", name: "Draft", message: "first", createdAt: 5 },
    ]);
  });

  it("answers create_project through the metadata core WITHOUT a content grant (F1)", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    // No content grant is recorded — create_project must still succeed (it is
    // pairing-gated only, NOT per-project content-consent gated like the read ops).
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable();
    const id = publishControlRequest(
      state.kernelHost,
      { op: "create_project", params: { name: "Fresh Doc" } },
      REQUESTER,
    );
    await flush();
    const resp = getControlResponse(state.kernelHost, id);
    expect(resp?.ok).toBe(true);
    expect((resp as Extract<ControlResponse, { ok: true }>).result).toEqual({
      projectId: "proj-created",
      name: "Fresh Doc",
    });
    // The seam saw the name — proving it flowed through (not refused pre-consent
    // the way the content ops are when no grant is present).
    expect(createProjectNames).toEqual(["Fresh Doc"]);
  });

  it("refuses list_versions for an unknown project (fail-closed)", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable();
    const id = publishControlRequest(
      state.kernelHost,
      { op: "list_versions", params: { projectId: "nope" } },
      REQUESTER,
    );
    await flush();
    const resp = getControlResponse(state.kernelHost, id);
    expect(resp?.ok).toBe(false);
  });
});

describe("control-responder-mount — open_project flows through the open seam (#16.3)", () => {
  it("with NO handler registered AND the no-handler deps fallback, refuses with the static no-handler message", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    // Override the open seam to the production no-handler fallback (the default
    // deps return this when nothing is open). No registry handler is installed.
    const mgr = getControlResponderManager(
      baseDeps({
        joinControlRoom,
        openProjectForControl: async () => ({ refused: NO_OPEN_HANDLER_REFUSAL }),
      }),
    );
    mgr.enable();
    const id = publishControlRequest(
      state.kernelHost,
      { op: "open_project", params: { projectId: "proj-1" } },
      REQUESTER,
    );
    await flush();
    const resp = getControlResponse(state.kernelHost, id);
    expect(resp?.ok).toBe(false);
    expect((resp as Extract<ControlResponse, { ok: false }>).error).toBe(NO_OPEN_HANDLER_REFUSAL);
  });

  it("a REGISTERED handler is delegated to and its handoff is published as ok:true", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable();
    let seen: string | null = null;
    mgr.registerOpenProjectHandler(async (projectId) => {
      seen = projectId;
      return { room: "share-fromhandler0000000000", syncUrl: "ws://127.0.0.1:1234", mainFile: "main.typ", grantId: A_GRANT };
    });
    const id = publishControlRequest(
      state.kernelHost,
      { op: "open_project", params: { projectId: "proj-1" } },
      REQUESTER,
    );
    await flush();
    const resp = getControlResponse(state.kernelHost, id);
    expect(resp?.ok).toBe(true);
    expect(seen).toBe("proj-1");
    expect((resp as Extract<ControlResponse, { ok: true }>).result).toEqual({
      syncUrl: "ws://127.0.0.1:1234",
      room: "share-fromhandler0000000000",
      projectId: "proj-1",
      mainFile: "main.typ",
      grantId: A_GRANT,
    });
    // The registered handler ran INSTEAD of the deps fallback (seam untouched).
    expect(openProjectCalls).toBe(0);
  });

  it("the seam reads the CURRENT handler at CALL time (a re-register after enable() wins)", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable(); // enable() runs BEFORE any handler is registered
    // Register only AFTER enable — proving the seam did not capture a handler at
    // enable() time but reads the live slot when the request arrives.
    mgr.registerOpenProjectHandler(async () => ({ refused: "first handler" }));
    mgr.registerOpenProjectHandler(async () => ({ refused: "second handler wins" }));
    const id = publishControlRequest(
      state.kernelHost,
      { op: "open_project", params: { projectId: "proj-1" } },
      REQUESTER,
    );
    await flush();
    const resp = getControlResponse(state.kernelHost, id);
    expect((resp as Extract<ControlResponse, { ok: false }>).error).toBe("second handler wins");
  });

  it("a STALE unregister (token mismatch) does NOT clobber a newer handler", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable();
    const unregisterStale = mgr.registerOpenProjectHandler(async () => ({ refused: "stale handler" }));
    // A newer mount registers, superseding the first registration's token.
    mgr.registerOpenProjectHandler(async () => ({ refused: "live handler" }));
    // The stale unmount fires AFTER the newer register — it must be a no-op.
    unregisterStale();
    const id = publishControlRequest(
      state.kernelHost,
      { op: "open_project", params: { projectId: "proj-1" } },
      REQUESTER,
    );
    await flush();
    const resp = getControlResponse(state.kernelHost, id);
    // Still the live handler — the stale unregister did not clear the slot.
    expect((resp as Extract<ControlResponse, { ok: false }>).error).toBe("live handler");
  });

  it("the matching unregister DOES clear the slot (falls back to the no-handler refusal)", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(
      baseDeps({
        joinControlRoom,
        openProjectForControl: async () => ({ refused: NO_OPEN_HANDLER_REFUSAL }),
      }),
    );
    mgr.enable();
    const unregister = mgr.registerOpenProjectHandler(async () => ({ refused: "live handler" }));
    unregister(); // the live registration retracts itself
    const id = publishControlRequest(
      state.kernelHost,
      { op: "open_project", params: { projectId: "proj-1" } },
      REQUESTER,
    );
    await flush();
    const resp = getControlResponse(state.kernelHost, id);
    expect((resp as Extract<ControlResponse, { ok: false }>).error).toBe(NO_OPEN_HANDLER_REFUSAL);
  });
});

describe("control-responder-mount — ADR-0024 §3 idempotent open_project reuse end-to-end", () => {
  /** A handler built from the REAL gate core, with injectable consent + reuse seams. */
  function reuseHandler(over: {
    tryReuseGrant?: (id: string, isRequestLive: () => boolean) => Promise<OpenedProject | null>;
    onConsent?: () => void;
  }) {
    const handoff: OpenedProject = {
      room: "share-fresh00000000000000000",
      syncUrl: "ws://127.0.0.1:1234",
      mainFile: "main.typ",
      grantId: A_GRANT,
    };
    return createAgentOpenHandler({
      projectId: "proj-1",
      joinedSession: false,
      isConsentPending: () => false,
      setConsentPending: () => {},
      requestConsent: async () => {
        over.onConsent?.();
        return "approve";
      },
      getEnsureShared: () => async () => handoff,
      ...(over.tryReuseGrant !== undefined ? { tryReuseGrant: over.tryReuseGrant } : {}),
    });
  }

  it("a reuse HIT answers ok:true with the reused binding and NEVER prompts consent", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable();
    const reused: OpenedProject = {
      room: "share-reuse00000000000000000",
      syncUrl: "ws://127.0.0.1:1234",
      mainFile: "main.typ",
      grantId: A_GRANT,
    };
    let consentPrompts = 0;
    mgr.registerOpenProjectHandler(
      reuseHandler({ tryReuseGrant: async () => reused, onConsent: () => (consentPrompts += 1) }),
    );
    const id = publishControlRequest(
      state.kernelHost,
      { op: "open_project", params: { projectId: "proj-1" } },
      REQUESTER,
    );
    await flush();
    const resp = getControlResponse(state.kernelHost, id);
    expect(resp?.ok).toBe(true);
    expect((resp as Extract<ControlResponse, { ok: true }>).result).toEqual({
      syncUrl: "ws://127.0.0.1:1234",
      room: "share-reuse00000000000000000",
      projectId: "proj-1",
      mainFile: "main.typ",
      grantId: A_GRANT,
    });
    // The whole point: the human was never asked again.
    expect(consentPrompts).toBe(0);
  });

  it("a reuse MISS (null) falls through to consent and publishes the FRESH share", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable();
    let consentPrompts = 0;
    mgr.registerOpenProjectHandler(
      reuseHandler({ tryReuseGrant: async () => null, onConsent: () => (consentPrompts += 1) }),
    );
    const id = publishControlRequest(
      state.kernelHost,
      { op: "open_project", params: { projectId: "proj-1" } },
      REQUESTER,
    );
    await flush();
    const resp = getControlResponse(state.kernelHost, id);
    expect(resp?.ok).toBe(true);
    expect((resp as Extract<ControlResponse, { ok: true }>).result).toEqual({
      syncUrl: "ws://127.0.0.1:1234",
      room: "share-fresh00000000000000000",
      projectId: "proj-1",
      mainFile: "main.typ",
      grantId: A_GRANT,
    });
    // The miss fell through to the full consent gate — the human WAS prompted.
    expect(consentPrompts).toBe(1);
  });

  it("a request for a DIFFERENT project never reuses — it is refused by the scope gate", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable();
    let reuseConsulted = 0;
    mgr.registerOpenProjectHandler(
      reuseHandler({
        tryReuseGrant: async () => {
          reuseConsulted += 1;
          return {
            room: "share-reuse00000000000000000",
            syncUrl: "ws://127.0.0.1:1234",
            mainFile: "main.typ",
            grantId: A_GRANT,
          };
        },
      }),
    );
    const id = publishControlRequest(
      state.kernelHost,
      { op: "open_project", params: { projectId: "a-different-project" } },
      REQUESTER,
    );
    await flush();
    const resp = getControlResponse(state.kernelHost, id);
    expect(resp?.ok).toBe(false);
    // The scope gate refused BEFORE reuse could fire (a foreign project never reuses).
    expect(reuseConsulted).toBe(0);
  });

  it("a request WITHDRAWN during the reuse await does NOT reconnect (SEC-16.3a, HIGH fix)", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable();
    // The seam mimics ProjectApp: it awaits readiness, then re-checks liveness
    // immediately before its reconnect side effect — a withdrawn request must skip
    // the reconnect and fall through (null).
    let reconnected = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const reused: OpenedProject = {
      room: "share-reuse00000000000000000",
      syncUrl: "ws://127.0.0.1:1234",
      mainFile: "main.typ",
      grantId: A_GRANT,
    };
    let consentPrompts = 0;
    mgr.registerOpenProjectHandler(
      reuseHandler({
        onConsent: () => (consentPrompts += 1),
        tryReuseGrant: async (_id, isRequestLive) => {
          await gate; // stand in for `await session.whenReady`
          if (!isRequestLive()) return null; // withdrawn mid-await → no reconnect
          reconnected = true; // the capability-reopening side effect
          return reused;
        },
      }),
    );
    const id = publishControlRequest(
      state.kernelHost,
      { op: "open_project", params: { projectId: "proj-1" } },
      REQUESTER,
    );
    await flush(); // the drain starts, the seam awaits the gate
    // The kernel withdraws the request while the seam is mid-await.
    withdrawControlRequest(state.kernelHost, id, REQUESTER);
    release();
    await flush();
    // The reconnect side effect never ran, and consent fell through to its OWN
    // withdrawn guard (also dead) — so nothing reopened the share room.
    expect(reconnected).toBe(false);
    expect(consentPrompts).toBe(0);
    // No ok:true leaked for the withdrawn request.
    const resp = getControlResponse(state.kernelHost, id);
    expect(resp === undefined || resp.ok === false).toBe(true);
  });
});

describe("control-responder-mount — GUARDRAIL #5: a withdrawn open_project does not leak its share (#16.3)", () => {
  it("if the request is WITHDRAWN during a slow consent, the ok:true share is NOT published", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable();

    // A slow handler: it resolves to a valid handoff only AFTER the test releases
    // it — simulating a human taking long enough that the kernel times out and
    // withdraws the request before consent settles.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mgr.registerOpenProjectHandler(async () => {
      await gate;
      return { room: "share-slowconsent0000000000", syncUrl: "ws://127.0.0.1:1234", mainFile: "main.typ", grantId: A_GRANT };
    });

    const id = publishControlRequest(
      state.kernelHost,
      { op: "open_project", params: { projectId: "proj-1" } },
      REQUESTER,
    );
    await flush(); // the drain starts, awaits the gated handler

    // The kernel withdraws the request on its own timeout while consent is pending.
    withdrawControlRequest(state.kernelHost, id, REQUESTER);
    expect(readControlRequests(state.kernelHost).some((r) => r.id === id)).toBe(false);

    // Now the human "approves" (handler resolves) — but the request is gone.
    release();
    await flush();

    // Guardrail #5: the freshly minted share room was NOT published into an
    // orphan response — no capability leak.
    expect(getControlResponse(state.kernelHost, id)).toBeUndefined();
  });

  it("a still-LIVE open_project success IS published (the guardrail only skips withdrawn requests)", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable();
    mgr.registerOpenProjectHandler(async () => ({
      room: "share-stilllive00000000000000",
      syncUrl: "ws://127.0.0.1:1234",
      mainFile: "main.typ",
      grantId: A_GRANT,
    }));
    const id = publishControlRequest(
      state.kernelHost,
      { op: "open_project", params: { projectId: "proj-1" } },
      REQUESTER,
    );
    await flush();
    const resp = getControlResponse(state.kernelHost, id);
    expect(resp?.ok).toBe(true);
  });
});

describe("control-responder-mount — SEC-16.3a: the request-scoped liveness probe reaches the handler", () => {
  it("the probe is TRUE while the request is live and flips FALSE after a withdrawal", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable();

    let probe: (() => boolean) | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const probedLive: boolean[] = [];
    mgr.registerOpenProjectHandler(async (_projectId, isRequestLive) => {
      probe = isRequestLive;
      probedLive.push(isRequestLive()); // while the request is still live
      await gate; // the human deliberates…
      probedLive.push(isRequestLive()); // …after the kernel withdrew
      return { refused: "withdrawn — refusing without minting" };
    });

    const id = publishControlRequest(
      state.kernelHost,
      { op: "open_project", params: { projectId: "proj-1" } },
      REQUESTER,
    );
    await flush(); // the drain starts; the handler sampled the live probe
    withdrawControlRequest(state.kernelHost, id, REQUESTER);
    release();
    await flush();

    expect(probe).toBeDefined();
    expect(probedLive).toEqual([true, false]);
  });

  it("a consent-style handler that honors the probe mints NO room for a withdrawn request", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable();

    let roomsMinted = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Mirrors the ProjectApp handler's SEC-16.3a re-check: approve arrives only
    // after the await; the share-upgrade (the mint) runs ONLY if still live.
    mgr.registerOpenProjectHandler(async (_projectId, isRequestLive) => {
      await gate; // consent pending
      if (!isRequestLive()) return { refused: "the agent withdrew this request" };
      roomsMinted += 1;
      return { room: "share-shouldnotmint0000000000", syncUrl: "ws://127.0.0.1:1234", mainFile: "main.typ", grantId: A_GRANT };
    });

    const id = publishControlRequest(
      state.kernelHost,
      { op: "open_project", params: { projectId: "proj-1" } },
      REQUESTER,
    );
    await flush();
    withdrawControlRequest(state.kernelHost, id, REQUESTER);
    release();
    await flush();

    // The share was never created — not merely unpublished (guardrail #5), but
    // never minted at all.
    expect(roomsMinted).toBe(0);
  });

  it("the probe also reports dead after a disable() (no share on a torn-down link)", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable();

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let liveAfterDisable: boolean | undefined;
    mgr.registerOpenProjectHandler(async (_projectId, isRequestLive) => {
      await gate;
      liveAfterDisable = isRequestLive();
      return { refused: "torn down" };
    });

    publishControlRequest(
      state.kernelHost,
      { op: "open_project", params: { projectId: "proj-1" } },
      REQUESTER,
    );
    await flush();
    mgr.disable(); // the user revokes Agent Access while consent is pending
    release();
    await flush();

    expect(liveAfterDisable).toBe(false);
  });
});

describe("control-responder-mount — revoke / re-enable", () => {
  it("disable() tears down the link and reports disabled", () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable();
    mgr.disable();
    expect(mgr.isEnabled()).toBe(false);
    expect(state.destroyed).toBe(true);
    expect(mgr.getState().controlRoom).toBeNull();
  });

  it("a re-enable after disable mints a FRESH control room", () => {
    const mgr = getControlResponderManager(baseDeps());
    mgr.enable();
    const first = mgr.getState().controlRoom;
    mgr.disable();
    mgr.enable();
    const second = mgr.getState().controlRoom;
    expect(first).not.toBe(second);
    expect(mintedRooms).toHaveLength(2);
  });

  it("after disable, a request that would arrive on a stale doc is not answered", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable();
    mgr.disable();
    const id = publishControlRequest(state.kernelHost, { op: "list_projects", params: {} }, REQUESTER);
    await flush();
    expect(getControlResponse(state.kernelHost, id)).toBeUndefined();
    // sanity: the request is sitting unanswered in the (now-detached) doc
    expect(readControlRequests(state.kernelHost).some((r) => r.id === id)).toBe(true);
  });
});

describe("control-responder-mount — H1: the answered cache is bounded (DoS lever)", () => {
  it("repeated request→answer→withdraw cycles do NOT grow retained ids without bound", { timeout: 30_000 }, async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable();

    // Drive more cycles than the cap: each cycle is a fresh CSPRNG id (as a
    // real kernel mints), answered, then withdrawn (so the mailbox prunes it).
    // cap + a full read-window proves the FIFO bound; staying near the cap
    // keeps the test fast now that every answer awaits a real HMAC sign.
    const cycles = ANSWERED_CACHE_CAP + CONTROL_LIMITS.maxReadRequests;
    for (let i = 0; i < cycles; i++) {
      const id = publishControlRequest(
        state.kernelHost,
        { op: "list_projects", params: {} },
        REQUESTER,
      );
      await flush();
      expect(getControlResponse(state.kernelHost, id)?.ok).toBe(true);
      withdrawControlRequest(state.kernelHost, id, REQUESTER);
    }

    // The side cache stayed bounded even though the mailbox saw cycles≫cap ids.
    expect(__answeredCacheSizeForTests(mgr)).toBeLessThanOrEqual(ANSWERED_CACHE_CAP);
  });

  it("still answers a single pending request exactly once (eviction is harmless)", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable();

    const id = publishControlRequest(
      state.kernelHost,
      { op: "list_projects", params: {} },
      REQUESTER,
    );
    await flush();
    const first = getControlResponse(state.kernelHost, id) as Extract<ControlResponse, { ok: true }>;
    const firstRespondedAt = first.respondedAt;
    expect(first.ok).toBe(true);

    // A second observer wake over the SAME still-pending+answered request must
    // not produce a second answer (answer-once survives even if the cache evicted
    // the id): readControlRequests excludes already-answered ids, and
    // publishControlResponse is answer-once. The response is unchanged.
    for (let i = 0; i < 3; i++) {
      // Re-publishing a brand-new request keeps the observer busy / evicts old ids
      // without disturbing the first id's settled answer.
      const filler = publishControlRequest(
        state.kernelHost,
        { op: "list_projects", params: {} },
        REQUESTER,
      );
      await flush();
      withdrawControlRequest(state.kernelHost, filler, REQUESTER);
    }
    const again = getControlResponse(state.kernelHost, id) as Extract<ControlResponse, { ok: true }>;
    expect(again.respondedAt).toBe(firstRespondedAt); // never re-answered
  });
});

describe("control-responder-mount — H2: a bad response never wedges the pass", () => {
  it("an over-limit success result is published as ok:false; prune still runs and later requests answer", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    // A project whose name alone exceeds maxResponseBytes → publishControlResponse
    // would THROW on the raw success result. The loop must catch it, answer
    // ok:false instead, and keep going (prune + subsequent requests).
    const huge = "x".repeat(CONTROL_LIMITS.maxResponseBytes + 10);
    const mgr = getControlResponderManager(
      baseDeps({
        joinControlRoom,
        listProjects: async () => [{ projectId: "p", name: huge }],
      }),
    );
    mgr.enable();

    const bad = publishControlRequest(state.kernelHost, { op: "list_projects", params: {} }, REQUESTER);
    await flush();
    const badResp = getControlResponse(state.kernelHost, bad);
    // The pass did NOT silently drop it: it got a small fail response.
    expect(badResp?.ok).toBe(false);

    // The loop is not wedged: a following well-formed request still answers.
    const ok = publishControlRequest(
      state.kernelHost,
      { op: "list_versions", params: { projectId: "proj-1" } },
      REQUESTER,
    );
    // list_versions seam in baseDeps was overridden away above (listProjects only),
    // so it falls back to the baseDeps default for list_versions.
    await flush();
    expect(getControlResponse(state.kernelHost, ok)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// #1 slice 1 — read-only tool ops behind the per-project CONTENT-CONSENT gate.
// ---------------------------------------------------------------------------

const PROJECT_FILES: ProjectToolFiles = {
  files: [
    { path: "/main.typ", text: "= Title\nHello galley world\n" },
    { path: "/notes.typ", text: "alpha beta gamma" },
  ],
  mainPath: "/main.typ",
};

/** Every file text in the fake project — for "zero file text leaked" asserts. */
const ALL_FILE_TEXTS = PROJECT_FILES.files.map((f) => f.text);

interface ToolHarness {
  mgr: ReturnType<typeof getControlResponderManager>;
  state: FakeLink;
  store: ReturnType<typeof makeMemoryStore>;
  resolverCalls: string[];
}

/** The fake version tree the version-file ops resolve for proj-1 @ v1 (B4). */
const VERSION_TREE: { path: string; text: string }[] = [
  { path: "/main.typ", text: "= Title\nVersioned body here\n" },
  { path: "/old.typ", text: "older content" },
];

/** A manager wired with a known fake project + an inspectable consent store. */
function makeToolHarness(over: Partial<ControlResponderMountDeps> = {}): ToolHarness {
  const { joinControlRoom, state } = makeFakeLinkFactory();
  const store = makeMemoryStore();
  const resolverCalls: string[] = [];
  const mgr = getControlResponderManager(
    baseDeps({
      joinControlRoom,
      sessionStore: store,
      projectFilesForTools: async (projectId) => {
        resolverCalls.push(projectId);
        return projectId === "proj-1" ? PROJECT_FILES : null;
      },
      projectVersionTree: async (projectId, versionId) =>
        projectId === "proj-1" && versionId === "v1" ? VERSION_TREE : null,
      ...over,
    }),
  );
  mgr.enable();
  return { mgr, state, store, resolverCalls };
}

async function publishAndAwait(
  state: FakeLink,
  op: string,
  params: Record<string, unknown>,
): Promise<ControlResponse | undefined> {
  const id = publishControlRequest(state.kernelHost, { op, params }, REQUESTER);
  await flush();
  return getControlResponse(state.kernelHost, id);
}

describe("control-responder-mount — tool ops are HARD-GATED on per-project content consent", () => {
  it("without a grant, read_file gets the STATIC consent-required refusal and leaks no file text", async () => {
    const h = makeToolHarness();
    const resp = await publishAndAwait(h.state, "read_file", {
      projectId: "proj-1",
      path: "/main.typ",
    });
    expect(resp?.ok).toBe(false);
    const error = (resp as Extract<ControlResponse, { ok: false }>).error;
    expect(error).toBe(CONTENT_CONSENT_REQUIRED_ERROR);
    for (const text of ALL_FILE_TEXTS) expect(JSON.stringify(resp)).not.toContain(text.slice(0, 8));
  });

  it("pre-consent, the resolver is NEVER called — no IO, no membership probe", async () => {
    const h = makeToolHarness();
    await publishAndAwait(h.state, "read_file", { projectId: "proj-1", path: "/main.typ" });
    await publishAndAwait(h.state, "search_project", { projectId: "proj-1", query: "Hello" });
    expect(h.resolverCalls).toEqual([]);
  });

  it("pre-consent, an EXISTING and a NON-EXISTENT projectId are indistinguishable (no oracle)", async () => {
    const h = makeToolHarness();
    const real = await publishAndAwait(h.state, "read_file", {
      projectId: "proj-1",
      path: "/main.typ",
    });
    const fake = await publishAndAwait(h.state, "read_file", {
      projectId: "proj-no-such-thing",
      path: "/main.typ",
    });
    expect(real?.ok).toBe(false);
    expect(fake?.ok).toBe(false);
    expect((real as Extract<ControlResponse, { ok: false }>).error).toBe(
      (fake as Extract<ControlResponse, { ok: false }>).error,
    );
  });

  it("a tool op WITHOUT a projectId is refused with the static param error", async () => {
    const h = makeToolHarness();
    const resp = await publishAndAwait(h.state, "read_file", { path: "/main.typ" });
    expect(resp?.ok).toBe(false);
    expect((resp as Extract<ControlResponse, { ok: false }>).error).toBe(
      TOOL_PROJECT_ID_REQUIRED_ERROR,
    );
  });
});

describe("control-responder-mount — granted tool ops answer via the registry adapter", () => {
  it("read_file returns the granted project's file, line-numbered", async () => {
    const h = makeToolHarness();
    grantContentAccess(h.store, "proj-1");
    const resp = await publishAndAwait(h.state, "read_file", {
      projectId: "proj-1",
      path: "/notes.typ",
    });
    expect(resp?.ok).toBe(true);
    const result = (resp as Extract<ControlResponse, { ok: true }>).result as {
      text: string;
      summary: string;
    };
    expect(result.text).toContain("alpha beta gamma");
    expect(h.resolverCalls).toEqual(["proj-1"]);
  });

  it("search_project finds matches across the granted project", async () => {
    const h = makeToolHarness();
    grantContentAccess(h.store, "proj-1");
    const resp = await publishAndAwait(h.state, "search_project", {
      projectId: "proj-1",
      query: "Hello",
    });
    expect(resp?.ok).toBe(true);
    const result = (resp as Extract<ControlResponse, { ok: true }>).result as { text: string };
    expect(result.text).toContain("/main.typ:2:");
    expect(result.text).toContain("Hello galley world");
  });

  it("list_files lists the visible paths", async () => {
    const h = makeToolHarness();
    grantContentAccess(h.store, "proj-1");
    const resp = await publishAndAwait(h.state, "list_files", { projectId: "proj-1" });
    expect(resp?.ok).toBe(true);
    const result = (resp as Extract<ControlResponse, { ok: true }>).result as { text: string };
    expect(result.text).toContain("/main.typ");
    expect(result.text).toContain("/notes.typ");
  });

  it("read_document maps to the project's MAIN file", async () => {
    const h = makeToolHarness();
    grantContentAccess(h.store, "proj-1");
    const resp = await publishAndAwait(h.state, "read_document", { projectId: "proj-1" });
    expect(resp?.ok).toBe(true);
    const result = (resp as Extract<ControlResponse, { ok: true }>).result as { text: string };
    expect(result.text).toContain("= Title");
  });

  it("compile with NO registered handler fails closed with the no-open-handler refusal (F9)", async () => {
    // F9/F5: `compile` no longer routes through the registry adapter (whose
    // control-surface compiler stub throws) — it is intercepted by the dedicated
    // compile handler BEFORE the toolOps branch. With a grant but no registered
    // ProjectApp handler, the seam returns the static no-open-handler refusal.
    const h = makeToolHarness();
    grantContentAccess(h.store, "proj-1");
    const resp = await publishAndAwait(h.state, "compile", { projectId: "proj-1" });
    expect(resp?.ok).toBe(false);
    expect((resp as Extract<ControlResponse, { ok: false }>).error).toBe(NO_OPEN_HANDLER_REFUSAL);
  });

  it("seams are resolved PER REQUEST (the resolver runs once per granted request)", async () => {
    const h = makeToolHarness();
    grantContentAccess(h.store, "proj-1");
    await publishAndAwait(h.state, "list_files", { projectId: "proj-1" });
    await publishAndAwait(h.state, "list_files", { projectId: "proj-1" });
    expect(h.resolverCalls).toEqual(["proj-1", "proj-1"]);
  });

  it("a granted-but-unresolvable project (resolver null) is refused generically", async () => {
    const h = makeToolHarness();
    grantContentAccess(h.store, "proj-ghost");
    const resp = await publishAndAwait(h.state, "read_file", {
      projectId: "proj-ghost",
      path: "/main.typ",
    });
    expect(resp?.ok).toBe(false);
    expect((resp as Extract<ControlResponse, { ok: false }>).error).toBe(TOOL_FAILED_ERROR);
  });

  it("a THROWING resolver is refused generically (fail-closed, loop not wedged)", async () => {
    const h = makeToolHarness({
      projectFilesForTools: async () => {
        throw new Error("idb exploded with /secret/path internals");
      },
    });
    grantContentAccess(h.store, "proj-1");
    const resp = await publishAndAwait(h.state, "read_file", {
      projectId: "proj-1",
      path: "/main.typ",
    });
    expect(resp?.ok).toBe(false);
    const error = (resp as Extract<ControlResponse, { ok: false }>).error;
    expect(error).toBe(TOOL_FAILED_ERROR);
    expect(error).not.toContain("secret"); // internals never surface
    // The loop still answers the next request.
    const next = await publishAndAwait(h.state, "list_projects", {});
    expect(next?.ok).toBe(true);
  });
});

describe("control-responder-mount — compile is CONTENT-CONSENT gated, browser-routed (F9/F5)", () => {
  it("without a grant, compile gets the STATIC consent refusal and the handler is NOT invoked", async () => {
    const h = makeToolHarness();
    let handlerCalls = 0;
    h.mgr.registerCompileHandler(async () => {
      handlerCalls += 1;
      return { ok: true, pageCount: 1, diagnostics: [] };
    });
    const resp = await publishAndAwait(h.state, "compile", { projectId: "proj-1" });
    expect(resp?.ok).toBe(false);
    expect((resp as Extract<ControlResponse, { ok: false }>).error).toBe(CONTENT_CONSENT_REQUIRED_ERROR);
    // The gate fired BEFORE any handler call.
    expect(handlerCalls).toBe(0);
  });

  it("granted + a registered handler relays the live diagnostics via the signed response", async () => {
    const h = makeToolHarness();
    grantContentAccess(h.store, "proj-1");
    h.mgr.registerCompileHandler(async (projectId) =>
      projectId === "proj-1"
        ? {
            ok: false,
            pageCount: 4,
            diagnostics: [{ severity: "error", message: "unknown variable: x", path: "/main.typ" }],
          }
        : null,
    );
    const resp = await publishAndAwait(h.state, "compile", { projectId: "proj-1" });
    expect(resp?.ok).toBe(true);
    const result = (resp as Extract<ControlResponse, { ok: true }>).result as {
      ok: boolean;
      pageCount: number | null;
      diagnostics: { severity: string; message: string; path?: string }[];
    };
    expect(result.ok).toBe(false);
    expect(result.pageCount).toBe(4);
    expect(result.diagnostics).toEqual([
      { severity: "error", message: "unknown variable: x", path: "/main.typ" },
    ]);
  });

  it("granted but NO registered handler → the no-open-handler refusal", async () => {
    const h = makeToolHarness();
    grantContentAccess(h.store, "proj-1");
    const resp = await publishAndAwait(h.state, "compile", { projectId: "proj-1" });
    expect(resp?.ok).toBe(false);
    expect((resp as Extract<ControlResponse, { ok: false }>).error).toBe(NO_OPEN_HANDLER_REFUSAL);
  });

  it("token-guarded unregister: a STALE unregister does not clear the live handler", async () => {
    const h = makeToolHarness();
    grantContentAccess(h.store, "proj-1");
    const unregisterStale = h.mgr.registerCompileHandler(async () => ({
      ok: true,
      pageCount: 1,
      diagnostics: [{ severity: "warning", message: "stale" }],
    }));
    // A NEWER registration supersedes the first.
    h.mgr.registerCompileHandler(async () => ({
      ok: true,
      pageCount: 2,
      diagnostics: [{ severity: "warning", message: "live" }],
    }));
    // The stale unregister must be a no-op (its token was superseded).
    unregisterStale();
    const resp = await publishAndAwait(h.state, "compile", { projectId: "proj-1" });
    expect(resp?.ok).toBe(true);
    const result = (resp as Extract<ControlResponse, { ok: true }>).result as {
      pageCount: number | null;
      diagnostics: { message: string }[];
    };
    expect(result.pageCount).toBe(2);
    expect(result.diagnostics[0]!.message).toBe("live");
  });

  it("compile is dispatched through the dedicated handler, NOT the registry adapter", async () => {
    // The registry adapter's control-surface compiler stub throws (→ TOOL_FAILED_ERROR).
    // A registered handler returning real diagnostics proves compile no longer routes
    // there — it reaches the dedicated answerCompileRequest path instead.
    const h = makeToolHarness();
    grantContentAccess(h.store, "proj-1");
    h.mgr.registerCompileHandler(async () => ({ ok: true, pageCount: 7, diagnostics: [] }));
    const resp = await publishAndAwait(h.state, "compile", { projectId: "proj-1" });
    expect(resp?.ok).toBe(true);
    const result = (resp as Extract<ControlResponse, { ok: true }>).result as { pageCount: number | null };
    expect(result.pageCount).toBe(7);
    // The registry adapter resolver was never consulted for compile.
    expect(h.resolverCalls).toEqual([]);
  });
});

describe("control-responder-mount — version file reads are CONTENT-CONSENT gated (B4)", () => {
  it("without a grant, list_version_files / read_version_file get the STATIC consent refusal, no version text", async () => {
    const h = makeToolHarness();
    const list = await publishAndAwait(h.state, "list_version_files", {
      projectId: "proj-1",
      versionId: "v1",
    });
    const read = await publishAndAwait(h.state, "read_version_file", {
      projectId: "proj-1",
      versionId: "v1",
      path: "/main.typ",
    });
    for (const resp of [list, read]) {
      expect(resp?.ok).toBe(false);
      expect((resp as Extract<ControlResponse, { ok: false }>).error).toBe(
        CONTENT_CONSENT_REQUIRED_ERROR,
      );
    }
    for (const f of VERSION_TREE) {
      expect(JSON.stringify(list)).not.toContain(f.text.slice(0, 8));
      expect(JSON.stringify(read)).not.toContain(f.text.slice(0, 8));
    }
  });

  it("pre-consent, an existing and a made-up project are indistinguishable (no oracle)", async () => {
    const h = makeToolHarness();
    const real = await publishAndAwait(h.state, "list_version_files", {
      projectId: "proj-1",
      versionId: "v1",
    });
    const fake = await publishAndAwait(h.state, "list_version_files", {
      projectId: "proj-nope",
      versionId: "v1",
    });
    expect((real as Extract<ControlResponse, { ok: false }>).error).toBe(
      (fake as Extract<ControlResponse, { ok: false }>).error,
    );
  });

  it("granted: list_version_files returns {path,size} only — never the text", async () => {
    const h = makeToolHarness();
    grantContentAccess(h.store, "proj-1");
    const resp = await publishAndAwait(h.state, "list_version_files", {
      projectId: "proj-1",
      versionId: "v1",
    });
    expect(resp?.ok).toBe(true);
    const result = (resp as Extract<ControlResponse, { ok: true }>).result as {
      files: { path: string; size: number }[];
      truncated: boolean;
    };
    expect(result.files).toEqual([
      { path: "/main.typ", size: VERSION_TREE[0]!.text.length },
      { path: "/old.typ", size: VERSION_TREE[1]!.text.length },
    ]);
    for (const f of VERSION_TREE) expect(JSON.stringify(resp)).not.toContain(f.text.slice(0, 8));
  });

  it("granted: read_version_file returns one file's text at that version", async () => {
    const h = makeToolHarness();
    grantContentAccess(h.store, "proj-1");
    const resp = await publishAndAwait(h.state, "read_version_file", {
      projectId: "proj-1",
      versionId: "v1",
      path: "/old.typ",
    });
    expect(resp?.ok).toBe(true);
    expect((resp as Extract<ControlResponse, { ok: true }>).result).toEqual({
      text: "older content",
    });
  });

  it("granted but unknown version → generic refusal (no oracle on version ids)", async () => {
    const h = makeToolHarness();
    grantContentAccess(h.store, "proj-1");
    const resp = await publishAndAwait(h.state, "read_version_file", {
      projectId: "proj-1",
      versionId: "v-nope",
      path: "/main.typ",
    });
    expect(resp?.ok).toBe(false);
  });

  it("a version op WITHOUT a projectId is refused with the static param error", async () => {
    const h = makeToolHarness();
    const resp = await publishAndAwait(h.state, "list_version_files", { versionId: "v1" });
    expect(resp?.ok).toBe(false);
    expect((resp as Extract<ControlResponse, { ok: false }>).error).toBe(
      TOOL_PROJECT_ID_REQUIRED_ERROR,
    );
  });

  it("a THROWING version-tree resolver is refused generically (loop not wedged)", async () => {
    const h = makeToolHarness({
      projectVersionTree: async () => {
        throw new Error("idb exploded with /secret internals");
      },
    });
    grantContentAccess(h.store, "proj-1");
    const resp = await publishAndAwait(h.state, "read_version_file", {
      projectId: "proj-1",
      versionId: "v1",
      path: "/main.typ",
    });
    expect(resp?.ok).toBe(false);
    expect((resp as Extract<ControlResponse, { ok: false }>).error).not.toContain("secret");
    const next = await publishAndAwait(h.state, "list_projects", {});
    expect(next?.ok).toBe(true);
  });
});

describe("control-responder-mount — mutating ops and grant minting are impossible from the wire", () => {
  it("propose_edit is refused even for a granted project (no write path, full stop)", async () => {
    const h = makeToolHarness();
    grantContentAccess(h.store, "proj-1");
    const resp = await publishAndAwait(h.state, "propose_edit", {
      projectId: "proj-1",
      edits: [{ search: "Hello", replace: "Goodbye" }],
    });
    expect(resp?.ok).toBe(false);
    // propose_edit is NOT a tool op here (only readonly entries route), so it
    // falls through to the metadata core's unknown-op refusal.
    expect((resp as Extract<ControlResponse, { ok: false }>).error).toMatch(/unsupported op/);
  });

  it("NO request shape can mint a grant — grants are browser-UI-only", async () => {
    const h = makeToolHarness();
    expect(readContentGrants(h.store)).toEqual([]);
    // A made-up grant op, a tool op with grant-shaped params, and a metadata op
    // with grant-shaped params: all leave the grant set EMPTY.
    await publishAndAwait(h.state, "grant_content_access", { projectId: "proj-1" });
    await publishAndAwait(h.state, "read_file", {
      projectId: "proj-1",
      path: "/main.typ",
      grant: true,
      consent: "granted",
    });
    await publishAndAwait(h.state, "list_versions", { projectId: "proj-1", grant: true });
    expect(readContentGrants(h.store)).toEqual([]);
    expect(isContentGranted(h.store, "proj-1")).toBe(false);
  });

  it("consent state never rides into the mailbox doc", async () => {
    const h = makeToolHarness();
    grantContentAccess(h.store, "proj-1");
    const resp = await publishAndAwait(h.state, "read_file", {
      projectId: "proj-1",
      path: "/notes.typ",
    });
    expect(resp?.ok).toBe(true);
    const requestsJson = JSON.stringify(h.state.kernelHost.doc.getMap("mcpControlRequests").toJSON());
    const responsesJson = JSON.stringify(h.state.kernelHost.doc.getMap("mcpControlResponses").toJSON());
    for (const blob of [requestsJson, responsesJson]) {
      expect(blob).not.toContain(AGENT_CONTENT_GRANTS_KEY);
      expect(blob).not.toContain("contentGrants");
    }
  });
});

describe("control-responder-mount — revocation (#1 slice 1)", () => {
  it("a per-project revoke bites on the very NEXT request", async () => {
    const h = makeToolHarness();
    grantContentAccess(h.store, "proj-1");
    const granted = await publishAndAwait(h.state, "read_file", {
      projectId: "proj-1",
      path: "/notes.typ",
    });
    expect(granted?.ok).toBe(true);
    revokeContentAccess(h.store, "proj-1");
    const revoked = await publishAndAwait(h.state, "read_file", {
      projectId: "proj-1",
      path: "/notes.typ",
    });
    expect(revoked?.ok).toBe(false);
    expect((revoked as Extract<ControlResponse, { ok: false }>).error).toBe(
      CONTENT_CONSENT_REQUIRED_ERROR,
    );
  });

  it("disable() (Revoke Agent Access) revokes EVERY grant and kills the room", async () => {
    const h = makeToolHarness();
    grantContentAccess(h.store, "proj-1");
    grantContentAccess(h.store, "proj-2");
    h.mgr.disable();
    // The room died…
    expect(h.state.destroyed).toBe(true);
    // …and the grants died with it (the next session starts from zero).
    expect(readContentGrants(h.store)).toEqual([]);
  });

  it("construction WITHOUT a resumable session sweeps stale grants (orphan-grant safety)", () => {
    const store = makeMemoryStore();
    // Grants but NO capability blob → orphans → swept to default-zero.
    store.setItem(AGENT_CONTENT_GRANTS_KEY, JSON.stringify(["proj-1", "proj-2"]));
    getControlResponderManager(baseDeps({ sessionStore: store }));
    expect(readContentGrants(store)).toEqual([]);
  });

  it("an ABSENT projectFilesForTools dep fails closed (granted requests refused generically)", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const store = makeMemoryStore();
    const deps = baseDeps({ joinControlRoom, sessionStore: store });
    delete (deps as Partial<ControlResponderMountDeps>).projectFilesForTools;
    const mgr = getControlResponderManager(deps);
    mgr.enable();
    grantContentAccess(store, "proj-1");
    const resp = await publishAndAwait(state, "read_file", {
      projectId: "proj-1",
      path: "/main.typ",
    });
    expect(resp?.ok).toBe(false);
    expect((resp as Extract<ControlResponse, { ok: false }>).error).toBe(TOOL_FAILED_ERROR);
  });
});

describe("control-responder-mount — cross-reload persistence (resume)", () => {
  const RESUME_ROOM = "share-resume0000000000000000";
  const RESUME_KEY = new Uint8Array(32).fill(7);

  function seedSession(store: ReturnType<typeof makeMemoryStore>): void {
    store.setItem(
      AGENT_ACCESS_SESSION_KEY,
      JSON.stringify({ controlRoom: RESUME_ROOM, responseKey: bytesToBase64Url(RESUME_KEY) }),
    );
  }

  it("enable() PERSISTS the capability (room + 32-byte response key) for resume", () => {
    const store = makeMemoryStore();
    const mgr = getControlResponderManager(baseDeps({ sessionStore: store }));
    mgr.enable();
    const raw = store.getItem(AGENT_ACCESS_SESSION_KEY);
    expect(raw).not.toBeNull();
    const blob = JSON.parse(raw!) as { controlRoom: string; responseKey: string };
    expect(blob.controlRoom).toBe(mintedRooms[0]);
    const key = base64UrlToBytes(blob.responseKey);
    expect(key).not.toBeNull();
    expect(key!.length).toBe(32);
  });

  it("construction RESUMES a persisted session: re-joins the SAME room with the SAME key, no mint", async () => {
    const store = makeMemoryStore();
    seedSession(store);
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom, sessionStore: store }));
    // Live again WITHOUT enable() and WITHOUT minting a fresh room.
    expect(mgr.isEnabled()).toBe(true);
    expect(state.joinCount).toBe(1);
    expect(mintedRooms).toHaveLength(0);
    expect(mgr.getState().controlRoom).toBe(RESUME_ROOM);
    // B2 (ADR-0026): a RESUMED session was already paired (the kernel re-runs from
    // its durable store), so NO fresh code is minted and no command is shown.
    expect(mgr.getState().pairingCommand).toBeNull();
    // The resumed responder answers.
    const id = publishControlRequest(state.kernelHost, { op: "list_projects", params: {} }, REQUESTER);
    await flush();
    expect(getControlResponse(state.kernelHost, id)?.ok).toBe(true);
  });

  it("a resumed session KEEPS its persisted grants (not swept)", () => {
    const store = makeMemoryStore();
    seedSession(store);
    store.setItem(AGENT_CONTENT_GRANTS_KEY, JSON.stringify(["proj-1"]));
    getControlResponderManager(baseDeps({ sessionStore: store }));
    expect(readContentGrants(store)).toEqual(["proj-1"]);
  });

  it("a MALFORMED blob (bad room / missing key) does NOT resume and is cleared", () => {
    const store = makeMemoryStore();
    // "share-stale" is too short for isCapabilityRoomId; and there is no key.
    store.setItem(AGENT_ACCESS_SESSION_KEY, JSON.stringify({ controlRoom: "share-stale", syncUrl: "ws://x" }));
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom, sessionStore: store }));
    expect(mgr.isEnabled()).toBe(false);
    expect(state.joinCount).toBe(0);
    expect(store.getItem(AGENT_ACCESS_SESSION_KEY)).toBeNull();
  });

  it("disable() (Revoke) clears the persisted session — a subsequent construct is inert", () => {
    const store = makeMemoryStore();
    const mgr = getControlResponderManager(baseDeps({ sessionStore: store }));
    mgr.enable();
    expect(store.getItem(AGENT_ACCESS_SESSION_KEY)).not.toBeNull();
    mgr.disable();
    expect(store.getItem(AGENT_ACCESS_SESSION_KEY)).toBeNull();
    // A fresh manager over the same (now-cleared) store does NOT resume.
    __resetControlResponderManagerForTests();
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr2 = getControlResponderManager(baseDeps({ joinControlRoom, sessionStore: store }));
    expect(mgr2.isEnabled()).toBe(false);
    expect(state.joinCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// HIGH-1 — response authentication on the mount side: every response is
// signed with the per-session pairing key; squatters are overwritten; the key
// rotates with the session.
// ---------------------------------------------------------------------------

import {
  base64UrlToBytes,
  controlResponseSigningString,
  hmacControlResponse,
  buildBlobTerminalAuth,
} from "@galley/collab";

/**
 * The response key as the kernel would learn it (B2): NOT in the pairing command
 * (which carries only the one-time code), but via the test-only accessor — the
 * value the sealed handshake delivers to the kernel.
 */
function pairingKey(mgr: ReturnType<typeof getControlResponderManager>): Uint8Array {
  const key = __responseKeyForTests(mgr);
  expect(key, "live session has a response key").not.toBeNull();
  expect(key!.length).toBe(32);
  return key!;
}

describe("control-responder-mount — response signing (HIGH-1)", () => {
  it("the session holds a 32-byte response key — and the key NEVER enters the doc OR the command (B2)", async () => {
    const h = makeToolHarness();
    const keyText = bytesToBase64Url(pairingKey(h.mgr));
    expect(keyText.length).toBeGreaterThanOrEqual(43);
    // B2 (ADR-0026): the surfaced command carries ONLY the one-time code, never the key.
    expect(h.mgr.getState().pairingCommand ?? "").not.toContain(keyText);
    expect(h.mgr.getState().pairingCommand ?? "").not.toContain("--response-key");
    const resp = await publishAndAwait(h.state, "list_projects", {});
    expect(resp?.ok).toBe(true);
    // The control-room doc never contains the key — in the maps or anywhere in the state.
    const docJson = JSON.stringify({
      requests: h.state.kernelHost.doc.getMap("mcpControlRequests").toJSON(),
      responses: h.state.kernelHost.doc.getMap("mcpControlResponses").toJSON(),
    });
    expect(docJson).not.toContain(keyText);
  });

  it("EVERY response — success, refusal, and tool verdicts — carries a sig that verifies under the pairing key", async () => {
    const h = makeToolHarness();
    const key = pairingKey(h.mgr);
    grantContentAccess(h.store, "proj-1");

    const cases: Array<{ op: string; params: Record<string, unknown> }> = [
      { op: "list_projects", params: {} }, // metadata success
      { op: "list_versions", params: { projectId: "nope" } }, // metadata refusal
      { op: "read_file", params: { projectId: "proj-1", path: "/notes.typ" } }, // tool success
      { op: "read_file", params: { path: "/notes.typ" } }, // tool refusal (no projectId)
      { op: "what_is_this", params: {} }, // unknown-op refusal
    ];
    for (const c of cases) {
      const resp = await publishAndAwait(h.state, c.op, c.params);
      expect(resp, `${c.op} answered`).toBeDefined();
      expect(resp!.sig, `${c.op} response is signed`).toBeDefined();
      const expected = await hmacControlResponse(key, controlResponseSigningString(resp!));
      expect(resp!.sig).toBe(expected);
    }
  });

  it("ANTI-SQUATTING: a forged response racing ahead is OVERWRITTEN by the signed verdict", async () => {
    const h = makeToolHarness();
    const key = pairingKey(h.mgr);
    grantContentAccess(h.store, "proj-1");

    const id = publishControlRequest(
      h.state.kernelHost,
      { op: "read_file", params: { projectId: "proj-1", path: "/notes.typ" } },
      REQUESTER,
    );
    // The attacker wins the write race with a well-formed, UNSIGNED forgery.
    publishControlResponse(
      h.state.kernelHost,
      { id, ok: true, result: { text: "FORGED CONTENT", summary: "forged" } },
      REQUESTER,
    );
    await flush();

    const final = getControlResponse(h.state.kernelHost, id);
    expect(final?.ok).toBe(true);
    const result = (final as Extract<ControlResponse, { ok: true }>).result as { text: string };
    expect(result.text).toContain("alpha beta gamma"); // the REAL file, not the forgery
    expect(result.text).not.toContain("FORGED");
    const expected = await hmacControlResponse(key, controlResponseSigningString(final!));
    expect(final!.sig).toBe(expected);
  });

  it("re-enable mints a FRESH response key (a revoked key never signs again)", () => {
    const h = makeToolHarness();
    const first = bytesToBase64Url(pairingKey(h.mgr));
    h.mgr.disable();
    expect(h.mgr.getState().pairingCommand).toBeNull();
    expect(__responseKeyForTests(h.mgr)).toBeNull();
    h.mgr.enable();
    const second = bytesToBase64Url(pairingKey(h.mgr));
    expect(second).not.toBe(first);
  });
});

describe("control-responder-mount — pairing-command --compile-url (F4)", () => {
  it("buildPairingCommand carries the one-time code, no secret (B2, ADR-0026)", () => {
    const cmd = buildPairingCommand("ws://127.0.0.1:1234", "pairCode0aaaaaaaaaaaa");
    expect(cmd).toBe("galley-mcp --sync ws://127.0.0.1:1234 --pairing-code pairCode0aaaaaaaaaaaa");
    expect(cmd).not.toContain("--compile-url");
    expect(cmd).not.toContain("--control-room");
    expect(cmd).not.toContain("--response-key");
  });

  it("buildPairingCommand appends --compile-url when one is supplied", () => {
    const cmd = buildPairingCommand(
      "ws://127.0.0.1:1234",
      "pairCode0aaaaaaaaaaaa",
      "http://127.0.0.1:3001/compile",
    );
    expect(cmd).toContain("--pairing-code pairCode0aaaaaaaaaaaa --compile-url http://127.0.0.1:3001/compile");
  });

  it("loopbackCompileUrl passes loopback hosts and rejects everything else", () => {
    // Loopback → returned verbatim (the kernel accepts these).
    expect(loopbackCompileUrl("http://127.0.0.1:3001/compile")).toBe("http://127.0.0.1:3001/compile");
    expect(loopbackCompileUrl("http://localhost:3001/compile")).toBe("http://localhost:3001/compile");
    expect(loopbackCompileUrl("http://[::1]:3001/compile")).toBe("http://[::1]:3001/compile");
    expect(loopbackCompileUrl("http://127.5.6.7/compile")).toBe("http://127.5.6.7/compile");
    // Non-loopback → null (the kernel would refuse to POST the document there).
    expect(loopbackCompileUrl("https://compile.example.com/compile")).toBeNull();
    expect(loopbackCompileUrl("http://10.0.0.5:3001/compile")).toBeNull();
    // Absent / malformed → null.
    expect(loopbackCompileUrl(null)).toBeNull();
    expect(loopbackCompileUrl(undefined)).toBeNull();
    expect(loopbackCompileUrl("")).toBeNull();
    expect(loopbackCompileUrl("not a url")).toBeNull();
  });

  it("getState folds a loopback compile endpoint into the pairing command", () => {
    const { joinControlRoom } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(
      baseDeps({ joinControlRoom, resolveKernelCompileUrl: () => "http://127.0.0.1:3001/compile" }),
    );
    mgr.enable();
    expect(mgr.getState().pairingCommand).toContain("--compile-url http://127.0.0.1:3001/compile");
  });

  it("getState leaves the command compile-less when no loopback endpoint resolves", () => {
    const { joinControlRoom } = makeFakeLinkFactory();
    // resolveKernelCompileUrl returns null (e.g. a remote/absent compile URL that
    // loopbackCompileUrl already screened out) → command is unchanged.
    const mgr = getControlResponderManager(
      baseDeps({ joinControlRoom, resolveKernelCompileUrl: () => null }),
    );
    mgr.enable();
    expect(mgr.getState().pairingCommand).not.toContain("--compile-url");
  });

  it("getState is compile-less when the dep is omitted entirely (optional, back-compat)", () => {
    const { joinControlRoom } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable();
    expect(mgr.getState().pairingCommand).not.toContain("--compile-url");
  });
});

describe("control-responder-mount — A1 blob-terminal auth (§1)", () => {
  it("getBlobTerminalAuth is null without a grant, and builds a verifier that ACCEPTS the kernel's signed COMPLETE once a grant is live", async () => {
    const { joinControlRoom } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    mgr.enable();
    // No grant yet → no terminal auth.
    expect(mgr.getBlobTerminalAuth()).toBeNull();

    const key = pairingKey(mgr);
    const scope = {
      controlRoom: mgr.getState().controlRoom!,
      syncUrl: "ws://127.0.0.1:1234",
      projectId: "proj-1",
      shareRoom: "share-aaaaaaaaaaaaaaaaaaaa",
      grantId: A_GRANT,
    };
    mgr.recordGrant({ ...scope, mainFile: "/main.typ", mode: "ask", grantedAt: Date.now() });

    const auth = mgr.getBlobTerminalAuth();
    expect(auth).not.toBeNull();

    // The KERNEL (receiver) signs a COMPLETE with the SAME key + scope.
    const kernel = buildBlobTerminalAuth(key, scope);
    const hash = "a".repeat(64);
    const mac = await kernel.terminalSigner("complete", "exp-1", hash, 3, null);
    expect(mac).toBeDefined();
    // The browser's verifier ACCEPTS the kernel's MAC (cross-derivation works) …
    expect(await auth!.terminalVerifier("complete", "exp-1", hash, 3, null, mac)).toBe(true);
    // … and REJECTS an unsigned / wrong MAC (fails closed).
    expect(await auth!.terminalVerifier("complete", "exp-1", hash, 3, null, undefined)).toBe(false);
    expect(await auth!.terminalVerifier("complete", "exp-1", hash, 3, null, "not-a-real-mac")).toBe(false);
  });

  it("buildBlobTerminalAuthForScope works from an explicit scope (fresh-mint share path) and is null without a session key", async () => {
    const { joinControlRoom } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(baseDeps({ joinControlRoom }));
    // Disabled (no responseKey) → null.
    expect(
      mgr.buildBlobTerminalAuthForScope({
        grantId: A_GRANT,
        controlRoom: "ctl",
        syncUrl: "ws://127.0.0.1:1234",
        projectId: "proj-1",
        shareRoom: "share-bbbbbbbbbbbbbbbbbbbb",
      }),
    ).toBeNull();

    mgr.enable();
    const key = pairingKey(mgr);
    const scope = {
      grantId: A_GRANT,
      controlRoom: mgr.getState().controlRoom!,
      syncUrl: "ws://127.0.0.1:1234",
      projectId: "proj-1",
      shareRoom: "share-cccccccccccccccccccc",
    };
    const auth = mgr.buildBlobTerminalAuthForScope(scope);
    expect(auth).not.toBeNull();
    // It derives the SAME key as the kernel's signer for that scope.
    const kernel = buildBlobTerminalAuth(key, scope);
    const mac = await kernel.terminalSigner("complete", "exp-9", "b".repeat(64), 5, null);
    expect(await auth!.terminalVerifier("complete", "exp-9", "b".repeat(64), 5, null, mac)).toBe(true);
  });
});

describe("control-responder-mount — expect_blob is consent-gated + wired to the handler (A2)", () => {
  const HASH = "a".repeat(64);

  it("without a grant, expect_blob gets the STATIC consent-required refusal (no reservation)", async () => {
    const h = makeToolHarness();
    let reserveCalled = false;
    h.mgr.registerExpectBlobHandler(async () => { reserveCalled = true; return true; });
    const resp = await publishAndAwait(h.state, "expect_blob", { projectId: "proj-1", hash: HASH, size: 100 });
    expect(resp?.ok).toBe(false);
    expect((resp as Extract<ControlResponse, { ok: false }>).error).toBe(CONTENT_CONSENT_REQUIRED_ERROR);
    expect(reserveCalled).toBe(false);
  });

  it("granted + a handler that reserves → {reserved:true}", async () => {
    const h = makeToolHarness();
    grantContentAccess(h.store, "proj-1");
    const calls: { hash: string; size: number }[] = [];
    h.mgr.registerExpectBlobHandler(async (_pid, hash, size) => { calls.push({ hash, size }); return true; });
    const resp = await publishAndAwait(h.state, "expect_blob", { projectId: "proj-1", hash: HASH, size: 100 });
    expect(resp?.ok).toBe(true);
    expect((resp as Extract<ControlResponse, { ok: true }>).result).toEqual({ reserved: true });
    expect(calls).toEqual([{ hash: HASH, size: 100 }]);
  });

  it("granted + a handler that declines → {reserved:false}", async () => {
    const h = makeToolHarness();
    grantContentAccess(h.store, "proj-1");
    h.mgr.registerExpectBlobHandler(async () => false);
    const resp = await publishAndAwait(h.state, "expect_blob", { projectId: "proj-1", hash: HASH, size: 100 });
    expect(resp?.ok).toBe(true);
    expect((resp as Extract<ControlResponse, { ok: true }>).result).toEqual({ reserved: false });
  });

  it("granted but NO handler registered → unknown-project refusal (fail closed)", async () => {
    const h = makeToolHarness();
    grantContentAccess(h.store, "proj-1");
    const resp = await publishAndAwait(h.state, "expect_blob", { projectId: "proj-1", hash: HASH, size: 100 });
    expect(resp?.ok).toBe(false);
  });
});

describe("control-responder-mount — release_blob is consent-gated + wired (A2/C1b)", () => {
  const HASH = "a".repeat(64);

  it("without a grant, release_blob gets the consent-required refusal (no release)", async () => {
    const h = makeToolHarness();
    let released = false;
    h.mgr.registerReleaseBlobHandler(async () => { released = true; return true; });
    const resp = await publishAndAwait(h.state, "release_blob", { projectId: "proj-1", hashes: [{ hash: HASH, size: 1 }] });
    expect(resp?.ok).toBe(false);
    expect((resp as Extract<ControlResponse, { ok: false }>).error).toBe(CONTENT_CONSENT_REQUIRED_ERROR);
    expect(released).toBe(false);
  });

  it("granted + a handler → the handler receives the hashes and {released:true}", async () => {
    const h = makeToolHarness();
    grantContentAccess(h.store, "proj-1");
    const calls: { hash: string; size: number }[][] = [];
    h.mgr.registerReleaseBlobHandler(async (_pid, hashes) => { calls.push(hashes); return true; });
    const resp = await publishAndAwait(h.state, "release_blob", { projectId: "proj-1", hashes: [{ hash: HASH, size: 7 }] });
    expect(resp?.ok).toBe(true);
    expect((resp as Extract<ControlResponse, { ok: true }>).result).toEqual({ released: true });
    expect(calls[0]).toEqual([{ hash: HASH, size: 7 }]);
  });
});

describe("control-responder-mount — F13 headless attach end-to-end (ADR-0024 §3.1)", () => {
  /** Record a grant whose scope matches the manager's LIVE control room + relay. */
  function recordLiveGrant(
    mgr: ReturnType<typeof getControlResponderManager>,
    over: { persistentAccess?: boolean; projectId?: string; shareRoom?: string } = {},
  ): void {
    const controlRoom = mgr.getState().controlRoom!;
    mgr.recordGrant({
      controlRoom,
      projectId: over.projectId ?? "proj-bg",
      shareRoom: over.shareRoom ?? "share-bgbgbgbgbgbgbgbgbgbg00",
      syncUrl: "ws://127.0.0.1:1234",
      mainFile: "main.typ",
      grantId: "gHeadlessE2E_-ZyXwVuAbCd",
      mode: "auto",
      grantedAt: Date.now(), // fresh → not idle-expired
    });
    if (over.persistentAccess === true) mgr.setGrantPersistentAccess(true);
  }

  it("a persistentAccess grant for a NON-foreground project serves the handoff (no NO_OPEN_HANDLER refusal, no modal)", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(
      // No registered open handler AND the no-handler deps fallback: without headless
      // attach this would be NO_OPEN_HANDLER_REFUSAL.
      baseDeps({ joinControlRoom, openProjectForControl: async () => ({ refused: NO_OPEN_HANDLER_REFUSAL }) }),
    );
    mgr.enable();
    recordLiveGrant(mgr, { persistentAccess: true, projectId: "proj-bg" });
    const id = publishControlRequest(
      state.kernelHost,
      { op: "open_project", params: { projectId: "proj-bg" } },
      REQUESTER,
    );
    await flush();
    const resp = getControlResponse(state.kernelHost, id);
    expect(resp?.ok).toBe(true);
    expect((resp as Extract<ControlResponse, { ok: true }>).result).toEqual({
      syncUrl: "ws://127.0.0.1:1234",
      room: "share-bgbgbgbgbgbgbgbgbgbg00",
      projectId: "proj-bg",
      mainFile: "main.typ",
      grantId: "gHeadlessE2E_-ZyXwVuAbCd",
    });
  });

  it("a grant WITHOUT persistentAccess does NOT headless-attach (falls through to NO_OPEN_HANDLER)", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(
      baseDeps({ joinControlRoom, openProjectForControl: async () => ({ refused: NO_OPEN_HANDLER_REFUSAL }) }),
    );
    mgr.enable();
    recordLiveGrant(mgr, { persistentAccess: false, projectId: "proj-bg" });
    const id = publishControlRequest(
      state.kernelHost,
      { op: "open_project", params: { projectId: "proj-bg" } },
      REQUESTER,
    );
    await flush();
    const resp = getControlResponse(state.kernelHost, id);
    expect(resp?.ok).toBe(false);
    expect((resp as Extract<ControlResponse, { ok: false }>).error).toBe(NO_OPEN_HANDLER_REFUSAL);
  });

  it("headless attach is scoped: a request for a DIFFERENT project than the grant does not attach", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(
      baseDeps({ joinControlRoom, openProjectForControl: async () => ({ refused: NO_OPEN_HANDLER_REFUSAL }) }),
    );
    mgr.enable();
    recordLiveGrant(mgr, { persistentAccess: true, projectId: "proj-bg" });
    const id = publishControlRequest(
      state.kernelHost,
      { op: "open_project", params: { projectId: "some-other-project" } },
      REQUESTER,
    );
    await flush();
    const resp = getControlResponse(state.kernelHost, id);
    expect(resp?.ok).toBe(false);
    expect((resp as Extract<ControlResponse, { ok: false }>).error).toBe(NO_OPEN_HANDLER_REFUSAL);
  });

  it("Revoke (clearActiveGrant) tears down standing access: a later open_project no longer attaches", async () => {
    const { joinControlRoom, state } = makeFakeLinkFactory();
    const mgr = getControlResponderManager(
      baseDeps({ joinControlRoom, openProjectForControl: async () => ({ refused: NO_OPEN_HANDLER_REFUSAL }) }),
    );
    mgr.enable();
    recordLiveGrant(mgr, { persistentAccess: true, projectId: "proj-bg" });
    // Revoke the standing grant (the settings "Revoke background access" path).
    mgr.clearActiveGrant();
    expect(mgr.getActiveGrant()).toBeNull();
    const id = publishControlRequest(
      state.kernelHost,
      { op: "open_project", params: { projectId: "proj-bg" } },
      REQUESTER,
    );
    await flush();
    const resp = getControlResponse(state.kernelHost, id);
    expect(resp?.ok).toBe(false);
    expect((resp as Extract<ControlResponse, { ok: false }>).error).toBe(NO_OPEN_HANDLER_REFUSAL);
  });
});
