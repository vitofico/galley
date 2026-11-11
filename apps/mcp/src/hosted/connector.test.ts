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
  type WebSocketLike,
} from "@galley/collab";
import {
  FsCapabilityRoomRegistry,
  FsConnectorTokenStore,
  FsSessionStore,
} from "@galley/persistence";
import type { Author, CheckResult } from "@galley/shared";
import { createConnectorApp, type ConnectorAppDeps } from "./app.js";
import { buildConnectorDeps } from "./wiring.js";

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
  return () => {
    connection.destroy();
    project.destroy();
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

let closeSeed: () => void;

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
  await connectRoom(NOVEL, "proj-novel", "alice", { projectName: "My novel" });
  await connectRoom(EMPTY, "proj-empty", "alice");
  await connectRoom(BOBS, "proj-bob", "bob", { reviewMode: "auto" });
  // A peer stays in the room so the open test relay keeps its state; on a
  // real deployment the relay's disk copy plays this part (apps/sync tests).
  closeSeed = await seed(NOVEL, {
    "/main.typ": "= Chapter one\nIt was a dark and stormy night.\n",
    "/notes.typ": "The lighthouse keeper is called Marta.\n",
  });
});

afterAll(async () => {
  closeSeed();
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
    const close = await seed(room, { "/main.typ": "text\n" });
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

it("the token id is known to the service but never sent back", async () => {
  const app = createConnectorApp(deps);
  const res = await post(app, `/mcp/${aliceToken}`);
  const body = await res.text();
  expect(body).not.toContain(aliceToken);
  expect(body).not.toContain(aliceTokenId);
});
