/**
 * The hosted connector end to end (ADR-0033), read side: a real MCP client
 * over the HTTP surface, real token and registry files, a real relay.
 *
 *   - the token is the only way in, by header or by URL path, and a revoked,
 *     expired or closed-account token is refused like a missing one;
 *   - a token reaches its owner's connected projects and nobody else's;
 *   - disconnecting a project stops the next call;
 *   - reads answer from the relay's copy, with no browser peer present.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket as WS } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createConnectorToken, revokeConnectorToken } from "@galley/auth";
import {
  CollabConnection,
  CollabProject,
  WebSocketTransport,
  getFileProposals,
  getPendingFileProposals,
  getPendingProposals,
  getProposals,
  resolveProposal,
  type WebSocketLike,
} from "@galley/collab";
import {
  FsCapabilityRoomRegistry,
  FsConnectorActivityLog,
  FsConnectorCheckpoints,
  FsConnectorTokenStore,
  FsSessionStore,
} from "@galley/persistence";
import type {
  Author,
  CheckResult,
  ConnectorActivityEntry,
  ConnectorCheckpoint,
} from "@galley/shared";
import { createConnectorApp, type ConnectorAppDeps } from "./app.js";
import { ProjectUnavailableError } from "./room.js";
import { MAX_PENDING_PROPOSALS } from "./tools.js";
import { buildConnectorDeps, createStateSweep } from "./wiring.js";

interface SyncHandle {
  port: number;
  close(): Promise<void>;
}
// Runtime import: apps/mcp's rootDir forbids a static cross-app source import.
const SYNC_SERVER_SPECIFIER = "../../../sync/src/sync-server.js";

const HUMAN: Author = { kind: "human", userId: "alice" };
const settle = { timeout: 4000, interval: 20 };
const NOVEL = "share-novel000000000000000000000000";
const EMPTY = "share-empty000000000000000000000000";
const BOBS = "share-bobs0000000000000000000000000";

let relay: SyncHandle;
let dataDir: string;
let deps: ConnectorAppDeps;
let aliceToken: string;
let aliceTokenId: string;

const issue = async (
  userId: string,
  expiresInDays = 90,
  nowMs = Date.now(),
) => {
  const res = await createConnectorToken(new FsConnectorTokenStore(dataDir), {
    body: { name: "test client", expiresInDays },
    userId,
    nowMs,
  });
  if (res.status !== 200) throw new Error("token not issued");
  return res.body;
};

const connectRoom = (
  roomId: string,
  projectId: string,
  createdBy: string,
  extra: Record<string, unknown> = {},
) =>
  new FsCapabilityRoomRegistry(dataDir).put({
    version: 1,
    roomId,
    kind: "connector",
    createdBy,
    createdAtMs: Date.now(),
    projectId,
    reviewMode: "ask",
    ...extra,
  });

/** The browser, once: it fills the relay's copy of a room and closes its tab. */
async function seed(roomId: string, files: Record<string, string>) {
  const project = new CollabProject();
  for (const [path, text] of Object.entries(files))
    project.create(path, text, HUMAN);
  const url = `ws://127.0.0.1:${relay.port}/${roomId}`;
  const connection = new CollabConnection(
    project,
    new WebSocketTransport(() => new WS(url) as unknown as WebSocketLike),
    { author: HUMAN },
  );
  connection.connect();
  await vi.waitFor(() => expect(connection.synced).toBe(true), settle);
  return {
    project,
    close: () => {
      connection.destroy();
      project.destroy();
    },
  };
}

/** An MCP client talking to the app in-process, by header or by URL path. */
async function client(
  app: ReturnType<typeof createConnectorApp>,
  token: string,
  via: "header" | "path" = "header",
) {
  const url = new URL(
    via === "path" ? `http://connector/mcp/${token}` : "http://connector/mcp",
  );
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: async (input, init) =>
      app.fetch(new Request(input, init as RequestInit)),
    ...(via === "header"
      ? { requestInit: { headers: { authorization: `Bearer ${token}` } } }
      : {}),
  });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(transport);
  return c;
}

const call = async (
  c: Client,
  name: string,
  args: Record<string, unknown> = {},
) => {
  const res = (await c.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  return { text: res.content[0]!.text, isError: res.isError === true };
};

const post = (
  app: ReturnType<typeof createConnectorApp>,
  path: string,
  headers = {},
) =>
  app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

let novel: Awaited<ReturnType<typeof seed>>;

beforeAll(async () => {
  const { startSyncServer } = (await import(SYNC_SERVER_SPECIFIER)) as {
    startSyncServer: (port?: number) => Promise<SyncHandle>;
  };
  relay = await startSyncServer(0);
  dataDir = await mkdtemp(join(tmpdir(), "galley-connector-"));
  deps = buildConnectorDeps({
    port: 0,
    dataDir,
    syncUrl: `ws://127.0.0.1:${relay.port}`,
  });
  const issued = await issue("alice");
  aliceToken = issued.token;
  aliceTokenId = issued.tokenId;
  // Listed oldest first: give the two distinct times, or a same-millisecond
  // pair would be ordered by room id.
  const t0 = Date.now();
  await connectRoom(NOVEL, "proj-novel", "alice", {
    projectName: "My novel",
    createdAtMs: t0 - 1,
  });
  await connectRoom(EMPTY, "proj-empty", "alice", { createdAtMs: t0 });
  await connectRoom(BOBS, "proj-bob", "bob", { reviewMode: "auto" });
  // A peer stays in the room so the open test relay keeps its state; on a
  // real deployment the relay's disk copy plays this part (apps/sync tests).
  novel = await seed(NOVEL, {
    "/main.typ": "= Chapter one\nIt was a dark and stormy night.\n",
    "/notes.typ": "The lighthouse keeper is called Marta.\n",
  });
});

afterAll(async () => {
  novel.close();
  await relay.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("the token is the only way in", () => {
  it("refuses a missing, malformed or unknown token the same way", async () => {
    const app = createConnectorApp(deps);
    const unknown = `gly_${"A".repeat(43)}`;
    for (const res of [
      await post(app, "/mcp"),
      await post(app, "/mcp", { authorization: "Bearer nope" }),
      await post(app, "/mcp", { authorization: `Bearer ${unknown}` }),
      await post(app, "/mcp", { authorization: `Basic ${aliceToken}` }),
      await post(app, `/mcp/${unknown}`),
      await post(app, "/mcp/not-a-token"),
    ]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    }
  });

  it("accepts the token as a bearer header and in the URL path", async () => {
    const app = createConnectorApp(deps);
    for (const via of ["header", "path"] as const) {
      const c = await client(app, aliceToken, via);
      expect((await c.listTools()).tools.map((t) => t.name)).toEqual([
        "list_projects",
        "list_files",
        "read_file",
        "project_context",
        "compile",
        "propose_edit",
        "propose_files",
      ]);
      await c.close();
    }
  });

  it("answers POST only, and marks every answer uncacheable", async () => {
    const app = createConnectorApp(deps);
    const get = await app.request("/mcp", {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const ok = await post(app, `/mcp/${aliceToken}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("referrer-policy")).toBe("no-referrer");
    expect(ok.headers.get("mcp-session-id")).toBeNull(); // stateless
  });

  it("refuses an expired token, a revoked token and a closed account", async () => {
    const app = createConnectorApp(deps);
    const old = await issue("alice", 30, Date.now() - 31 * 86_400_000);
    expect((await post(app, `/mcp/${old.token}`)).status).toBe(401);

    const gone = await issue("alice");
    expect((await post(app, `/mcp/${gone.token}`)).status).toBe(200);
    await revokeConnectorToken(new FsConnectorTokenStore(dataDir), {
      tokenId: gone.tokenId,
      userId: "alice",
    });
    expect((await post(app, `/mcp/${gone.token}`)).status).toBe(401);

    const carol = await issue("carol");
    expect((await post(app, `/mcp/${carol.token}`)).status).toBe(200);
    await new FsSessionStore(dataDir).closeUser("carol", {
      operationId: "op-1",
    });
    expect((await post(app, `/mcp/${carol.token}`)).status).toBe(401);
  });

  it("sheds load past its concurrency limit", async () => {
    const res = await post(
      createConnectorApp({ ...deps, maxConcurrent: 0 }),
      `/mcp/${aliceToken}`,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("2");
  });
});

describe("reading a connected project with no tab open", () => {
  it("lists the caller's connected projects, without their rooms", async () => {
    const c = await client(createConnectorApp(deps), aliceToken);
    const { text } = await call(c, "list_projects");
    expect(JSON.parse(text)).toEqual({
      projects: [
        { projectId: "proj-novel", name: "My novel", reviewMode: "ask" },
        { projectId: "proj-empty", reviewMode: "ask" },
      ],
    });
    expect(text).not.toContain("share-");
    await c.close();
  });

  it("lists, reads and searches the relay's copy", async () => {
    const c = await client(createConnectorApp(deps), aliceToken, "path");
    const files = JSON.parse(
      (await call(c, "list_files", { project: "proj-novel" })).text,
    );
    expect(files.files.map((f: { path: string }) => f.path)).toEqual([
      "/main.typ",
      "/notes.typ",
    ]);
    expect(
      await call(c, "read_file", { project: "proj-novel", path: "/notes.typ" }),
    ).toEqual({
      text: "The lighthouse keeper is called Marta.\n",
      isError: false,
    });
    const ctx = JSON.parse(
      (
        await call(c, "project_context", {
          project: "proj-novel",
          query: "lighthouse keeper",
        })
      ).text,
    );
    expect(ctx.excerpts.map((e: { path: string }) => e.path)).toContain(
      "/notes.typ",
    );
    await c.close();
  });

  it("reaches nobody else's project, and names no room when refusing", async () => {
    const c = await client(createConnectorApp(deps), aliceToken);
    for (const project of ["proj-bob", "nope", BOBS]) {
      const res = await call(c, "read_file", { project, path: "/main.typ" });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/no connected project has that id/);
      expect(res.text).not.toContain("share-");
    }
    await c.close();
  });

  it("says so when the server copy has not filled yet", async () => {
    const c = await client(createConnectorApp(deps), aliceToken);
    const res = await call(c, "list_files", { project: "proj-empty" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/no copy of this project yet/);
    await c.close();
  });

  it("stops at the next call once the project is disconnected", async () => {
    const room = "share-gone000000000000000000000000";
    await connectRoom(room, "proj-gone", "alice");
    const { close } = await seed(room, { "/main.typ": "text\n" });
    const c = await client(createConnectorApp(deps), aliceToken);
    expect(
      (await call(c, "list_files", { project: "proj-gone" })).isError,
    ).toBe(false);
    await connectRoom(room, "proj-gone", "alice", {
      revokedAtMs: Date.now(),
      revokedBy: "alice",
    });
    const after = await call(c, "list_files", { project: "proj-gone" });
    expect(after.isError).toBe(true);
    expect(after.text).toMatch(/no connected project has that id/);
    close();
    await c.close();
  });

  it("reports an unreachable relay without leaking the room", async () => {
    const down = buildConnectorDeps({
      port: 0,
      dataDir,
      syncUrl: "ws://127.0.0.1:1", // nothing listens here
    });
    const c = await client(createConnectorApp(down), aliceToken);
    const res = await call(c, "list_files", { project: "proj-novel" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/could not be reached/);
    expect(res.text).not.toContain("share-");
    await c.close();
  });
});

describe("compile", () => {
  it("is honest when the server has no compile service", async () => {
    const c = await client(createConnectorApp(deps), aliceToken);
    const res = await call(c, "compile", { project: "proj-novel" });
    expect(JSON.parse(res.text).status).toBe("not_configured");
    await c.close();
  });

  it("type-checks the relay's copy on the server's compile service", async () => {
    const seen: unknown[] = [];
    const check: CheckResult = {
      ok: true,
      pageCount: 2,
      diagnostics: [],
      durationMs: 5,
    };
    const app = createConnectorApp({
      ...deps,
      compileService: {
        check: async (input) => {
          seen.push(input);
          return check;
        },
      },
    });
    const c = await client(app, aliceToken);
    const res = JSON.parse(
      (await call(c, "compile", { project: "proj-novel" })).text,
    );
    expect(res).toMatchObject({
      status: "ok",
      source: "server",
      ok: true,
      pageCount: 2,
    });
    expect(seen[0]).toMatchObject({ kind: "project", main: "/main.typ" });
    await c.close();
  });
});

describe("proposing a change (published for review, never applied)", () => {
  const mainText = () =>
    novel.project
      .snapshot()
      .files.find((f) => f.path === "/main.typ")!.text;

  it("publishes an edit as a pending proposal the browser can review", async () => {
    const c = await client(createConnectorApp(deps), aliceToken);
    const before = mainText();
    const res = JSON.parse(
      (
        await call(c, "propose_edit", {
          project: "proj-novel",
          path: "/main.typ",
          request: "Calmer weather",
          edits: [{ search: "dark and stormy", replace: "quiet" }],
        })
      ).text,
    );
    expect(res).toMatchObject({
      status: "pending_review",
      project: "proj-novel",
      filePath: "/main.typ",
    });
    expect(res.message).toMatch(/has NOT changed/);
    // The browser peer sees the record, and the document is untouched.
    await vi.waitFor(
      () =>
        expect(getPendingProposals(novel.project)).toEqual([
          expect.objectContaining({
            id: res.proposalId,
            filePath: "/main.typ",
            request: "Calmer weather",
            proposedText: "= Chapter one\nIt was a quiet night.\n",
            status: "pending",
          }),
        ]),
      settle,
    );
    expect(mainText()).toBe(before);
    resolveProposal(novel.project, res.proposalId, "rejected", HUMAN);
    await c.close();
  });

  it("publishes a multi-file change set as one pending proposal", async () => {
    const c = await client(createConnectorApp(deps), aliceToken);
    const res = JSON.parse(
      (
        await call(c, "propose_files", {
          project: "proj-novel",
          request: "Add chapter two",
          ops: [
            { kind: "create", path: "/ch2.typ", text: "= Chapter two\n" },
            {
              kind: "edit",
              path: "/main.typ",
              edits: [{ search: "night.\n", replace: 'night.\n#include "ch2.typ"\n' }],
            },
            { kind: "rename", path: "/notes.typ", newPath: "/notes/cast.typ" },
          ],
        })
      ).text,
    );
    expect(res).toMatchObject({
      status: "pending_review",
      ops: [
        { kind: "create", path: "/ch2.typ" },
        { kind: "edit", path: "/main.typ" },
        { kind: "rename", path: "/notes.typ", newPath: "/notes/cast.typ" },
      ],
    });
    await vi.waitFor(
      () =>
        expect(getPendingFileProposals(novel.project).map((p) => p.id)).toEqual([
          res.proposalId,
        ]),
      settle,
    );
    // Nothing was created, edited or moved.
    expect(novel.project.snapshot().files.map((f) => f.path).sort()).toEqual([
      "/main.typ",
      "/notes.typ",
    ]);
    await c.close();
  });

  it("refuses a change that does not apply, and publishes nothing", async () => {
    const c = await client(createConnectorApp(deps), aliceToken);
    const pendingBefore = getPendingProposals(novel.project).length;
    const failed = JSON.parse(
      (
        await call(c, "propose_edit", {
          project: "proj-novel",
          path: "/main.typ",
          request: "x",
          edits: [{ search: "not in the text", replace: "y" }],
        })
      ).text,
    );
    expect(failed).toMatchObject({ status: "edit_failed", path: "/main.typ" });
    const unsafe = JSON.parse(
      (
        await call(c, "propose_files", {
          project: "proj-novel",
          request: "x",
          ops: [{ kind: "create", path: "../escape.typ", text: "" }],
        })
      ).text,
    );
    expect(unsafe.status).toBe("invalid_path");
    // A binary op is not part of the connector's tool at all.
    const binary = await call(c, "propose_files", {
      project: "proj-novel",
      request: "x",
      ops: [{ kind: "create-binary", path: "/a.png", bytes: "AAAA" }],
    });
    expect(binary.isError).toBe(true);
    expect(getPendingProposals(novel.project).length).toBe(pendingBefore);
    await c.close();
  });

  it("reviews an Auto project like any other when the server is not set up to apply", async () => {
    const room = "share-auto000000000000000000000000";
    await connectRoom(room, "proj-auto", "alice", { reviewMode: "auto" });
    const auto = await seed(room, { "/main.typ": "one\n" });
    const c = await client(createConnectorApp(deps), aliceToken);
    const res = JSON.parse(
      (
        await call(c, "propose_edit", {
          project: "proj-auto",
          path: "/main.typ",
          request: "two",
          edits: [{ search: "one", replace: "two" }],
        })
      ).text,
    );
    expect(res.status).toBe("pending_review");
    expect(res.message).toMatch(/set to Auto.*waits for review/);
    expect(auto.project.snapshot().files[0]!.text).toBe("one\n");
    auto.close();
    await c.close();
  });

  it("stops adding proposals nobody is reviewing", async () => {
    const room = "share-flood00000000000000000000000";
    await connectRoom(room, "proj-flood", "alice");
    const flood = await seed(room, { "/main.typ": "0\n" });
    const c = await client(createConnectorApp(deps), aliceToken);
    const propose = (n: number) =>
      call(c, "propose_edit", {
        project: "proj-flood",
        path: "/main.typ",
        request: `change ${n}`,
        edits: [{ search: "0", replace: String(n) }],
      });
    for (let n = 1; n <= MAX_PENDING_PROPOSALS; n++)
      expect(JSON.parse((await propose(n)).text).status).toBe("pending_review");
    expect(JSON.parse((await propose(99)).text).status).toBe("too_many_pending");
    flood.close();
    await c.close();
  });

  it("does not claim a publish it cannot find on the server", async () => {
    let joins = 0;
    const app = createConnectorApp({
      ...deps,
      // The publishing join works; every later join (the read-back) fails.
      withProject: (roomId, fn) => {
        if (++joins > 1) throw new ProjectUnavailableError();
        return deps.withProject(roomId, fn);
      },
    });
    const c = await client(app, aliceToken);
    const res = await call(c, "propose_edit", {
      project: "proj-novel",
      path: "/notes.typ",
      request: "rename the keeper",
      edits: [{ search: "Marta", replace: "Ines" }],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/could not be confirmed on the server/);
    await c.close();
  });
});

describe("Auto mode: the server applies, under its safeguards", () => {
  let stateDir: string;
  let autoDeps: ConnectorAppDeps;
  let n = 0;

  beforeAll(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "galley-connector-state-"));
    autoDeps = buildConnectorDeps({
      port: 0,
      dataDir,
      syncUrl: `ws://127.0.0.1:${relay.port}`,
      stateDir,
    });
  });
  afterAll(() => rm(stateDir, { recursive: true, force: true }));

  /** A fresh Auto project with a browser peer watching it. */
  const autoProject = async (files: Record<string, string>) => {
    const id = String(++n).padStart(2, "0");
    const room = `share-autoapply${id}00000000000000000`;
    const projectId = `proj-auto-${id}`;
    await connectRoom(room, projectId, "alice", { reviewMode: "auto" });
    const peer = await seed(room, files);
    const text = (path: string) =>
      peer.project.snapshot().files.find((f) => f.path === path && !f.deleted)
        ?.text;
    return { room, projectId, peer, text };
  };
  const trail = (room: string) => new FsConnectorActivityLog(stateDir).read(room);
  const edit = (c: Client, project: string, search: string, replace: string) =>
    call(c, "propose_edit", {
      project,
      path: "/main.typ",
      request: `${search} to ${replace}`,
      edits: [{ search, replace }],
    });

  it("applies an edit, leaving a checkpoint, a trail and a resolved record", async () => {
    const p = await autoProject({ "/main.typ": "one\n" });
    const c = await client(createConnectorApp(autoDeps), aliceToken);
    const res = JSON.parse((await edit(c, p.projectId, "one", "two")).text);
    expect(res).toMatchObject({ status: "applied", filePath: "/main.typ" });
    // The browser peer gets the text, and never a card to review.
    await vi.waitFor(() => expect(p.text("/main.typ")).toBe("two\n"), settle);
    expect(getPendingProposals(p.peer.project)).toEqual([]);
    expect(getProposals(p.peer.project)).toEqual([
      expect.objectContaining({ status: "accepted", request: "one to two" }),
    ]);
    const entries = await trail(p.room);
    expect(entries.map((e) => e.state)).toEqual(["started", "applied"]);
    expect(entries[0]).toMatchObject<Partial<ConnectorActivityEntry>>({
      tokenId: aliceTokenId,
      request: "one to two",
      files: ["/main.typ"],
      ops: 1,
    });
    expect(entries[1]!.changeId).toBe(entries[0]!.changeId);
    // The checkpoint is the project as it was before.
    const bytes = await new FsConnectorCheckpoints(stateDir).read(
      p.room,
      entries[0]!.checkpointId,
    );
    const checkpoint = JSON.parse(
      new TextDecoder().decode(bytes!),
    ) as ConnectorCheckpoint;
    expect(checkpoint.files.find((f) => f.path === "main.typ")?.text).toBe(
      "one\n",
    );
    p.peer.close();
    await c.close();
  });

  it("applies a multi-file set as one change", async () => {
    const p = await autoProject({ "/main.typ": "= Book\n" });
    const c = await client(createConnectorApp(autoDeps), aliceToken);
    const res = JSON.parse(
      (
        await call(c, "propose_files", {
          project: p.projectId,
          request: "Add an intro",
          ops: [
            { kind: "create", path: "/intro.typ", text: "Hello.\n" },
            {
              kind: "edit",
              path: "/main.typ",
              edits: [{ search: "= Book\n", replace: '= Book\n#include "intro.typ"\n' }],
            },
          ],
        })
      ).text,
    );
    expect(res.status).toBe("applied");
    await vi.waitFor(() => expect(p.text("/intro.typ")).toBe("Hello.\n"), settle);
    expect(p.text("/main.typ")).toBe('= Book\n#include "intro.typ"\n');
    expect(getPendingFileProposals(p.peer.project)).toEqual([]);
    expect(getFileProposals(p.peer.project)[0]?.status).toBe("accepted");
    expect((await trail(p.room))[0]).toMatchObject({ ops: 2, files: ["/intro.typ", "/main.typ"] });
    p.peer.close();
    await c.close();
  });

  it("applies nothing when the text moved while the change was on its way", async () => {
    const p = await autoProject({ "/main.typ": "one\n" });
    const app = createConnectorApp({
      ...autoDeps,
      auto: {
        ...autoDeps.auto!,
        checkpoints: {
          // While the checkpoint is being saved, the owner rewrites the line.
          save: async (room, bytes) => {
            const file = p.peer.project.snapshot().files[0]!;
            p.peer.project.transactFile(
              file.fileId,
              (t) => {
                t.delete(0, t.length);
                t.insert(0, "the owner's line\n");
              },
              HUMAN,
            );
            await new Promise((r) => setTimeout(r, 200));
            return autoDeps.auto!.checkpoints.save(room, bytes);
          },
        },
      },
    });
    const c = await client(app, aliceToken);
    const res = JSON.parse((await edit(c, p.projectId, "one", "two")).text);
    expect(res.status).toBe("conflict");
    expect(res.message).toMatch(/Nothing was changed/);
    expect(p.text("/main.typ")).toBe("the owner's line\n");
    expect(getProposals(p.peer.project)).toEqual([]);
    expect((await trail(p.room)).map((e) => e.state)).toEqual(["started", "conflict"]);
    p.peer.close();
    await c.close();
  });

  it("stops at once when the token is revoked or the project is switched to Ask", async () => {
    const p = await autoProject({ "/main.typ": "one\n" });
    // The token passes at the door, then is gone by the time of the change.
    let checks = -Infinity; // not counting until the client has connected
    const revoked = createConnectorApp({
      ...autoDeps,
      authenticate: async (token) =>
        ++checks > 1 ? null : autoDeps.authenticate(token),
    });
    let c = await client(revoked, aliceToken);
    checks = 0;
    const refused = JSON.parse((await edit(c, p.projectId, "one", "two")).text);
    expect(refused.status).toBe("unauthorized");
    await c.close();

    // Switched to Ask after the call began: published for review instead.
    let reads = 0;
    const switched = createConnectorApp({
      ...autoDeps,
      listProjects: async (userId) => {
        const all = await autoDeps.listProjects(userId);
        return ++reads > 1
          ? all.map((x) => ({ ...x, reviewMode: "ask" as const }))
          : all;
      },
    });
    c = await client(switched, aliceToken);
    reads = 0;
    const asked = JSON.parse((await edit(c, p.projectId, "one", "two")).text);
    expect(asked.status).toBe("pending_review");
    expect(asked.message).not.toMatch(/set to Auto/);

    expect(p.text("/main.typ")).toBe("one\n");
    expect(await trail(p.room)).toEqual([]);
    expect(await new FsConnectorCheckpoints(stateDir).list(p.room)).toEqual([]);
    p.peer.close();
    await c.close();
  });

  it("without a checkpoint or a trail entry nothing is applied: the change waits for review", async () => {
    const p = await autoProject({ "/main.typ": "one\n" });
    const failing = (auto: Partial<NonNullable<ConnectorAppDeps["auto"]>>) =>
      createConnectorApp({ ...autoDeps, auto: { ...autoDeps.auto!, ...auto } });
    for (const [app, why] of [
      [
        failing({ checkpoints: { save: async () => Promise.reject(new Error("disk")) } }),
        /checkpoint could not be saved/,
      ],
      [
        failing({
          activity: {
            read: autoDeps.auto!.activity.read.bind(autoDeps.auto!.activity),
            append: async () => Promise.reject(new Error("disk")),
          },
        }),
        /activity trail could not be written/,
      ],
    ] as const) {
      const c = await client(app, aliceToken);
      const res = JSON.parse((await edit(c, p.projectId, "one", "two")).text);
      expect(res.status).toBe("pending_review");
      expect(res.message).toMatch(why);
      await c.close();
    }
    expect(p.text("/main.typ")).toBe("one\n");
    expect(await trail(p.room)).toEqual([]);
    p.peer.close();
  });

  it("falls back to review past the hourly volume cap", async () => {
    const p = await autoProject({ "/main.typ": "one\n" });
    await new FsConnectorActivityLog(stateDir).append(p.room, {
      version: 1,
      changeId: "earlier",
      state: "started",
      atMs: Date.now(),
      tokenId: aliceTokenId,
      request: "a big one",
      files: [],
      ops: 500,
      bytes: 0,
      checkpointId: `${"0".repeat(13)}-${"a".repeat(64)}`,
    });
    const c = await client(createConnectorApp(autoDeps), aliceToken);
    const res = JSON.parse((await edit(c, p.projectId, "one", "two")).text);
    expect(res.status).toBe("pending_review");
    expect(res.message).toMatch(/already applied a lot/);
    expect(p.text("/main.typ")).toBe("one\n");
    p.peer.close();
    await c.close();
  });

  it("erases a project's checkpoints and trail once it is disconnected", async () => {
    const p = await autoProject({ "/main.typ": "one\n" });
    const c = await client(createConnectorApp(autoDeps), aliceToken);
    await edit(c, p.projectId, "one", "two");
    const sweep = createStateSweep({
      port: 0,
      dataDir,
      syncUrl: `ws://127.0.0.1:${relay.port}`,
      stateDir,
    });
    const checkpoints = new FsConnectorCheckpoints(stateDir);
    await sweep();
    expect(await checkpoints.list(p.room)).toHaveLength(1); // still connected
    const registry = new FsCapabilityRoomRegistry(dataDir);
    await registry.put({ ...(await registry.get(p.room))!, revokedAtMs: Date.now() });
    await sweep();
    expect(await checkpoints.list(p.room)).toEqual([]);
    expect(await trail(p.room)).toEqual([]);
    p.peer.close();
    await c.close();
  });

  it("does not claim a change it cannot find on the server, and records the doubt", async () => {
    const p = await autoProject({ "/main.typ": "one\n" });
    let joins = 0;
    const app = createConnectorApp({
      ...autoDeps,
      withProject: (roomId, fn) => {
        if (++joins > 1) throw new ProjectUnavailableError();
        return autoDeps.withProject(roomId, fn);
      },
    });
    const c = await client(app, aliceToken);
    const res = await edit(c, p.projectId, "one", "two");
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/could not be confirmed on the server/);
    expect((await trail(p.room)).map((e) => e.state)).toEqual(["started", "unconfirmed"]);
    p.peer.close();
    await c.close();
  });
});

it("the token id is known to the service but never sent back", async () => {
  const app = createConnectorApp(deps);
  const res = await post(app, `/mcp/${aliceToken}`);
  const body = await res.text();
  expect(body).not.toContain(aliceToken);
  expect(body).not.toContain(aliceTokenId);
});
