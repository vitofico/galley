import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebSocket as WS } from "ws";
import {
  CollabConnection,
  WebSocketTransport,
  observeControlRequests,
  readControlRequests,
  CONTROL_LIMITS,
  type DocHost,
  type WebSocketLike,
} from "@galley/collab";
import { createGalleyMcpServer } from "./server.js";
import { joinControlRoom, verifyControlResponseSig } from "./control.js";
import { registerControlTools } from "./control-tools.js";
import { joinRoom, type KernelSession } from "./session.js";
import { startFakeControlResponder, type FakeResponderOptions } from "./fake-control-responder.js";

/**
 * Control-room integration (#16.3a, ADR-0021): an MCP client driving a kernel
 * control session over a REAL @galley/sync relay, answered by the FAKE browser
 * responder (the reference implementation of the browser side):
 *
 *   MCP client ⇄ kernel control session ⇄ real ws relay ⇄ fake browser responder
 *
 * The headline pin: control-room pairing → list_projects → open_project → the
 * kernel JOINS the project room the browser minted → read_document serves the
 * project's text — the full ADR-0021 handoff to the existing 16.1/16.2
 * machinery. Plus the hostile cases: silence (timeout), forged oversized
 * responses, malformed bodies, room/syncUrl redirect attempts.
 */

interface SyncHandle {
  port: number;
  close(): Promise<void>;
}

// apps/mcp's tsconfig rootDir forbids a STATIC cross-package source import, so
// the real sync server is loaded with a runtime (variable-specifier) import —
// vitest resolves it; tsc never follows it. Structural type above.
const SYNC_SERVER_SPECIFIER = "../../sync/src/sync-server.js";

let server: SyncHandle;
let syncUrl: string;

beforeAll(async () => {
  const { startSyncServer } = (await import(SYNC_SERVER_SPECIFIER)) as {
    startSyncServer: (port?: number) => Promise<SyncHandle>;
  };
  server = await startSyncServer(0);
  syncUrl = `ws://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

/**
 * The per-session response-auth key (HIGH-1) shared by the kernel under test
 * and the fake responder — the same out-of-band pairing a human performs by
 * copying the command from Settings. Deterministic: the tests assert behavior,
 * not entropy (key minting is the browser mount's job).
 */
const RESPONSE_KEY = new Uint8Array(Array.from({ length: 32 }, (_v, i) => (i * 13 + 5) % 256));

const PROJECTS: FakeResponderOptions["projects"] = [
  {
    projectId: "proj-aaaa",
    name: "Paper A",
    lastModified: 1700000000000,
    mainFile: "/main.typ",
    files: { "/main.typ": "= Paper A\nbody\n", "/notes.typ": "notes\n" },
    versions: [
      { id: "ver-1", name: "draft", createdAt: 1700000000000 },
      { id: "ver-2", name: "submitted", message: "camera ready", createdAt: 1700000001000 },
    ],
  },
  { projectId: "proj-bbbb", name: "Paper B", mainFile: "/main.typ", files: { "/main.typ": "B\n" } },
];

/**
 * A ws socket whose 'error' events are observed (fast tests can destroy a
 * still-CONNECTING socket; with no listener the `ws` package's async abort
 * error becomes an uncaught exception).
 */
function quietSocket(url: string): WebSocketLike {
  const socket = new WS(url);
  socket.addEventListener("error", () => {});
  return socket as unknown as WebSocketLike;
}

/** Wire a control-mode kernel (short RPC timeout for tests) to an MCP client. */
async function controlClient(room: string, opts: { readyTimeoutMs?: number } = {}) {
  const control = joinControlRoom(
    { syncUrl, room, responseKey: RESPONSE_KEY },
    { socketFactory: quietSocket },
  );
  const sessions: KernelSession[] = [];
  const mcp = createGalleyMcpServer();
  registerControlTools(mcp, {
    // Tests fail fast: every RPC gets a short deadline instead of the 10s default.
    rpc: (op, params, timeoutMs) => control.rpc(op, params, timeoutMs ?? 1500),
    configuredSyncUrl: syncUrl,
    controlRoom: room,
    // The SAME pairing secret the control session verifies with — in production
    // one responseKey both authenticates control responses AND signs proposals.
    responseKey: RESPONSE_KEY,
    joinProject: (config) => {
      const session = joinRoom(config, { socketFactory: quietSocket });
      sessions.push(session);
      return session;
    },
    projectReadyTimeoutMs: opts.readyTimeoutMs ?? 4000,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "control-int-test", version: "0.0.0" });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  const destroy = (): void => {
    for (const s of sessions) s.destroy();
    control.destroy();
  };
  return { client, control, destroy };
}

function firstText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  const first = content?.[0];
  expect(first?.type).toBe("text");
  return first?.text ?? "";
}

describe("mcp kernel control mode ⇄ real relay ⇄ fake browser responder", () => {
  it("pairs and lists the project library (bounded, validated metadata)", async () => {
    const room = "ctl-list-projects";
    const responder = startFakeControlResponder({ syncUrl, controlRoom: room, projects: PROJECTS, responseKey: RESPONSE_KEY });
    const k = await controlClient(room);
    try {
      const result = await k.client.callTool({ name: "list_projects", arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(firstText(result))).toEqual({
        projects: [
          { projectId: "proj-aaaa", name: "Paper A", lastModified: 1700000000000 },
          { projectId: "proj-bbbb", name: "Paper B" },
        ],
        truncated: false,
      });
    } finally {
      k.destroy();
      responder.stop();
    }
  });

  it("lists a project's version METADATA (names/timestamps — never file contents)", async () => {
    const room = "ctl-list-versions";
    const responder = startFakeControlResponder({ syncUrl, controlRoom: room, projects: PROJECTS, responseKey: RESPONSE_KEY });
    const k = await controlClient(room);
    try {
      const result = await k.client.callTool({
        name: "list_versions",
        arguments: { projectId: "proj-aaaa" },
      });
      expect(JSON.parse(firstText(result))).toEqual({
        projectId: "proj-aaaa",
        versions: [
          { id: "ver-1", name: "draft", createdAt: 1700000000000 },
          { id: "ver-2", name: "submitted", message: "camera ready", createdAt: 1700000001000 },
        ],
        truncated: false,
      });

      const unknown = await k.client.callTool({
        name: "list_versions",
        arguments: { projectId: "proj-nope" },
      });
      expect(unknown.isError).toBe(true);
      // MEDIUM-3: even this VERIFIED browser refusal surfaces only as the
      // kernel's LOCAL generic line — no responder bytes reach the client.
      expect(firstText(unknown)).toContain("the responder refused this request");
      expect(firstText(unknown)).not.toContain("unknown project");
    } finally {
      k.destroy();
      responder.stop();
    }
  });

  it("PRODUCTION RELAY (C2): a structured restore STATUS survives classify/relay (not flattened to generic)", async () => {
    // The browser answers with an ok:true STRUCTURED status (not a refusal), so
    // the kernel's classifyRefusal — which collapses every non-consent ok:false to
    // GENERIC_REFUSAL — never touches it. Drive it over the REAL relay + the REAL
    // joinControlRoom.rpc + the REAL tool (not a stubbed deps.rpc) to prove the
    // status round-trips to the agent intact.
    const room = "ctl-restore-status";
    const responder = startFakeControlResponder({
      syncUrl,
      controlRoom: room,
      projects: PROJECTS,
      responseKey: RESPONSE_KEY,
      answer: (request) =>
        request.op === "request_restore_version"
          ? { id: request.id, ok: true, result: { status: "not_open" } }
          : null, // every other op falls through to the honest default
    });
    const k = await controlClient(room);
    try {
      const out = await k.client.callTool({
        name: "request_restore_version",
        arguments: { projectId: "proj-aaaa", versionId: "ver-1" },
      });
      // The status reached the agent — NOT the generic "the responder refused" line.
      expect(out.isError).toBeFalsy();
      const json = JSON.parse(firstText(out)) as { status: string; message: string };
      expect(json.status).toBe("not_open");
      expect(json.message).toMatch(/not open/i);
      expect(firstText(out)).not.toContain("the responder refused this request");
    } finally {
      k.destroy();
      responder.stop();
    }
  });

  it("PRODUCTION RELAY (C2): a CONSENT refusal still flattens to the clean grant-it error (stays a refusal)", async () => {
    // Consent is the ONE outcome kept as a refusal (no existence oracle). Over the
    // real relay the verified consent-required refusal must still map to the clean
    // "grant it in Settings" message — proving C2 did not turn consent into a status.
    const room = "ctl-restore-consent";
    const responder = startFakeControlResponder({
      syncUrl,
      controlRoom: room,
      projects: PROJECTS,
      responseKey: RESPONSE_KEY,
      answer: (request) =>
        request.op === "request_restore_version"
          ? {
              id: request.id,
              ok: false,
              error: "consent-required: file access for this project has not been granted",
            }
          : null,
    });
    const k = await controlClient(room);
    try {
      const out = await k.client.callTool({
        name: "request_restore_version",
        arguments: { projectId: "proj-aaaa", versionId: "ver-1" },
      });
      expect(out.isError).toBe(true);
      expect(firstText(out)).toMatch(/Settings → Agent Access/);
    } finally {
      k.destroy();
      responder.stop();
    }
  });

  it("HANDOFF: open_project joins the browser-minted share room and the per-project tools work there", async () => {
    const room = "ctl-open-handoff";
    const responder = startFakeControlResponder({ syncUrl, controlRoom: room, projects: PROJECTS, responseKey: RESPONSE_KEY });
    const k = await controlClient(room);
    try {
      // Before the open, the per-project tools are NOT served — the control
      // surface is the metadata trio plus the consent-gated content tools
      // (#1 slice 1: search_project / list_files / read_file; B4:
      // list_version_files / read_version_file, all projectId-keyed).
      const before = (await k.client.listTools()).tools.map((t) => t.name).sort();
      expect(before).toEqual([
        "create_project",
        "galley_ping",
        "list_bibliography",
        "list_files",
        "list_projects",
        "list_version_files",
        "list_versions",
        "open_project",
        "read_file",
        "read_version_file",
        "request_restore_version",
        "search_project",
      ]);
      const missing = await k.client.callTool({ name: "read_document", arguments: {} });
      expect(missing.isError).toBe(true);
      expect(firstText(missing)).toContain("not found");

      const opened = await k.client.callTool({
        name: "open_project",
        arguments: { projectId: "proj-aaaa" },
      });
      expect(opened.isError).toBeFalsy();
      const payload = JSON.parse(firstText(opened)) as { status: string; mainFile: string };
      expect(payload).toMatchObject({ status: "opened", projectId: "proj-aaaa", mainFile: "/main.typ" });
      // The room id is a CAPABILITY — the kernel must not echo it to the client.
      expect(firstText(opened)).not.toContain("share-");

      // The browser really minted a fresh share room for it…
      expect([...responder.openedRooms.keys()]).toHaveLength(1);
      expect([...responder.openedRooms.keys()][0]).toMatch(/^share-/);

      // …and the EXISTING per-project machinery now serves the six tools there.
      // The control-mode content tools are RETIRED on bind (#1 slice 1): the
      // per-project set owns list_files/read_file from here on, and
      // search_project is gone — pinned by the exact list below.
      const after = (await k.client.listTools()).tools.map((t) => t.name).sort();
      expect(after).toEqual([
        "compile",
        "create_project",
        "galley_ping",
        "list_files",
        "list_projects",
        "list_versions",
        "open_project",
        "project_context",
        "propose_edit",
        "propose_files",
        "read_document",
        "read_file",
      ]);
      // ADR-0024 §1: the open_project path wires honest liveness, so read_document
      // now returns a { text, liveness } sidecar (a read must never imply a watcher).
      const read = await k.client.callTool({ name: "read_document", arguments: {} });
      const readPayload = JSON.parse(firstText(read)) as {
        text: string;
        liveness: { relayConnected: boolean; browserAttached: boolean };
      };
      expect(readPayload.text).toBe("= Paper A\nbody\n");
      expect(typeof readPayload.liveness.relayConnected).toBe("boolean");
      expect(typeof readPayload.liveness.browserAttached).toBe("boolean");
      const listed = await k.client.callTool({ name: "list_files", arguments: {} });
      expect(JSON.parse(firstText(listed)).files.map((f: { path: string }) => f.path)).toEqual([
        "/main.typ",
        "/notes.typ",
      ]);
    } finally {
      k.destroy();
      responder.stop();
    }
  });

  it("ONE project per session: a second open_project reports already_open", async () => {
    const room = "ctl-open-once";
    const responder = startFakeControlResponder({ syncUrl, controlRoom: room, projects: PROJECTS, responseKey: RESPONSE_KEY });
    const k = await controlClient(room);
    try {
      const first = await k.client.callTool({
        name: "open_project",
        arguments: { projectId: "proj-aaaa" },
      });
      expect(JSON.parse(firstText(first)).status).toBe("opened");

      const second = await k.client.callTool({
        name: "open_project",
        arguments: { projectId: "proj-bbbb" },
      });
      expect(JSON.parse(firstText(second))).toMatchObject({
        status: "already_open",
        projectId: "proj-aaaa",
      });
      expect(responder.openedRooms.size).toBe(1); // the browser was never even asked
    } finally {
      k.destroy();
      responder.stop();
    }
  });

  it("RESPONDER SILENCE fails closed with a bounded timeout error (no retry storm)", async () => {
    const room = "ctl-silence";
    const responder = startFakeControlResponder({
      syncUrl,
      controlRoom: room,
      projects: PROJECTS,
      responseKey: RESPONSE_KEY,
      answer: () => null, // scripted silence
    });
    const k = await controlClient(room);
    try {
      const result = await k.client.callTool({ name: "list_projects", arguments: {} });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/no responder answered 'list_projects' within \d+ms/);
      expect(firstText(result).length).toBeLessThan(400);
    } finally {
      k.destroy();
      responder.stop();
    }
  });

  it("a FORGED OVERSIZED response is skipped — the RPC times out instead of surfacing it", async () => {
    const room = "ctl-oversize";
    // The honest responder stays silent; a hostile raw peer answers oversize.
    const responder = startFakeControlResponder({
      syncUrl,
      controlRoom: room,
      projects: PROJECTS,
      responseKey: RESPONSE_KEY,
      answer: () => null,
    });
    const hostileHost: DocHost = { doc: new Y.Doc() };
    const hostile = new CollabConnection(
      hostileHost,
      new WebSocketTransport(() => quietSocket(`${syncUrl}/${encodeURIComponent(room)}`)),
    );
    hostile.connect();
    const unobserve = observeControlRequests(hostileHost, () => {
      for (const request of readControlRequests(hostileHost)) {
        // Bypasses publishControlResponse: a raw over-cap record in the map.
        hostileHost.doc.getMap("mcpControlResponses").set(request.id, {
          id: request.id,
          ok: true,
          result: "x".repeat(CONTROL_LIMITS.maxResponseBytes + 1),
          respondedAt: Date.now(),
        });
      }
    });
    const k = await controlClient(room);
    try {
      const result = await k.client.callTool({ name: "list_projects", arguments: {} });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/no responder answered/);
      expect(firstText(result)).not.toContain("xxxx"); // the payload never surfaces
    } finally {
      k.destroy();
      unobserve();
      hostile.destroy();
      hostileHost.doc.destroy();
      responder.stop();
    }
  });

  it("a MALFORMED response body is refused with an honest schema error", async () => {
    const room = "ctl-malformed";
    const responder = startFakeControlResponder({
      syncUrl,
      controlRoom: room,
      projects: PROJECTS,
      responseKey: RESPONSE_KEY,
      answer: (request) => ({ id: request.id, ok: true, result: "nonsense" }),
    });
    const k = await controlClient(room);
    try {
      const result = await k.client.callTool({ name: "list_projects", arguments: {} });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain("invalid response");
    } finally {
      k.destroy();
      responder.stop();
    }
  });

  it.each([
    [
      "a NON-share room id (a stable project id is not a capability)",
      { mintRoom: () => "proj-aaaa" },
      /share/,
    ],
    [
      "a FOREIGN relay syncUrl (redirect attempt)",
      { projectSyncUrl: () => "ws://attacker.example:1234" },
      /foreign relay/,
    ],
  ] as const)(
    "open_project refuses %s — and the kernel never joins",
    async (_name, hostileOpts, want) => {
      const room = `ctl-hostile-${Object.keys(hostileOpts)[0]}`;
      const responder = startFakeControlResponder({
        syncUrl,
        controlRoom: room,
        projects: PROJECTS,
        responseKey: RESPONSE_KEY,
        ...hostileOpts,
      });
      const k = await controlClient(room);
      try {
        const result = await k.client.callTool({
          name: "open_project",
          arguments: { projectId: "proj-aaaa" },
        });
        expect(result.isError).toBe(true);
        expect(firstText(result)).toMatch(want);
        // No capability/topology leaks in the failure payload (Security
        // rounds 2+3): no share-room id, no control-room id, no CONFIGURED
        // relay URL, and no echo of the OFFERED hostile syncUrl.
        expect(firstText(result)).not.toMatch(/share-[A-Za-z0-9-]{16,}/);
        expect(firstText(result)).not.toContain(room);
        expect(firstText(result)).not.toContain(syncUrl);
        expect(firstText(result)).not.toContain("attacker.example");
        // The handoff was refused BEFORE any join: no per-project tools exist.
        const missing = await k.client.callTool({ name: "read_document", arguments: {} });
        expect(missing.isError).toBe(true);
        expect(firstText(missing)).toContain("not found");
      } finally {
        k.destroy();
        responder.stop();
      }
    },
  );

  it("open_project refuses a responder that answers for a DIFFERENT project id", async () => {
    const room = "ctl-swap";
    const responder = startFakeControlResponder({
      syncUrl,
      controlRoom: room,
      projects: PROJECTS,
      responseKey: RESPONSE_KEY,
      answer: (request) =>
        request.op === "open_project"
          ? {
              id: request.id,
              ok: true,
              result: {
                syncUrl,
                room: `share-${"a".repeat(32)}`,
                projectId: "proj-bbbb", // not what was asked for
                mainFile: "/main.typ",
                grantId: "g-valid-grant-token",
              },
            }
          : null,
    });
    const k = await controlClient(room);
    try {
      const result = await k.client.callTool({
        name: "open_project",
        arguments: { projectId: "proj-aaaa" },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/DIFFERENT project/);
      expect(firstText(result)).not.toMatch(/share-[A-Za-z0-9-]{16,}/);
    } finally {
      k.destroy();
      responder.stop();
    }
  });

  it("open_project refuses an unsafe mainFile path", async () => {
    const room = "ctl-unsafe-main";
    const responder = startFakeControlResponder({
      syncUrl,
      controlRoom: room,
      projects: PROJECTS,
      responseKey: RESPONSE_KEY,
      answer: (request) =>
        request.op === "open_project"
          ? {
              id: request.id,
              ok: true,
              result: {
                syncUrl,
                room: `share-${"b".repeat(32)}`,
                projectId: "proj-aaaa",
                mainFile: "/../escape.typ",
                grantId: "g-valid-grant-token",
              },
            }
          : null,
    });
    const k = await controlClient(room);
    try {
      const result = await k.client.callTool({
        name: "open_project",
        arguments: { projectId: "proj-aaaa" },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/unsafe mainFile/);
      expect(firstText(result)).not.toMatch(/share-[A-Za-z0-9-]{16,}/);
    } finally {
      k.destroy();
      responder.stop();
    }
  });

  // --- Capability redaction (Security round 2, finding 2) ----------------------

  it("open_project failure on an UNREADY project room is generic — the share-room capability reaches neither the client nor the payload", async () => {
    const room = "ctl-unready";
    const ghost = `share-${"c".repeat(32)}`; // a real, valid handoff… to an empty room
    const responder = startFakeControlResponder({
      syncUrl,
      controlRoom: room,
      projects: PROJECTS,
      responseKey: RESPONSE_KEY,
      answer: (request) =>
        request.op === "open_project"
          ? {
              id: request.id,
              ok: true,
              result: { syncUrl, room: ghost, projectId: "proj-aaaa", mainFile: "/main.typ", grantId: "g-valid-grant-token" },
            }
          : null,
    });
    const k = await controlClient(room, { readyTimeoutMs: 700 });
    try {
      const result = await k.client.callTool({
        name: "open_project",
        arguments: { projectId: "proj-aaaa" },
      });
      expect(result.isError).toBe(true);
      const text = firstText(result);
      expect(text).toMatch(/did not become ready/);
      // The capability must not appear — not the ghost room, not any share id,
      // not the control room, not the relay URL.
      expect(text).not.toContain(ghost);
      expect(text).not.toMatch(/share-[A-Za-z0-9-]{16,}/);
      expect(text).not.toContain(room);
      expect(text).not.toContain(syncUrl);
    } finally {
      k.destroy();
      responder.stop();
    }
  });

  it("the control session's stderr never contains the control-room id (capability redaction on the runtime socket path)", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    const room = "ctl-secret-capability-0123456789abcdef";
    // The DEFAULT socket factory (the runtime stderr path), against a dead
    // relay — the connection fails and the error line must be scrubbed.
    const control = joinControlRoom({ syncUrl: "ws://127.0.0.1:9", room, responseKey: RESPONSE_KEY });
    try {
      await vi.waitFor(
        () => {
          expect(lines.length).toBeGreaterThan(0);
        },
        { timeout: 4000, interval: 50 },
      );
      expect(lines.some((l) => l.includes("control-room socket error"))).toBe(true);
      for (const line of lines) {
        expect(line).not.toContain(room);
        expect(line).not.toContain(encodeURIComponent(room));
      }
    } finally {
      spy.mockRestore();
      control.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// HIGH-1 — response authentication over the REAL relay: the kernel acts only
// on responses HMAC-signed with the out-of-band pairing key.
// ---------------------------------------------------------------------------

describe("mcp kernel control mode — response authentication (HIGH-1)", () => {
  it("an UNSIGNED responder's answers are IGNORED — the RPC fails closed with the timeout line", async () => {
    const room = "ctl-unsigned-responder";
    // A responder with NO key: well-formed, honest-looking, but unsigned.
    const responder = startFakeControlResponder({ syncUrl, controlRoom: room, projects: PROJECTS });
    const k = await controlClient(room);
    try {
      const result = await k.client.callTool({ name: "list_projects", arguments: {} });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/no responder answered/);
      // None of the unsigned payload surfaced.
      expect(firstText(result)).not.toContain("Paper A");
    } finally {
      k.destroy();
      responder.stop();
    }
  });

  it("a WRONG-KEY responder's answers are IGNORED (signature must verify, not merely exist)", async () => {
    const room = "ctl-wrong-key-responder";
    const wrongKey = new Uint8Array(32).fill(7);
    const responder = startFakeControlResponder({
      syncUrl,
      controlRoom: room,
      projects: PROJECTS,
      responseKey: wrongKey,
    });
    const k = await controlClient(room);
    try {
      const result = await k.client.callTool({ name: "list_projects", arguments: {} });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/no responder answered/);
    } finally {
      k.destroy();
      responder.stop();
    }
  });

  it("FORGED RESPONSE LOSES THE RACE: a hostile peer answers FIRST, the signed browser verdict still wins", async () => {
    const room = "ctl-forged-race";

    // The hostile peer joins the room and instantly squats a forged, well-formed
    // (but unsigned) response onto every request it sees — winning the race.
    const hostileHost: DocHost = { doc: new Y.Doc() };
    const hostile = new CollabConnection(
      hostileHost,
      new WebSocketTransport(() => quietSocket(`${syncUrl}/${encodeURIComponent(room)}`)),
    );
    hostile.connect();
    const unobserve = observeControlRequests(hostileHost, () => {
      for (const request of readControlRequests(hostileHost)) {
        hostileHost.doc.getMap("mcpControlResponses").set(request.id, {
          id: request.id,
          ok: true,
          result: [{ projectId: "proj-EVIL", name: "forged library" }],
          respondedAt: Date.now(),
        });
      }
    });

    const k = await controlClient(room);
    let responder: ReturnType<typeof startFakeControlResponder> | undefined;
    try {
      // Drive the RPC directly with a generous deadline: the forged answer lands
      // first; the authentic responder is started only AFTERWARDS.
      const settled = k.control.rpc("list_projects", {}, 8000);

      // Wait until the forgery has demonstrably won the write race.
      await vi.waitFor(
        () => {
          expect(hostileHost.doc.getMap("mcpControlResponses").size).toBeGreaterThan(0);
        },
        { timeout: 4000, interval: 25 },
      );

      // NOW the real (signed) responder pairs up: includeAnswered + overwrite
      // let it answer the squatted request; the kernel accepts ONLY its verdict.
      responder = startFakeControlResponder({
        syncUrl,
        controlRoom: room,
        projects: PROJECTS,
        responseKey: RESPONSE_KEY,
      });

      const outcome = await settled;
      expect(outcome.ok).toBe(true);
      const rows = (outcome as { ok: true; result: unknown }).result as Array<{
        projectId: string;
      }>;
      expect(rows.map((r) => r.projectId)).toEqual(["proj-aaaa", "proj-bbbb"]);
      expect(JSON.stringify(rows)).not.toContain("proj-EVIL");
    } finally {
      k.destroy();
      unobserve();
      hostile.destroy();
      hostileHost.doc.destroy();
      responder?.stop();
    }
  });

  it("a signed open_project handoff verifies end-to-end (the high-stakes path is covered too)", async () => {
    const room = "ctl-signed-open";
    const responder = startFakeControlResponder({
      syncUrl,
      controlRoom: room,
      projects: PROJECTS,
      responseKey: RESPONSE_KEY,
    });
    const k = await controlClient(room);
    try {
      const opened = await k.client.callTool({
        name: "open_project",
        arguments: { projectId: "proj-aaaa" },
      });
      expect(opened.isError).toBeFalsy();
      expect(JSON.parse(firstText(opened))).toMatchObject({ status: "opened" });
    } finally {
      k.destroy();
      responder.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// HIGH-2 — cross-request replay: a validly SIGNED response for request A,
// copied verbatim under request B's key, must never settle B.
// ---------------------------------------------------------------------------

describe("mcp kernel control mode — cross-request replay is rejected (HIGH-2)", () => {
  it("verifyControlResponseSig binds the signature to the AWAITED id, not the record's self-asserted one", async () => {
    const { hmacControlResponse, controlResponseSigningString } = await import("@galley/collab");
    const idA = "a".repeat(32);
    const idB = "b".repeat(32);
    const sigA = await hmacControlResponse(
      RESPONSE_KEY,
      controlResponseSigningString({ id: idA, ok: true, result: "A's verdict" }),
    );
    const responseA = { id: idA, ok: true as const, result: "A's verdict", respondedAt: 0, sig: sigA };
    // Authentic under its own id…
    expect(verifyControlResponseSig(responseA, idA, RESPONSE_KEY)).toBe(true);
    // …rejected when the kernel is awaiting a DIFFERENT request.
    expect(verifyControlResponseSig(responseA, idB, RESPONSE_KEY)).toBe(false);
    // Rewriting the record's id to B (keeping A's signature) fails too: the
    // recomputed string now carries B's id, the signature still covers A's.
    expect(verifyControlResponseSig({ ...responseA, id: idB }, idB, RESPONSE_KEY)).toBe(false);
  });

  it("REPLAY over the real relay: A's captured signed response written under B's key is IGNORED — B times out", { timeout: 15_000 }, async () => {
    const room = "ctl-replay-a-into-b";
    // The responder answers the FIRST request honestly (signed), then goes
    // silent — so B can only ever be settled by the replayed forgery.
    let calls = 0;
    const responder = startFakeControlResponder({
      syncUrl,
      controlRoom: room,
      projects: PROJECTS,
      responseKey: RESPONSE_KEY,
      answer: (request, byDefault) => {
        calls += 1;
        return calls === 1 ? byDefault() : null;
      },
    });

    // A hostile peer captures every raw response record it ever sees.
    const captured = new Map<string, unknown>();
    const hostileHost: DocHost = { doc: new Y.Doc() };
    const hostile = new CollabConnection(
      hostileHost,
      new WebSocketTransport(() => quietSocket(`${syncUrl}/${encodeURIComponent(room)}`)),
    );
    hostile.connect();
    const responsesMap = hostileHost.doc.getMap("mcpControlResponses");
    const capture = (): void => {
      for (const [k, v] of responsesMap.entries()) {
        if (!captured.has(k)) captured.set(k, v);
      }
    };
    responsesMap.observe(capture);

    const k = await controlClient(room);
    try {
      // Request A settles authentically (and its signed record gets captured).
      const a = await k.control.rpc("list_projects", {}, 8000);
      expect(a.ok).toBe(true);
      await vi.waitFor(
        () => {
          expect([...captured.values()].some((v) => (v as { ok?: boolean }).ok === true)).toBe(true);
        },
        { timeout: 4000, interval: 25 },
      );
      const recordA = [...captured.values()].find((v) => (v as { ok?: boolean }).ok === true)!;

      // Request B: the responder is silent; the hostile peer replays A's
      // UNCHANGED record under B's key as soon as B appears.
      const unobserve = observeControlRequests(hostileHost, () => {
        for (const request of readControlRequests(hostileHost)) {
          hostileHost.doc.getMap("mcpControlResponses").set(request.id, recordA);
        }
      });
      const b = await k.control.rpc("list_projects", {}, 1500);
      unobserve();

      // The replay never settled B: fail-closed timeout, no stale verdict.
      expect(b.ok).toBe(false);
      expect((b as { ok: false; error: string }).error).toMatch(/no responder answered/);
      expect(JSON.stringify(b)).not.toContain("Paper A"); // A's payload never surfaced
    } finally {
      responsesMap.unobserve(capture);
      k.destroy();
      hostile.destroy();
      hostileHost.doc.destroy();
      responder.stop();
    }
  });
});
