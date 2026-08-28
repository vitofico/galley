import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  projectRoomViolation,
  projectSyncUrlViolation,
  projectGrantViolation,
  registerControlTools,
  buildBrowserCompiler,
  CONTROL_TOOL_LIMITS,
  OPEN_PROJECT_RPC_TIMEOUT_MS,
  type ControlToolDeps,
} from "./control-tools.js";
import type { ControlRpcOutcome } from "./control.js";
import type { KernelSession } from "./session.js";

/**
 * The open_project handoff posture (#16.3a, ADR-0021), pinned pure: the
 * responder is just another peer, so the room id and syncUrl it returns are
 * validated BEFORE the kernel joins anything. These are the rules a hostile
 * responder runs into.
 */

const CONTROL_ROOM = "ctl-0123456789abcdef";
const CONFIGURED = "ws://relay.example:1234";
/** A fixed 32-byte pairing secret for the deps (ADR-0023 §1 proposal signing). */
const RESPONSE_KEY = new Uint8Array(32).fill(7);

describe("projectRoomViolation — the open_project room id gate", () => {
  it.each([
    "share-0c5e9d8a-aaaa-bbbb-cccc-1234567890ab", // mintShareRoom (uuid)
    `share-${"a1".repeat(16)}`, // mintShareRoom (hex fallback)
  ])("accepts the freshly minted share room %s", (room) => {
    expect(projectRoomViolation(room, CONTROL_ROOM)).toBeNull();
  });

  it.each([
    ["proj-12345678-1234-1234-1234-123456789012", /share/], // a stable project id is NOT a capability
    ["share-short", /share/], // too little entropy after the prefix
    ["share-../../../etc/passwd", /share/], // hostile charset
    ["share-room with spaces and length", /share/],
    ["", /share/],
  ])("refuses %s", (room, want) => {
    expect(projectRoomViolation(room, CONTROL_ROOM)).toMatch(want);
  });

  it("refuses the control room itself even if it were share-shaped", () => {
    const shareShaped = `share-${"f".repeat(32)}`;
    expect(projectRoomViolation(shareShaped, shareShaped)).toMatch(/control room/);
  });

  it("refuses an over-length room id", () => {
    expect(
      projectRoomViolation(`share-${"a".repeat(CONTROL_TOOL_LIMITS.maxRoomChars)}`, CONTROL_ROOM),
    ).toMatch(/exceeds/);
  });
});

describe("projectSyncUrlViolation — the open_project relay gate (local-first)", () => {
  it.each([
    "ws://localhost:1234",
    "ws://127.0.0.1:4444", // loopback: any port
    "wss://[::1]:1234",
    "ws://127.8.9.10:1234",
  ])("accepts the loopback relay %s regardless of the configured relay", (url) => {
    expect(projectSyncUrlViolation(url, CONFIGURED)).toBeNull();
  });

  it("accepts EXACTLY the configured relay (same scheme, host, port, path)", () => {
    expect(projectSyncUrlViolation("ws://relay.example:1234", CONFIGURED)).toBeNull();
    expect(projectSyncUrlViolation("ws://relay.example:1234/", CONFIGURED)).toBeNull();
  });

  it.each([
    ["ws://attacker.example:1234", /foreign relay/], // different host
    ["ws://relay.example:9999", /foreign relay/], // different port
    ["wss://relay.example:1234", /foreign relay/], // scheme downgrade/upgrade mismatch
    ["ws://relay.example:1234/other", /foreign relay/], // different path
    ["http://relay.example:1234", /ws:\/\/ or wss:\/\//], // not a websocket URL
    ["ws://user:pass@relay.example:1234", /credentials/],
    ["ws://relay.example:1234?inject=1", /query or fragment/],
    ["ws://relay.example:1234#frag", /query or fragment/],
    ["ws://", /not a valid URL/],
  ])("refuses %s", (url, want) => {
    expect(projectSyncUrlViolation(url, CONFIGURED)).toMatch(want);
  });

  it("refuses an over-length syncUrl before parsing it", () => {
    const huge = `ws://localhost:1234/${"a".repeat(CONTROL_TOOL_LIMITS.maxSyncUrlChars)}`;
    expect(projectSyncUrlViolation(huge, CONFIGURED)).toMatch(/exceeds/);
  });

  it("loopback acceptance also rejects credentialed/query'd URLs (checks compose)", () => {
    expect(projectSyncUrlViolation("ws://u:p@localhost:1234", CONFIGURED)).toMatch(/credentials/);
    expect(projectSyncUrlViolation("ws://localhost:1234?x=1", CONFIGURED)).toMatch(/query/);
  });

  it("the foreign-relay violation DESCRIBES the failure — it quotes neither the offered nor the configured URL (Security round 3)", () => {
    const offered = "ws://attacker.example:6666";
    const violation = projectSyncUrlViolation(offered, CONFIGURED) ?? "";
    expect(violation).toMatch(/foreign relay/);
    expect(violation).not.toContain(offered);
    expect(violation).not.toContain("attacker.example"); // hostile peer text
    expect(violation).not.toContain(CONFIGURED);
    expect(violation).not.toContain("relay.example"); // deployment detail
  });
});

describe("projectGrantViolation — the open_project grantId gate (ADR-0023 §1)", () => {
  it.each([
    "g0aBcDeF1234_-ZyXwVu", // a mintGrantId-shaped base64url token
    "a", // minimal non-empty
    "A-Za-z0-9_-",
  ])("accepts the base64url token %s", (grantId) => {
    expect(projectGrantViolation(grantId)).toBeNull();
  });

  it.each([
    ["", /non-empty/],
    ["a".repeat(CONTROL_TOOL_LIMITS.maxGrantIdChars + 1), /exceeds/],
    ["has a space", /base64url/],
    ["has/slash", /base64url/],
    ["has.dot", /base64url/],
  ])("refuses %s", (grantId, want) => {
    expect(projectGrantViolation(grantId)).toMatch(want);
  });
});

/**
 * A minimal fake McpServer that just CAPTURES the tool callbacks
 * registerControlTools installs, so we can invoke `open_project` directly and
 * inspect the RPC timeout it passes — no client/transport plumbing needed.
 */
function captureControlTools(deps: ControlToolDeps): {
  open: (args: { projectId: string }) => Promise<unknown>;
  create: (args: { name: string }) => Promise<unknown>;
} {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const fakeServer = {
    registerTool: (name: string, _schema: unknown, cb: (args: Record<string, unknown>) => Promise<unknown>) => {
      tools.set(name, cb);
    },
  } as unknown as McpServer;
  registerControlTools(fakeServer, deps);
  return {
    open: (args) => tools.get("open_project")!(args),
    create: (args) => tools.get("create_project")!(args),
  };
}

describe("open_project RPC timeout (#16.3)", () => {
  it("invokes the open_project rpc with the long (120s) human-consent timeout, not the default", async () => {
    const calls: Array<{ op: string; timeoutMs: number | undefined }> = [];
    const rpc = async (
      op: string,
      _params: Record<string, unknown>,
      timeoutMs?: number,
    ): Promise<ControlRpcOutcome> => {
      calls.push({ op, timeoutMs });
      // Refuse so the kernel never tries to join a room (we only assert the wait).
      return { ok: false, error: "declined" };
    };
    const tools = captureControlTools({
      rpc,
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
    });
    await tools.open({ projectId: "proj-1" });
    const openCall = calls.find((c) => c.op === "open_project");
    expect(openCall).toBeDefined();
    expect(openCall!.timeoutMs).toBe(OPEN_PROJECT_RPC_TIMEOUT_MS);
    expect(OPEN_PROJECT_RPC_TIMEOUT_MS).toBe(120_000);
  });

  it("honors an injected openProjectRpcTimeoutMs override", async () => {
    let seen: number | undefined;
    const rpc = async (
      op: string,
      _params: Record<string, unknown>,
      timeoutMs?: number,
    ): Promise<ControlRpcOutcome> => {
      if (op === "open_project") seen = timeoutMs;
      return { ok: false, error: "declined" };
    };
    const tools = captureControlTools({
      rpc,
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
      openProjectRpcTimeoutMs: 5_000,
    });
    await tools.open({ projectId: "proj-1" });
    expect(seen).toBe(5_000);
  });
});

type CreateResultLike = { isError?: boolean; content: { type: string; text: string }[] };

describe("create_project control tool (F1)", () => {
  it("forwards {name} as the rpc params and re-emits the validated {projectId, name}", async () => {
    const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
    const rpc = async (op: string, params: Record<string, unknown>): Promise<ControlRpcOutcome> => {
      calls.push({ op, params });
      return { ok: true, result: { projectId: "proj-x", name: "My Doc" } };
    };
    const t = captureControlTools({
      rpc,
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
    });
    const result = (await t.create({ name: "My Doc" })) as CreateResultLike;
    expect(calls).toEqual([{ op: "create_project", params: { name: "My Doc" } }]);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ projectId: "proj-x", name: "My Doc" });
  });

  it("escapes control characters in the returned name (no faked output lines)", async () => {
    const rpc = async (): Promise<ControlRpcOutcome> => ({
      ok: true,
      result: { projectId: "proj-x", name: "Evil\nName\tHere" },
    });
    const t = captureControlTools({
      rpc,
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
    });
    const result = (await t.create({ name: "ignored" })) as CreateResultLike;
    const name = (JSON.parse(result.content[0]!.text) as { name: string }).name;
    expect(name).not.toContain("\n");
    expect(name).not.toContain("\t");
    expect(name).toContain("\\n");
  });

  it("maps an ok:false rpc outcome to an errorResult", async () => {
    const rpc = async (): Promise<ControlRpcOutcome> => ({ ok: false, error: "timed out" });
    const t = captureControlTools({
      rpc,
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
    });
    const result = (await t.create({ name: "My Doc" })) as CreateResultLike;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/create_project:/);
  });

  it("refuses a malformed rpc result (missing/empty projectId or over-long name) with /invalid response/", async () => {
    const longName = "x".repeat(CONTROL_TOOL_LIMITS.maxNameChars + 1);
    for (const bad of [
      { name: "ok" }, // missing projectId
      { projectId: "", name: "ok" }, // empty projectId
      { projectId: "proj-x", name: longName }, // name over the cap
    ]) {
      const rpc = async (): Promise<ControlRpcOutcome> => ({ ok: true, result: bad });
      const t = captureControlTools({
        rpc,
        configuredSyncUrl: CONFIGURED,
        controlRoom: CONTROL_ROOM,
        responseKey: RESPONSE_KEY,
      });
      const result = (await t.create({ name: "My Doc" })) as CreateResultLike;
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/invalid response/);
    }
  });
});

// ---------------------------------------------------------------------------
// #1 slice 1 — the consent-gated CONTENT tools in control mode.
// ---------------------------------------------------------------------------

type ToolResultLike = { isError?: boolean; content: { type: string; text: string }[] };

/**
 * A duplicate-name-refusing fake McpServer whose registerTool returns a
 * REMOVABLE handle (the real SDK contract), so the retire-on-bind path is
 * observable: a duplicate registration throws exactly like the SDK would.
 */
function captureContentTools(deps: ControlToolDeps): {
  names: () => string[];
  removed: string[];
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResultLike>;
} {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const removed: string[] = [];
  const fakeServer = {
    registerTool: (
      name: string,
      _schema: unknown,
      cb: (args: Record<string, unknown>) => Promise<unknown>,
    ) => {
      if (tools.has(name)) throw new Error(`Tool ${name} is already registered`);
      tools.set(name, cb);
      return {
        remove: () => {
          tools.delete(name);
          removed.push(name);
        },
      };
    },
  } as unknown as McpServer;
  registerControlTools(fakeServer, deps);
  return {
    names: () => [...tools.keys()],
    removed,
    call: async (name, args) => (await tools.get(name)!(args)) as ToolResultLike,
  };
}

const okRpc =
  (record?: Array<{ op: string; params: Record<string, unknown> }>) =>
  async (op: string, params: Record<string, unknown>): Promise<ControlRpcOutcome> => {
    record?.push({ op, params });
    return { ok: true, result: { text: "1| hello from the project", summary: "1 lines" } };
  };

describe("control-mode content tools — registration + dispatch (#1 slice 1)", () => {
  it("control mode registers search_project / list_files / read_file alongside the metadata tools", () => {
    const t = captureContentTools({
      rpc: okRpc(),
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
    });
    for (const name of [
      "list_projects",
      "list_versions",
      "open_project",
      "search_project",
      "list_files",
      "read_file",
      "list_bibliography",
      "list_version_files",
      "read_version_file",
    ]) {
      expect(t.names()).toContain(name);
    }
  });

  it("list_bibliography forwards only {projectId} and re-emits the validated text", async () => {
    const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
    const t = captureContentTools({
      rpc: okRpc(calls),
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
    });
    const result = await t.call("list_bibliography", { projectId: "proj-1" });
    expect(calls).toEqual([{ op: "list_bibliography", params: { projectId: "proj-1" } }]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe("1| hello from the project");
  });

  it("list_bibliography consent-required surfaces the clean 'grant it in Settings' error", async () => {
    const rpc = async (): Promise<ControlRpcOutcome> => ({
      ok: false,
      error: "consent-required: file access for this project has not been granted",
    });
    const t = captureContentTools({
      rpc,
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
    });
    const out = await t.call("list_bibliography", { projectId: "proj-1" });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/Settings → Agent Access/);
  });

  it("read_file forwards {projectId, path} as the mailbox op params and re-emits the validated text", async () => {
    const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
    const t = captureContentTools({
      rpc: okRpc(calls),
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
    });
    const result = await t.call("read_file", { projectId: "proj-1", path: "/main.typ" });
    expect(calls).toEqual([{ op: "read_file", params: { projectId: "proj-1", path: "/main.typ" } }]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe("1| hello from the project");
  });

  it("list_version_files forwards {projectId, versionId} and re-emits the validated {files, truncated}", async () => {
    const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
    const rpc = async (op: string, params: Record<string, unknown>): Promise<ControlRpcOutcome> => {
      calls.push({ op, params });
      return {
        ok: true,
        result: {
          files: [
            { path: "/main.typ", size: 12 },
            { path: "/old.typ", size: 3, secret: "DROP ME" },
          ],
          truncated: false,
          extra: "DROP ME TOO",
        },
      };
    };
    const t = captureContentTools({
      rpc,
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
    });
    const result = await t.call("list_version_files", { projectId: "proj-1", versionId: "v1" });
    expect(calls).toEqual([
      { op: "list_version_files", params: { projectId: "proj-1", versionId: "v1" } },
    ]);
    expect(result.isError).toBeUndefined();
    const json = JSON.parse(result.content[0]!.text) as {
      files: { path: string; size: number }[];
      truncated: boolean;
    };
    expect(json.files).toEqual([
      { path: "/main.typ", size: 12 },
      { path: "/old.typ", size: 3 },
    ]);
    expect(json.truncated).toBe(false);
    // Extra peer fields are dropped, never re-emitted.
    expect(result.content[0]!.text).not.toContain("DROP ME");
  });

  it("read_version_file forwards {projectId, versionId, path} and re-emits the validated text", async () => {
    const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
    const rpc = async (op: string, params: Record<string, unknown>): Promise<ControlRpcOutcome> => {
      calls.push({ op, params });
      return { ok: true, result: { text: "= Title at v1", summary: "DROP" } };
    };
    const t = captureContentTools({
      rpc,
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
    });
    const result = await t.call("read_version_file", {
      projectId: "proj-1",
      versionId: "v1",
      path: "/main.typ",
    });
    expect(calls).toEqual([
      {
        op: "read_version_file",
        params: { projectId: "proj-1", versionId: "v1", path: "/main.typ" },
      },
    ]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe("= Title at v1");
  });

  it("a version-file consent-required refusal surfaces as the clean 'grant it in Settings' error", async () => {
    const rpc = async (): Promise<ControlRpcOutcome> => ({
      ok: false,
      error: "consent-required: file access for this project has not been granted",
    });
    const t = captureContentTools({
      rpc,
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
    });
    const out = await t.call("read_version_file", {
      projectId: "proj-1",
      versionId: "v1",
      path: "/main.typ",
    });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/Settings → Agent Access/);
  });

  it("search_project forwards {projectId, query}; list_files forwards only {projectId}", async () => {
    const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
    const t = captureContentTools({
      rpc: okRpc(calls),
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
    });
    await t.call("search_project", { projectId: "proj-1", query: "hello" });
    await t.call("list_files", { projectId: "proj-1" });
    expect(calls).toEqual([
      { op: "search_project", params: { projectId: "proj-1", query: "hello" } },
      { op: "list_files", params: { projectId: "proj-1" } },
    ]);
  });

  it("a consent-required refusal surfaces as the clean 'grant it in Settings' error", async () => {
    // What the rpc layer actually yields since MEDIUM-3: its LOCAL
    // consent-required line (the verified browser refusal never passes through).
    const rpc = async (): Promise<ControlRpcOutcome> => ({
      ok: false,
      error:
        "consent-required: the browser has not granted file access for this project in this session",
    });
    const t = captureContentTools({
      rpc,
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
    });
    const result = await t.call("read_file", { projectId: "proj-1", path: "/main.typ" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Settings → Agent Access");
    expect(result.content[0]!.text).toContain("Allow file access (this session)");
    expect(result.content[0]!.text).toContain('"proj-1"');
  });

  it("a non-consent refusal is relayed as-is (one honest line)", async () => {
    const rpc = async (): Promise<ControlRpcOutcome> => ({
      ok: false,
      error: "no responder answered 'read_file' within 10000ms — open Galley …",
    });
    const t = captureContentTools({
      rpc,
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
    });
    const result = await t.call("read_file", { projectId: "proj-1", path: "/main.typ" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/^read_file: no responder answered/);
  });

  it.each([
    ["a non-object result", "just a string"],
    ["a result missing text", { summary: "x" }],
    ["an ill-typed text", { text: 42 }],
    ["over-cap text", { text: "x".repeat(CONTROL_TOOL_LIMITS.maxToolTextChars + 1) }],
  ])("%s from the responder is refused, never relayed", async (_name, result) => {
    const rpc = async (): Promise<ControlRpcOutcome> => ({ ok: true, result });
    const t = captureContentTools({
      rpc,
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
    });
    const out = await t.call("read_file", { projectId: "proj-1", path: "/main.typ" });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("invalid response");
  });

  it("control mode registers request_restore_version alongside the metadata + content tools (B3)", () => {
    const t = captureContentTools({
      rpc: okRpc(),
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
    });
    expect(t.names()).toContain("request_restore_version");
  });

  it("request_restore_version forwards {projectId, versionId} and relays {status, proposalId} — NEVER mutates", async () => {
    const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
    const rpc = async (op: string, params: Record<string, unknown>): Promise<ControlRpcOutcome> => {
      calls.push({ op, params });
      return { ok: true, result: { status: "restore_proposed", proposalId: "prop-abc", drop: "X" } };
    };
    const t = captureContentTools({
      rpc,
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
    });
    const out = await t.call("request_restore_version", { projectId: "proj-1", versionId: "v1" });
    // The kernel ONLY triggers the proposal — exactly one control RPC, no join/write.
    expect(calls).toEqual([
      { op: "request_restore_version", params: { projectId: "proj-1", versionId: "v1" } },
    ]);
    expect(out.isError).toBeUndefined();
    const json = JSON.parse(out.content[0]!.text) as { status: string; proposalId: string };
    expect(json.status).toBe("restore_proposed");
    expect(json.proposalId).toBe("prop-abc");
    // Extra peer fields are dropped, never re-emitted.
    expect(out.content[0]!.text).not.toContain("drop");
  });

  it("request_restore_version relays a no_changes status (no proposal minted)", async () => {
    const rpc = async (): Promise<ControlRpcOutcome> => ({ ok: true, result: { status: "no_changes" } });
    const t = captureContentTools({
      rpc,
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
    });
    const out = await t.call("request_restore_version", { projectId: "proj-1", versionId: "v1" });
    expect(out.isError).toBeUndefined();
    const json = JSON.parse(out.content[0]!.text) as { status: string };
    expect(json.status).toBe("no_changes");
  });

  it("request_restore_version consent-required surfaces the clean 'grant it in Settings' error", async () => {
    const rpc = async (): Promise<ControlRpcOutcome> => ({
      ok: false,
      error: "consent-required: file access for this project has not been granted",
    });
    const t = captureContentTools({
      rpc,
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
    });
    const out = await t.call("request_restore_version", { projectId: "proj-1", versionId: "v1" });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/Settings → Agent Access/);
  });

  // C2: the domain outcomes ride on ok:true as STRUCTURED statuses (NOT refusals),
  // each with a kernel-local human message — so they survive the rpc layer's
  // refusal-flattening and the agent can tell them apart.
  it.each([
    ["not_open", /not open/i],
    ["unknown_version", /no such version/i],
    ["too_large", /too large/i],
    ["conflict", /duplicate|ambiguous/i],
  ])("request_restore_version relays the %s status (ok, not an error) with a helpful message", async (status, wantMsg) => {
    const rpc = async (): Promise<ControlRpcOutcome> => ({ ok: true, result: { status } });
    const t = captureContentTools({
      rpc,
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
    });
    const out = await t.call("request_restore_version", { projectId: "proj-1", versionId: "v1" });
    // NOT an error result — a structured status the agent can branch on.
    expect(out.isError).toBeUndefined();
    const json = JSON.parse(out.content[0]!.text) as { status: string; message: string };
    expect(json.status).toBe(status);
    expect(json.message).toMatch(wantMsg);
    // A non-proposed status never carries a proposalId.
    expect(JSON.parse(out.content[0]!.text)).not.toHaveProperty("proposalId");
  });

  it.each([
    ["a non-object result", "just a string"],
    ["a missing status", { proposalId: "p" }],
    ["an ill-typed status", { status: 42 }],
    ["an unknown status", { status: "applied_directly" }],
  ])("an invalid request_restore_version result (%s) is refused, never relayed", async (_n, result) => {
    const rpc = async (): Promise<ControlRpcOutcome> => ({ ok: true, result });
    const t = captureContentTools({
      rpc,
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
    });
    const out = await t.call("request_restore_version", { projectId: "proj-1", versionId: "v1" });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("invalid response");
  });

  it("a successful open_project RETIRES the content tools before registering the per-project set", async () => {
    const rpc = async (op: string): Promise<ControlRpcOutcome> => {
      if (op === "open_project") {
        return {
          ok: true,
          result: {
            syncUrl: "ws://localhost:1234",
            room: `share-${"a1".repeat(16)}`,
            projectId: "proj-1",
            mainFile: "/main.typ",
            grantId: "g0aBcDeF1234_-ZyXwVu",
          },
        };
      }
      return { ok: false, error: "unexpected op" };
    };
    const fakeSession = {
      surface: { filePath: "/main.typ" },
      whenFileReady: async () => undefined,
      destroy: () => undefined,
    } as unknown as KernelSession;
    const t = captureContentTools({
      rpc,
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
      joinProject: () => fakeSession,
      projectReadyTimeoutMs: 100,
    });
    const result = await t.call("open_project", { projectId: "proj-1" });
    expect(result.isError).not.toBe(true);
    // The content tools were removed (so the duplicate-refusing fake did not
    // throw when the per-project tools claimed list_files / read_file)…
    expect(t.removed.sort()).toEqual([
      "list_bibliography",
      "list_files",
      "list_version_files",
      "read_file",
      "read_version_file",
      "request_restore_version",
      "search_project",
    ]);
    // …and the per-project tools are registered in their place.
    for (const name of ["read_document", "list_files", "read_file", "project_context", "propose_edit", "propose_files", "compile"]) {
      expect(t.names()).toContain(name);
    }
    expect(t.names()).not.toContain("search_project");
    // list_bibliography has NO per-project equivalent (accepted asymmetry) — it is
    // retired on bind and does not come back on the per-project surface.
    expect(t.names()).not.toContain("list_bibliography");
    expect(t.names()).not.toContain("list_version_files");
    expect(t.names()).not.toContain("read_version_file");
    expect(t.names()).not.toContain("request_restore_version");
  });

  it("open_project binds the responder's grantId onto the joined session (ADR-0023 §1)", async () => {
    const GRANT = "g0aBcDeF1234_-ZyXwVu";
    const rpc = async (op: string): Promise<ControlRpcOutcome> => {
      if (op === "open_project") {
        return {
          ok: true,
          result: {
            syncUrl: "ws://localhost:1234",
            room: `share-${"a1".repeat(16)}`,
            projectId: "proj-1",
            mainFile: "/main.typ",
            grantId: GRANT,
          },
        };
      }
      return { ok: false, error: "unexpected op" };
    };
    let joinedWith:
      | { grantId: string; controlRoom: string; projectId: string; responseKey: Uint8Array }
      | undefined;
    const fakeSession = {
      surface: { filePath: "/main.typ" },
      whenFileReady: async () => undefined,
      destroy: () => undefined,
    } as unknown as KernelSession;
    const t = captureContentTools({
      rpc,
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
      joinProject: (config) => {
        joinedWith = config;
        return fakeSession;
      },
      projectReadyTimeoutMs: 100,
    });
    const result = await t.call("open_project", { projectId: "proj-1" });
    expect(result.isError).not.toBe(true);
    // The kernel joins the room CARRYING the full signing scope — Task 4 derives
    // the per-grant signing key from these: grantId + controlRoom + projectId +
    // the pairing secret (responseKey), plus syncUrl/room from the handoff.
    expect(joinedWith?.grantId).toBe(GRANT);
    expect(joinedWith?.controlRoom).toBe(CONTROL_ROOM);
    expect(joinedWith?.projectId).toBe("proj-1");
    expect(joinedWith?.responseKey).toBe(RESPONSE_KEY);
  });

  it("open_project refuses a bad-charset grantId from the responder (fail closed, no join)", async () => {
    const rpc = async (op: string): Promise<ControlRpcOutcome> => {
      if (op === "open_project") {
        return {
          ok: true,
          result: {
            syncUrl: "ws://localhost:1234",
            room: `share-${"a1".repeat(16)}`,
            projectId: "proj-1",
            mainFile: "/main.typ",
            grantId: "has a space",
          },
        };
      }
      return { ok: false, error: "unexpected op" };
    };
    let joined = false;
    const t = captureContentTools({
      rpc,
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
      joinProject: () => {
        joined = true;
        return {
          surface: { filePath: "/main.typ" },
          whenFileReady: async () => undefined,
          destroy: () => undefined,
        } as unknown as KernelSession;
      },
      projectReadyTimeoutMs: 100,
    });
    const result = await t.call("open_project", { projectId: "proj-1" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/grantId/);
    expect(joined).toBe(false); // never joined a room with a malformed grant
  });

  // --- F9/F5: open_project wires the browser-routed compile seam ----------------
  // The per-project `compile` tool routes through the BROWSER when (and only when)
  // no loopback compileService is configured. Driven via the fake rpc.

  const openProjectRpc =
    (extra?: (op: string, params: Record<string, unknown>) => ControlRpcOutcome | undefined) =>
    async (op: string, params: Record<string, unknown>): Promise<ControlRpcOutcome> => {
      if (op === "open_project") {
        return {
          ok: true,
          result: {
            syncUrl: "ws://localhost:1234",
            room: `share-${"a1".repeat(16)}`,
            projectId: "proj-1",
            mainFile: "/main.typ",
            grantId: "g0aBcDeF1234_-ZyXwVu",
          },
        };
      }
      const handled = extra?.(op, params);
      if (handled !== undefined) return handled;
      return { ok: false, error: "unexpected op" };
    };

  const fakeJoinSession = (): KernelSession =>
    ({
      surface: { filePath: "/main.typ", compileInput: () => "= doc\nbody" },
      whenFileReady: async () => undefined,
      liveness: () => ({ state: "watched" }),
      destroy: () => undefined,
    }) as unknown as KernelSession;

  it("open_project wires a browser-routed compile when NO loopback service is configured", async () => {
    const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
    const rpc = openProjectRpc((op, params) => {
      if (op === "compile") {
        calls.push({ op, params });
        return { ok: true, result: { ok: true, pageCount: 2, diagnostics: [] } };
      }
      return undefined;
    });
    const t = captureContentTools({
      rpc,
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
      joinProject: fakeJoinSession,
      projectReadyTimeoutMs: 100,
      // NO compileService → the browser fallback is wired.
    });
    const opened = await t.call("open_project", { projectId: "proj-1" });
    expect(opened.isError).not.toBe(true);
    const result = await t.call("compile", {});
    expect(result.isError).not.toBe(true);
    // The compile RPC went to the browser for the BOUND project.
    expect(calls).toEqual([{ op: "compile", params: { projectId: "proj-1" } }]);
    const payload = JSON.parse(result.content[0]!.text) as {
      status: string;
      source: string;
      ok: boolean;
      pageCount: number | null;
    };
    expect(payload.status).toBe("ok");
    expect(payload.source).toBe("browser");
    expect(payload.ok).toBe(true);
    expect(payload.pageCount).toBe(2);
  });

  it("open_project does NOT wire the browser compile when a loopback service is provided (loopback wins)", async () => {
    let browserCompileCalls = 0;
    const rpc = openProjectRpc((op) => {
      if (op === "compile") {
        browserCompileCalls += 1;
        return { ok: true, result: { ok: true, pageCount: 9, diagnostics: [] } };
      }
      return undefined;
    });
    const loopback = {
      check: async () => ({ ok: true, diagnostics: [], pageCount: 1, durationMs: 1 }),
    };
    const t = captureContentTools({
      rpc,
      configuredSyncUrl: CONFIGURED,
      controlRoom: CONTROL_ROOM,
      responseKey: RESPONSE_KEY,
      joinProject: fakeJoinSession,
      projectReadyTimeoutMs: 100,
      compileService: loopback,
    });
    await t.call("open_project", { projectId: "proj-1" });
    const result = await t.call("compile", {});
    const payload = JSON.parse(result.content[0]!.text) as { status: string; source: string; pageCount: number | null };
    expect(payload.status).toBe("ok");
    expect(payload.source).toBe("loopback");
    expect(payload.pageCount).toBe(1);
    // The loopback service answered — the browser RPC was never sent.
    expect(browserCompileCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildBrowserCompiler (F9/F5) — the kernel-side seam that asks the browser to
// relay its live-preview diagnostics over the control RPC. PURE around the rpc.
// ---------------------------------------------------------------------------

describe("buildBrowserCompiler (F9/F5)", () => {
  it("relays the validated, control-char-escaped diagnostics on the happy path", async () => {
    const seen: Array<{ op: string; params: Record<string, unknown> }> = [];
    const rpc = async (op: string, params: Record<string, unknown>): Promise<ControlRpcOutcome> => {
      seen.push({ op, params });
      return {
        ok: true,
        result: { ok: true, pageCount: 2, diagnostics: [{ severity: "warning", message: "x" }] },
      };
    };
    const compile = buildBrowserCompiler({ rpc, projectId: "proj-7" });
    const out = await compile();
    expect(seen).toEqual([{ op: "compile", params: { projectId: "proj-7" } }]);
    expect(out).toEqual({
      ok: true,
      pageCount: 2,
      diagnostics: [{ severity: "warning", message: "x" }],
    });
  });

  it("returns {error} when the rpc itself fails (refusal / timeout)", async () => {
    const rpc = async (): Promise<ControlRpcOutcome> => ({ ok: false, error: "timeout" });
    const out = await buildBrowserCompiler({ rpc, projectId: "proj-1" })();
    expect(out).toEqual({ error: "timeout" });
  });

  it("returns a generic error when the browser result does not parse (missing diagnostics)", async () => {
    const rpc = async (): Promise<ControlRpcOutcome> => ({
      ok: true,
      result: { ok: true, pageCount: 1 },
    });
    const out = await buildBrowserCompiler({ rpc, projectId: "proj-1" })();
    expect(out).toEqual({ error: "the browser returned an invalid compile result" });
  });

  it("slices a diagnostics array over the cap", async () => {
    const huge = Array.from({ length: CONTROL_TOOL_LIMITS.maxDiagnostics + 50 }, () => ({
      severity: "warning" as const,
      message: "noise",
    }));
    const rpc = async (): Promise<ControlRpcOutcome> => ({
      ok: true,
      result: { ok: false, pageCount: null, diagnostics: huge },
    });
    const out = await buildBrowserCompiler({ rpc, projectId: "proj-1" })();
    expect("error" in out!).toBe(false);
    if ("error" in out! || "unavailable" in out!) throw new Error("unexpected");
    expect(out.diagnostics).toHaveLength(CONTROL_TOOL_LIMITS.maxDiagnostics);
  });

  it("escapes embedded newlines / control chars in a diagnostic message", async () => {
    const rpc = async (): Promise<ControlRpcOutcome> => ({
      ok: true,
      result: {
        ok: false,
        pageCount: null,
        diagnostics: [{ severity: "error", message: "line one\nline two\tindented" }],
      },
    });
    const out = await buildBrowserCompiler({ rpc, projectId: "proj-1" })();
    if ("error" in out! || "unavailable" in out!) throw new Error("unexpected");
    expect(out.diagnostics[0]!.message).not.toContain("\n");
    expect(out.diagnostics[0]!.message).not.toContain("\t");
  });
});

// ---------------------------------------------------------------------------
// export_compiled (A1) — the kernel side of the handshake.
// ---------------------------------------------------------------------------

import {
  registerExportCompiledTool,
  type ExportCompiledToolDeps,
} from "./control-tools.js";
import type { KernelBlobSession } from "./blob-session.js";
import type { ReceivedBlob } from "@galley/collab";

/** A capture server scoped to the export tool only. */
function captureExportTool(deps: ExportCompiledToolDeps): {
  exportCompiled: () => Promise<{ content: { text: string }[]; isError?: boolean }>;
} {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const fakeServer = {
    registerTool: (name: string, _schema: unknown, cb: (args: Record<string, unknown>) => Promise<unknown>) => {
      tools.set(name, cb);
    },
  } as unknown as McpServer;
  registerExportCompiledTool(fakeServer, deps);
  return {
    exportCompiled: () =>
      tools.get("export_compiled")!({}) as Promise<{ content: { text: string }[]; isError?: boolean }>,
  };
}

/**
 * A fake KernelBlobSession for the export tool: an in-memory buffer keyed by
 * transferId, an `onBlob` fan-out, and the reservation bookkeeping the tool drives.
 * `deliver(transferId, blob)` simulates the browser's push landing.
 */
function fakeBlobSession(): KernelBlobSession & {
  deliver: (blob: ReceivedBlob) => void;
  reservations: () => string[];
  connected: () => boolean;
  bufferedIds: () => string[];
  hashBufferedHashes: () => string[];
} {
  const reserved = new Set<string>();
  const buffered = new Map<string, ReceivedBlob>(); // transferId → blob
  // F11: a real hash-keyed buffer so retainBlob / takeBlob / hasBlob behave like
  // the production session (export_compiled now retains the artifact for save_artifact).
  const hashBuffer = new Map<string, ReceivedBlob>(); // hash → blob
  const subs = new Set<(b: ReceivedBlob) => void>();
  let connected = false;
  const session = {
    putBlob: async () => ({ hash: "", size: 0 }),
    expect: () => true,
    unexpect: () => {},
    expectTransfer: (transferId: string) => {
      reserved.add(transferId);
      return true;
    },
    unexpectTransfer: (transferId: string) => {
      // Mirror the real session: withdrawing a reservation DRAINS any delivered
      // candidate (no orphan) and frees the reservation (rd-A1 §4).
      reserved.delete(transferId);
      buffered.delete(transferId);
    },
    takeBlobByTransfer: (transferId: string) => {
      const b = buffered.get(transferId);
      if (b) buffered.delete(transferId);
      return b;
    },
    peekBlobByTransfer: (transferId: string) => buffered.get(transferId),
    // Faithful mirror of the real candidate/promote loop (rd-A1 §2): a MATCH
    // resolves (left buffered for the caller to take); a MISMATCH is discarded and
    // the wait continues until the deadline; the reservation is NOT touched here.
    awaitMatchingCandidate: (
      transferId: string,
      match: (b: ReceivedBlob) => boolean,
      timeoutMs: number,
    ): Promise<ReceivedBlob | undefined> =>
      new Promise((resolve) => {
        let settled = false;
        let off: (() => void) | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (v: ReceivedBlob | undefined): void => {
          if (settled) return;
          settled = true;
          off?.();
          if (timer !== undefined) clearTimeout(timer);
          resolve(v);
        };
        const consider = (b: ReceivedBlob): void => {
          if (match(b)) {
            finish(b);
            return;
          }
          if (buffered.get(transferId) === b) buffered.delete(transferId);
        };
        const sub = (b: ReceivedBlob): void => {
          if (b.transferId === transferId) consider(b);
        };
        subs.add(sub);
        off = () => subs.delete(sub);
        timer = setTimeout(() => finish(undefined), timeoutMs);
        const already = buffered.get(transferId);
        if (already !== undefined) consider(already);
      }),
    onBlob: (cb: (b: ReceivedBlob) => void) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    takeBlob: (hash: string) => {
      const b = hashBuffer.get(hash);
      if (b) hashBuffer.delete(hash);
      return b;
    },
    retainBlob: (blob: ReceivedBlob) => {
      if (hashBuffer.has(blob.hash)) return true;
      hashBuffer.set(blob.hash, blob);
      return true;
    },
    hasBlob: (hash: string) => hashBuffer.has(hash),
    bufferedCount: 0,
    enabled: connected,
    connect: () => {
      connected = true;
    },
    destroy: () => {},
    deliver: (blob: ReceivedBlob) => {
      buffered.set(blob.transferId!, blob);
      for (const cb of [...subs]) cb(blob);
    },
    reservations: () => [...reserved],
    connected: () => connected,
    bufferedIds: () => [...buffered.keys()],
    hashBufferedHashes: () => [...hashBuffer.keys()],
  };
  return session as unknown as KernelBlobSession & {
    deliver: (blob: ReceivedBlob) => void;
    reservations: () => string[];
    connected: () => boolean;
    bufferedIds: () => string[];
    hashBufferedHashes: () => string[];
  };
}

describe("export_compiled (A1) — the kernel both-must-match handshake", () => {
  const MINT = "deadbeefdeadbeefdeadbeefdeadbeef";
  const HASH = "a".repeat(64);

  it("SUCCEEDS when the signed descriptor and the received blob match", async () => {
    const blob = fakeBlobSession();
    const rpc = async (op: string, params: Record<string, unknown>): Promise<ControlRpcOutcome> => {
      expect(op).toBe("export_compiled");
      expect(params["transferId"]).toBe(MINT);
      // Simulate the browser pushing the bytes under the SAME transferId BEFORE it
      // returns the descriptor (the reservation is already live).
      blob.deliver({ bytes: new Uint8Array([1, 2, 3]), hash: HASH, size: 3, mime: "application/pdf", transferId: MINT });
      return { ok: true, result: { transferId: MINT, hash: HASH, size: 3, mime: "application/pdf" } };
    };
    const { exportCompiled } = captureExportTool({ rpc, blob, projectId: "p", mintTransferId: () => MINT });
    const res = await exportCompiled();
    expect(blob.connected()).toBe(true);
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(res.content[0]!.text);
    expect(out).toMatchObject({ status: "exported", hash: HASH, size: 3, mime: "application/pdf" });
    // Success leaves NO orphan + NO live reservation.
    expect(blob.bufferedIds()).toEqual([]);
    expect(blob.reservations()).toEqual([]);
  });

  it("DISCARDS a wrong-hash candidate, keeps waiting, and FAILS CLOSED at the deadline if no match arrives", async () => {
    const blob = fakeBlobSession();
    const rpc = async (): Promise<ControlRpcOutcome> => {
      // A forged candidate whose hash does NOT match the signed descriptor.
      blob.deliver({ bytes: new Uint8Array([9]), hash: "b".repeat(64), size: 1, mime: "application/pdf", transferId: MINT });
      return { ok: true, result: { transferId: MINT, hash: HASH, size: 3, mime: "application/pdf" } };
    };
    const { exportCompiled } = captureExportTool({
      rpc,
      blob,
      projectId: "p",
      mintTransferId: () => MINT,
      timeoutMs: 30,
    });
    const res = await exportCompiled();
    expect(res.isError).toBe(true);
    // No matching candidate by the deadline → the deadline message (not a final
    // mismatch); the forged candidate was discarded along the way.
    expect(res.content[0]!.text).toMatch(/not received within the deadline/);
    // No orphan + the reservation freed.
    expect(blob.bufferedIds()).toEqual([]);
    expect(blob.reservations()).toEqual([]);
  });

  it("FAILS CLOSED + releases the reservation on an RPC refusal", async () => {
    const blob = fakeBlobSession();
    const rpc = async (): Promise<ControlRpcOutcome> => ({ ok: false, error: "consent-required" });
    const { exportCompiled } = captureExportTool({ rpc, blob, projectId: "p", mintTransferId: () => MINT });
    const res = await exportCompiled();
    expect(res.isError).toBe(true);
    expect(blob.reservations()).toEqual([]); // released
  });

  it("FAILS CLOSED + releases the reservation on a timeout (no blob arrives)", async () => {
    const blob = fakeBlobSession();
    // The RPC resolves with a valid descriptor but the bytes never arrive.
    const rpc = async (): Promise<ControlRpcOutcome> => ({
      ok: true,
      result: { transferId: MINT, hash: HASH, size: 3, mime: "application/pdf" },
    });
    const { exportCompiled } = captureExportTool({
      rpc,
      blob,
      projectId: "p",
      mintTransferId: () => MINT,
      timeoutMs: 30,
    });
    const res = await exportCompiled();
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/not received within the deadline/);
    expect(blob.reservations()).toEqual([]); // released
  });

  it("REFUSES a responder that echoes a DIFFERENT transferId", async () => {
    const blob = fakeBlobSession();
    const rpc = async (): Promise<ControlRpcOutcome> => ({
      ok: true,
      result: { transferId: "other-id", hash: HASH, size: 3, mime: "application/pdf" },
    });
    const { exportCompiled } = captureExportTool({ rpc, blob, projectId: "p", mintTransferId: () => MINT });
    const res = await exportCompiled();
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/different transfer/);
    expect(blob.reservations()).toEqual([]);
  });

  it("DISCARDS a wrong-mime candidate and fails closed at the deadline (rd-A1 §6)", async () => {
    const blob = fakeBlobSession();
    const rpc = async (): Promise<ControlRpcOutcome> => {
      // The bytes arrive with a DIFFERENT mime than the signed descriptor declared.
      blob.deliver({ bytes: new Uint8Array([1, 2, 3]), hash: HASH, size: 3, mime: "text/plain", transferId: MINT });
      return { ok: true, result: { transferId: MINT, hash: HASH, size: 3, mime: "application/pdf" } };
    };
    const { exportCompiled } = captureExportTool({
      rpc,
      blob,
      projectId: "p",
      mintTransferId: () => MINT,
      timeoutMs: 30,
    });
    const res = await exportCompiled();
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/not received within the deadline/);
    expect(blob.bufferedIds()).toEqual([]); // discarded, no orphan
  });

  it("DELIVERED-then-RPC-FAILS leaves NO orphan (rd-A1 §4)", async () => {
    const blob = fakeBlobSession();
    const rpc = async (): Promise<ControlRpcOutcome> => {
      // A (forged) candidate is already buffered BEFORE the RPC refuses.
      blob.deliver({ bytes: new Uint8Array([5]), hash: HASH, size: 1, mime: "application/pdf", transferId: MINT });
      return { ok: false, error: "declined" };
    };
    const { exportCompiled } = captureExportTool({ rpc, blob, projectId: "p", mintTransferId: () => MINT });
    const res = await exportCompiled();
    expect(res.isError).toBe(true);
    // The buffered candidate is drained on the failure exit — no orphan, no reservation.
    expect(blob.bufferedIds()).toEqual([]);
    expect(blob.reservations()).toEqual([]);
  });

  it("rejects a non-application/pdf descriptor mime (schema literal)", async () => {
    const blob = fakeBlobSession();
    const rpc = async (): Promise<ControlRpcOutcome> => ({
      ok: true,
      result: { transferId: MINT, hash: HASH, size: 3, mime: "text/plain" },
    });
    const { exportCompiled } = captureExportTool({ rpc, blob, projectId: "p", mintTransferId: () => MINT });
    const res = await exportCompiled();
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/invalid response/);
    expect(blob.reservations()).toEqual([]);
  });

  it("PROMOTES the real candidate after a forged early one (candidate loop, rd-A1 §2)", async () => {
    const blob = fakeBlobSession();
    const rpc = async (): Promise<ControlRpcOutcome> => {
      // A 3rd peer's FORGED candidate lands FIRST (wrong hash) …
      blob.deliver({ bytes: new Uint8Array([9]), hash: "b".repeat(64), size: 1, mime: "application/pdf", transferId: MINT });
      // … then the REAL browser's candidate matching the descriptor arrives.
      blob.deliver({ bytes: new Uint8Array([1, 2, 3]), hash: HASH, size: 3, mime: "application/pdf", transferId: MINT });
      return { ok: true, result: { transferId: MINT, hash: HASH, size: 3, mime: "application/pdf" } };
    };
    const { exportCompiled } = captureExportTool({ rpc, blob, projectId: "p", mintTransferId: () => MINT });
    const res = await exportCompiled();
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ status: "exported", hash: HASH, size: 3 });
    expect(blob.bufferedIds()).toEqual([]); // promoted (taken) + reservation withdrawn
    expect(blob.reservations()).toEqual([]);
  });

  it("PROMOTES the real candidate arriving LATE, after several forged ones, before the deadline", async () => {
    const blob = fakeBlobSession();
    const rpc = async (): Promise<ControlRpcOutcome> => {
      // Several forged candidates trickle in; the wait must keep the reservation live.
      blob.deliver({ bytes: new Uint8Array([1]), hash: "c".repeat(64), size: 1, mime: "application/pdf", transferId: MINT });
      blob.deliver({ bytes: new Uint8Array([2]), hash: "d".repeat(64), size: 1, mime: "application/pdf", transferId: MINT });
      // The real one arrives ~10ms later (well inside the 200ms budget).
      setTimeout(
        () => blob.deliver({ bytes: new Uint8Array([1, 2, 3]), hash: HASH, size: 3, mime: "application/pdf", transferId: MINT }),
        10,
      );
      return { ok: true, result: { transferId: MINT, hash: HASH, size: 3, mime: "application/pdf" } };
    };
    const { exportCompiled } = captureExportTool({
      rpc,
      blob,
      projectId: "p",
      mintTransferId: () => MINT,
      timeoutMs: 200,
    });
    const res = await exportCompiled();
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ status: "exported", hash: HASH });
    expect(blob.reservations()).toEqual([]);
  });

  it("RETAINS the artifact in the hash-keyed buffer for save_artifact", async () => {
    const blob = fakeBlobSession();
    const rpc = async (): Promise<ControlRpcOutcome> => {
      blob.deliver({ bytes: new Uint8Array([1, 2, 3]), hash: HASH, size: 3, mime: "application/pdf", transferId: MINT });
      return { ok: true, result: { transferId: MINT, hash: HASH, size: 3, mime: "application/pdf" } };
    };
    const { exportCompiled } = captureExportTool({ rpc, blob, projectId: "p", mintTransferId: () => MINT });
    const res = await exportCompiled();
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(res.content[0]!.text);
    expect(out.note).toMatch(/save_artifact/);
    // The bytes are pinned in the hash-keyed buffer, ready for save_artifact.
    expect(blob.hasBlob(HASH)).toBe(true);
    expect(blob.hashBufferedHashes()).toEqual([HASH]);
  });
});

// ---------------------------------------------------------------------------
// save_artifact (F11) — write held artifact bytes to local disk.
// ---------------------------------------------------------------------------

import {
  registerSaveArtifactTool,
  type SaveArtifactToolDeps,
  SAVE_ARTIFACT_MAX_PATH_CHARS,
} from "./control-tools.js";

/** A capture server scoped to the save_artifact tool only. */
function captureSaveArtifactTool(deps: SaveArtifactToolDeps): {
  saveArtifact: (args: { hash: string; destPath: string }) => Promise<{
    content: { text: string }[];
    isError?: boolean;
  }>;
} {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const fakeServer = {
    registerTool: (name: string, _schema: unknown, cb: (args: Record<string, unknown>) => Promise<unknown>) => {
      tools.set(name, cb);
    },
  } as unknown as McpServer;
  registerSaveArtifactTool(fakeServer, deps);
  return {
    saveArtifact: (args) =>
      tools.get("save_artifact")!(args) as Promise<{ content: { text: string }[]; isError?: boolean }>,
  };
}

/**
 * A fake KernelBlobSession with a REAL hash-keyed buffer (retainBlob/takeBlob/
 * hasBlob), mirroring the production session's hash path — enough for save_artifact
 * which only touches that path. The transfer/expect surface is inert here.
 */
function fakeHashBlobSession(): KernelBlobSession & {
  seed: (blob: ReceivedBlob) => void;
} {
  const hashBuffer = new Map<string, ReceivedBlob>();
  const session = {
    putBlob: async () => ({ hash: "", size: 0 }),
    expect: () => true,
    unexpect: () => {},
    expectTransfer: () => true,
    unexpectTransfer: () => {},
    takeBlobByTransfer: () => undefined,
    peekBlobByTransfer: () => undefined,
    awaitMatchingCandidate: async () => undefined,
    onBlob: () => () => {},
    takeBlob: (hash: string) => {
      const b = hashBuffer.get(hash);
      if (b) hashBuffer.delete(hash);
      return b;
    },
    retainBlob: (blob: ReceivedBlob) => {
      if (hashBuffer.has(blob.hash)) return true;
      hashBuffer.set(blob.hash, blob);
      return true;
    },
    hasBlob: (hash: string) => hashBuffer.has(hash),
    bufferedCount: 0,
    enabled: true,
    connect: () => {},
    destroy: () => {},
    seed: (blob: ReceivedBlob) => hashBuffer.set(blob.hash, blob),
  };
  return session as unknown as KernelBlobSession & { seed: (blob: ReceivedBlob) => void };
}

describe("save_artifact (F11) — write held artifact bytes to local disk", () => {
  const HASH = "c".repeat(64);
  const DEST = "/tmp/galley-export.pdf";
  const BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"

  const heldBlob = (): ReceivedBlob => ({ bytes: BYTES, hash: HASH, size: BYTES.length, mime: "application/pdf" });

  it("SAVES the held bytes to destPath and CONSUMES the hold", async () => {
    const blob = fakeHashBlobSession();
    blob.seed(heldBlob());
    const captured: { path?: string; data?: Uint8Array } = {};
    const writeFile = async (path: string, data: Uint8Array): Promise<void> => {
      captured.path = path;
      captured.data = data;
    };
    const { saveArtifact } = captureSaveArtifactTool({ blob, writeFile });

    const res = await saveArtifact({ hash: HASH, destPath: DEST });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text)).toEqual({ status: "saved", path: DEST, size: BYTES.length });
    expect(captured.path).toBe(DEST);
    expect(captured.data).toEqual(BYTES);

    // The hold is CONSUMED — a second save with the same hash fails closed.
    const second = await saveArtifact({ hash: HASH, destPath: DEST });
    expect(second.isError).toBe(true);
    expect(second.content[0]!.text).toMatch(/run export_compiled first/);
  });

  it("FAILS CLOSED on an unknown hash and never writes", async () => {
    const blob = fakeHashBlobSession(); // nothing seeded
    let wrote = false;
    const writeFile = async (): Promise<void> => {
      wrote = true;
    };
    const { saveArtifact } = captureSaveArtifactTool({ blob, writeFile });

    const res = await saveArtifact({ hash: HASH, destPath: DEST });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/run export_compiled first/);
    expect(wrote).toBe(false);
  });

  it("FAILS CLOSED on an unwritable destPath and RE-PINS the bytes for a retry", async () => {
    const blob = fakeHashBlobSession();
    blob.seed(heldBlob());
    let attempts = 0;
    const captured: { data?: Uint8Array } = {};
    const writeFile = async (_path: string, data: Uint8Array): Promise<void> => {
      attempts += 1;
      if (attempts === 1) throw new Error("EACCES: permission denied, open '/root/x.pdf'");
      captured.data = data;
    };
    const { saveArtifact } = captureSaveArtifactTool({ blob, writeFile });

    const res = await saveArtifact({ hash: HASH, destPath: "/root/x.pdf" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/could not write/);
    // The bytes are RE-PINNED so the agent can retry with a writable path.
    expect(blob.hasBlob(HASH)).toBe(true);

    const retry = await saveArtifact({ hash: HASH, destPath: DEST });
    expect(retry.isError).toBeFalsy();
    expect(JSON.parse(retry.content[0]!.text)).toEqual({ status: "saved", path: DEST, size: BYTES.length });
    expect(captured.data).toEqual(BYTES);
  });

  it("exports SAVE_ARTIFACT_MAX_PATH_CHARS as a sane cap", () => {
    expect(SAVE_ARTIFACT_MAX_PATH_CHARS).toBe(4096);
  });
});
