import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Author, CheckResult, CompileInput } from "@galley/shared";
import {
  CollabProject,
  PROPOSAL_LIMITS,
  getPendingProposals,
  getPendingFileProposals,
  getFileProposal,
  resolveProposal,
  resolveFileProposal,
  FILE_PROPOSAL_LIMITS,
  sha256Hex,
  type ProposalSigner,
} from "@galley/collab";
import {
  GALLEY_MCP_SERVER_VERSION,
  createGalleyMcpServer,
  registerProjectTools,
  type KernelTools,
  type ProjectAttachment,
} from "./server.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READ_LIMITS, createToolSurface } from "./surface.js";
import { writeFile as fsWriteFile, rm as fsRm, open as fsOpen } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const HUMAN: Author = { kind: "human", userId: "u1" };
const MCP: Author = { kind: "agent", runId: "mcp" };

/** Drive a kernel server over a real (in-memory) MCP transport pair. */
async function connectedClient(tools?: KernelTools) {
  const server = createGalleyMcpServer(tools);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "galley-mcp-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** A local project + the wrapped tool surface over its /main.typ. */
function projectFixture(text = "= Title\nbody\n") {
  const project = new CollabProject();
  project.create("/main.typ", text, HUMAN);
  const surface = createToolSurface(project, "/main.typ", MCP);
  return { project, surface };
}

/**
 * A SIGNED (auto-accept-eligible) surface: a trivial echo signer makes the
 * session look like a paired grant, so propose_* awaits the browser's verdict
 * (ADR-0023). The signer asserts wiring only — crypto is covered elsewhere.
 */
function signedFixture(text = "= Title\nbody\n") {
  const project = new CollabProject();
  project.create("/main.typ", text, HUMAN);
  const signer: ProposalSigner = async (_signable, mailbox) =>
    mailbox === "mcpProposals" ? "AAAA" : "BBBB";
  const surface = createToolSurface(project, "/main.typ", MCP, signer);
  return { project, surface };
}

function firstText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  const first = content?.[0];
  expect(first?.type).toBe("text");
  return first?.text ?? "";
}

/**
 * Drive a server whose per-project tools are registered ONCE over a MUTABLE
 * attachment provider (ADR-0024 §2): the static tool surface. The harness lets a
 * test attach / detach a project and simulate a reconnect, then inspect the tool
 * list + idle behavior.
 */
async function staticSurfaceClient(provider: () => ProjectAttachment | undefined) {
  const server = new McpServer({ name: "galley", version: GALLEY_MCP_SERVER_VERSION });
  registerProjectTools(server, provider);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "static-surface-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("galley mcp kernel — static tool surface (ADR-0024 §2)", () => {
  const PER_PROJECT = [
    "compile",
    "list_files",
    "project_context",
    "propose_edit",
    "propose_files",
    "read_document",
    "read_file",
  ];

  it("a per-project tool with NO project attached returns a structured no_project_attached (not a throw, not a missing tool)", async () => {
    const client = await staticSurfaceClient(() => undefined);
    const { tools } = await client.listTools();
    // The tools are REGISTERED even with no project — they never vanish.
    expect(tools.map((t) => t.name).sort()).toEqual(PER_PROJECT);

    for (const name of ["read_document", "list_files", "read_file", "project_context", "propose_edit", "propose_files"]) {
      const args = name === "read_file" ? { path: "/x.typ" }
        : name === "project_context" ? { query: "x" }
        : name === "propose_edit" ? { request: "x", edits: [{ search: "a", replace: "b" }] }
        : name === "propose_files" ? { request: "x", ops: [{ kind: "create", path: "/n.typ", text: "y\n" }] }
        : {};
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(firstText(result)) as { status: string; message: string };
      expect(payload.status).toBe("no_project_attached");
      expect(payload.message).toBe("call open_project first");
    }
  });

  it("compile with NO project attached keeps its existing not_configured status", async () => {
    const client = await staticSurfaceClient(() => undefined);
    const result = await client.callTool({ name: "compile", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect((JSON.parse(firstText(result)) as { status: string }).status).toBe("not_configured");
  });

  it("the registered tool set is IDENTICAL before and after a simulated attach→detach reconnect", async () => {
    let attachment: ProjectAttachment | undefined;
    const client = await staticSurfaceClient(() => attachment);

    const before = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(before).toEqual(PER_PROJECT);

    // Attach a project (open_project), then detach + reattach (a reconnect).
    const { surface } = projectFixture("= Title\nbody\n");
    attachment = { surface, liveness: () => ({ relayConnected: true, browserAttached: true, humanPeers: 1, lastBrowserSeenMs: 1 }) };
    const attached = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(attached).toEqual(before);
    // The tool actually serves the project now.
    const read = await client.callTool({ name: "read_document", arguments: {} });
    expect(JSON.parse(firstText(read)).text).toBe("= Title\nbody\n");

    attachment = undefined; // teardown
    const detached = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(detached).toEqual(before);
    // …and it fails soft again, never a missing tool.
    const idle = await client.callTool({ name: "read_document", arguments: {} });
    expect(JSON.parse(firstText(idle)).status).toBe("no_project_attached");
  });

  it("a static-surface project tool serves liveness once attached (the production wiring)", async () => {
    const { surface } = projectFixture("= Title\nbody\n");
    const attachment: ProjectAttachment = {
      surface,
      liveness: () => ({ relayConnected: true, browserAttached: false, humanPeers: 0, lastBrowserSeenMs: null }),
    };
    const client = await staticSurfaceClient(() => attachment);
    const result = await client.callTool({
      name: "propose_edit",
      arguments: { request: "x", edits: [{ search: "body\n", replace: "body!\n" }] },
    });
    const payload = JSON.parse(firstText(result)) as { status: string; note: string };
    expect(payload.status).toBe("pending_review_unwatched");
    expect(payload.note).toMatch(/no browser is attached/i);
  });
});

describe("galley mcp kernel — unconfigured (no joined room)", () => {
  it("lists exactly the liveness tool — there is no document surface to serve", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["galley_ping"]);
  });

  it("answers galley_ping with pong + version (echo passthrough)", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "galley_ping", arguments: { echo: "hello" } });
    expect(firstText(result)).toBe(`pong ${GALLEY_MCP_SERVER_VERSION} hello`);
  });
});

describe("galley mcp kernel — the three sacred tools over the wrapped surface", () => {
  it("lists ping + the three sacred tools + the #16.2a/#16.2b read-context tools when configured", async () => {
    const { surface } = projectFixture();
    const client = await connectedClient({ surface });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "compile",
      "galley_ping",
      "list_files",
      "project_context",
      "propose_edit",
      "propose_files",
      "read_document",
      "read_file",
    ]);
  });

  it("read_document returns the scoped file's current text", async () => {
    const { surface } = projectFixture("= Title\nbody\n");
    const client = await connectedClient({ surface });
    const result = await client.callTool({ name: "read_document", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toBe("= Title\nbody\n");
  });

  it("read_document fails honestly when the scoped file is absent", async () => {
    const project = new CollabProject();
    const surface = createToolSurface(project, "/missing.typ", MCP);
    const client = await connectedClient({ surface });
    const result = await client.callTool({ name: "read_document", arguments: {} });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("/missing.typ");
  });

  it("propose_edit publishes a pending proposal and NEVER mutates file text (the ADR-0020 pin)", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    const client = await connectedClient({ surface });

    const result = await client.callTool({
      name: "propose_edit",
      arguments: {
        request: "Add a closing line",
        edits: [{ search: "body\n", replace: "body\nThe end.\n" }],
      },
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(firstText(result)) as {
      status: string;
      proposalId: string;
      filePath: string;
      message: string;
    };
    expect(payload.status).toBe("pending_review");
    expect(payload.filePath).toBe("/main.typ");
    expect(payload.message).toMatch(/a human must Accept it/i);

    // The document is untouched; the proposal carries the computed scratch result.
    const file = project.snapshot().files.find((f) => f.path === "/main.typ")!;
    expect(file.text).toBe("= Title\nbody\n");
    const record = surface.getProposal(payload.proposalId)!;
    expect(record.status).toBe("pending");
    expect(record.baseText).toBe("= Title\nbody\n");
    expect(record.proposedText).toBe("= Title\nbody\nThe end.\n");
    expect(record.request).toBe("Add a closing line");
  });

  // --- propose_files: multi-file create + edit change set ---------------------

  it("propose_files publishes a multi-file pending proposal and NEVER mutates the project", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    const client = await connectedClient({ surface });

    const result = await client.callTool({
      name: "propose_files",
      arguments: {
        request: "Add an intro chapter",
        ops: [
          { kind: "create", path: "/chapters/intro.typ", text: "= Introduction\nHello.\n" },
          {
            kind: "edit",
            path: "/main.typ",
            edits: [{ search: "body\n", replace: 'body\n#include "chapters/intro.typ"\n' }],
          },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(firstText(result)) as {
      status: string;
      proposalId: string;
      ops: { kind: string; path: string }[];
      message: string;
    };
    expect(payload.status).toBe("pending_review");
    expect(payload.ops).toEqual([
      { kind: "create", path: "/chapters/intro.typ" },
      { kind: "edit", path: "/main.typ" },
    ]);

    // The project is untouched: no new file, main unchanged.
    const files = project.snapshot().files;
    expect(files.some((f) => f.path === "/chapters/intro.typ")).toBe(false);
    expect(files.find((f) => f.path === "/main.typ")!.text).toBe("= Title\nbody\n");

    // The record carries the computed proposed text for each op.
    const pending = getPendingFileProposals(project);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.ops[1]!.proposedText).toBe('= Title\nbody\n#include "chapters/intro.typ"\n');
  });

  it("propose_files returns structured edit_failed (no proposal, no mutation) on a bad match", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    const client = await connectedClient({ surface });

    const result = await client.callTool({
      name: "propose_files",
      arguments: {
        request: "x",
        ops: [
          { kind: "create", path: "/new.typ", text: "ok\n" },
          { kind: "edit", path: "/main.typ", edits: [{ search: "no such text", replace: "y" }] },
        ],
      },
    });
    const payload = JSON.parse(firstText(result)) as {
      status: string;
      path: string;
      failures: { reason: string }[];
    };
    expect(payload.status).toBe("edit_failed");
    expect(payload.path).toBe("/main.typ");
    expect(getPendingFileProposals(project)).toHaveLength(0);
    expect(project.snapshot().files.some((f) => f.path === "/new.typ")).toBe(false);
  });

  it("propose_files rejects an unsafe path as structured data (nothing published)", async () => {
    const { project, surface } = projectFixture();
    const client = await connectedClient({ surface });
    const result = await client.callTool({
      name: "propose_files",
      arguments: { request: "x", ops: [{ kind: "create", path: "/../escape.typ", text: "x\n" }] },
    });
    const payload = JSON.parse(firstText(result)) as { status: string; path: string };
    expect(payload.status).toBe("invalid_path");
    expect(payload.path).toBe("/../escape.typ");
    expect(getPendingFileProposals(project)).toHaveLength(0);
  });

  it("propose_files rejects two ops on the same path as structured data", async () => {
    const { project, surface } = projectFixture();
    const client = await connectedClient({ surface });
    const result = await client.callTool({
      name: "propose_files",
      arguments: {
        request: "x",
        ops: [
          { kind: "create", path: "/dup.typ", text: "a\n" },
          { kind: "create", path: "/dup.typ", text: "b\n" },
        ],
      },
    });
    const payload = JSON.parse(firstText(result)) as { status: string; path: string };
    expect(payload.status).toBe("duplicate_path");
    expect(getPendingFileProposals(project)).toHaveLength(0);
  });

  it("propose_files publishes rename + delete ops (file management) and never mutates the project", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    project.create("/old.typ", "scratch\n", MCP);
    const client = await connectedClient({ surface });

    const result = await client.callTool({
      name: "propose_files",
      arguments: {
        request: "Reorganize the project",
        ops: [
          { kind: "rename", path: "/main.typ", newPath: "/paper.typ" },
          { kind: "delete", path: "/old.typ" },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(firstText(result)) as {
      status: string;
      ops: { kind: string; path: string; newPath?: string }[];
    };
    expect(payload.status).toBe("pending_review");
    expect(payload.ops).toEqual([
      { kind: "rename", path: "/main.typ", newPath: "/paper.typ" },
      { kind: "delete", path: "/old.typ" },
    ]);

    // Nothing landed — the human Accept gate is still mandatory.
    const files = project.snapshot().files;
    expect(files.find((f) => f.path === "/main.typ")!.deleted).toBe(false);
    expect(files.find((f) => f.path === "/old.typ")!.deleted).toBe(false);
    expect(files.some((f) => f.path === "/paper.typ")).toBe(false);

    const pending = getPendingFileProposals(project);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.ops[0]).toMatchObject({ kind: "rename", path: "/main.typ", newPath: "/paper.typ" });
  });

  it("propose_files rejects a rename to an unsafe destination as structured data (nothing published)", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    const client = await connectedClient({ surface });
    const result = await client.callTool({
      name: "propose_files",
      arguments: {
        request: "x",
        ops: [{ kind: "rename", path: "/main.typ", newPath: "/../escape.typ" }],
      },
    });
    const payload = JSON.parse(firstText(result)) as { status: string };
    expect(payload.status).toBe("invalid_path");
    expect(getPendingFileProposals(project)).toHaveLength(0);
  });

  it("propose_files reports proposal_too_large when the aggregate proposed text breaches the cap", async () => {
    const { project, surface } = projectFixture();
    const client = await connectedClient({ surface });
    // Each create is under the per-op cap; together they exceed maxTotalProposedBytes.
    const chunk = "a".repeat(FILE_PROPOSAL_LIMITS.maxTextBytes - 1);
    const count = Math.min(
      FILE_PROPOSAL_LIMITS.maxOps,
      Math.ceil(FILE_PROPOSAL_LIMITS.maxTotalProposedBytes / chunk.length) + 1,
    );
    const ops = Array.from({ length: count }, (_, i) => ({
      kind: "create" as const,
      path: `/big${i}.typ`,
      text: chunk,
    }));
    const result = await client.callTool({
      name: "propose_files",
      arguments: { request: "huge", ops },
    });
    const payload = JSON.parse(firstText(result)) as { status: string; message: string };
    expect(payload.status).toBe("proposal_too_large");
    expect(getPendingFileProposals(project)).toHaveLength(0);
  });

  it("propose_files rejects over-cap inputs at the protocol boundary (op count)", async () => {
    const { project, surface } = projectFixture();
    const client = await connectedClient({ surface });
    const ops = Array.from({ length: FILE_PROPOSAL_LIMITS.maxOps + 1 }, (_, i) => ({
      kind: "create" as const,
      path: `/f${i}.typ`,
      text: "x\n",
    }));
    const result = await client.callTool({
      name: "propose_files",
      arguments: { request: "x", ops },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("validation");
    expect(getPendingFileProposals(project)).toHaveLength(0);
  });

  it("propose_edit returns structured edit failures (no proposal, no mutation) on a bad match", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    const client = await connectedClient({ surface });

    const result = await client.callTool({
      name: "propose_edit",
      arguments: { request: "x", edits: [{ search: "no such text", replace: "y" }] },
    });
    const payload = JSON.parse(firstText(result)) as {
      status: string;
      failures: { reason: string; search: string }[];
    };
    expect(payload.status).toBe("edit_failed");
    expect(payload.failures).toEqual([{ reason: "no_match", search: "no such text" }]);
    expect(project.snapshot().files.find((f) => f.path === "/main.typ")!.text).toBe(
      "= Title\nbody\n",
    );
  });

  // --- Size limits at the tool boundary (Security-Analyst finding 1) ---------

  it("propose_edit rejects over-cap inputs at the protocol boundary (block count / block size / request length)", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    const client = await connectedClient({ surface });

    // The SDK enforces the zod caps at the protocol boundary and returns a
    // structured isError result (Input validation error) — the handler never runs.
    const tooManyBlocks = Array.from({ length: PROPOSAL_LIMITS.maxBlocks + 1 }, (_, i) => ({
      search: `s${i}`,
      replace: `r${i}`,
    }));
    const overCount = await client.callTool({
      name: "propose_edit",
      arguments: { request: "x", edits: tooManyBlocks },
    });
    expect(overCount.isError).toBe(true);
    expect(firstText(overCount)).toContain("validation");

    const overBlockSize = await client.callTool({
      name: "propose_edit",
      arguments: {
        request: "x",
        edits: [{ search: "y".repeat(PROPOSAL_LIMITS.maxBlockBytes + 1), replace: "z" }],
      },
    });
    expect(overBlockSize.isError).toBe(true);

    const overRequest = await client.callTool({
      name: "propose_edit",
      arguments: {
        request: "r".repeat(PROPOSAL_LIMITS.maxRequestChars + 1),
        edits: [{ search: "body\n", replace: "body!\n" }],
      },
    });
    expect(overRequest.isError).toBe(true);

    // Nothing was published and nothing was mutated.
    expect(getPendingProposals(project)).toHaveLength(0);
    expect(project.snapshot().files.find((f) => f.path === "/main.typ")!.text).toBe(
      "= Title\nbody\n",
    );
  });

  it("propose_edit returns a structured proposal_too_large when the COMPUTED text would breach the cap (nothing published)", async () => {
    // A document already near the cap: in-cap blocks can still push the
    // proposed text over. The byte-exact gate must catch the computed result.
    const nearCap = "x".repeat(PROPOSAL_LIMITS.maxTextBytes - 10) + "\nEND\n";
    const { project, surface } = projectFixture(nearCap);
    const client = await connectedClient({ surface });

    const result = await client.callTool({
      name: "propose_edit",
      arguments: {
        request: "grow it",
        edits: [{ search: "END\n", replace: `END\n${"y".repeat(1024)}\n` }],
      },
    });
    const payload = JSON.parse(firstText(result)) as { status: string; message: string };
    expect(payload.status).toBe("proposal_too_large");
    expect(payload.message).toMatch(/exceeds/);
    expect(getPendingProposals(project)).toHaveLength(0);
    expect(project.snapshot().files.find((f) => f.path === "/main.typ")!.text).toBe(nearCap);
  });

  it("edit_failed echoes a BOUNDED prefix of a failing search, never the full payload", async () => {
    const { surface } = projectFixture("= Title\nbody\n");
    const client = await connectedClient({ surface });

    const longMiss = "M".repeat(10_000); // in-cap but huge; it will not match
    const result = await client.callTool({
      name: "propose_edit",
      arguments: { request: "x", edits: [{ search: longMiss, replace: "y" }] },
    });
    const payload = JSON.parse(firstText(result)) as {
      status: string;
      failures: { search: string }[];
    };
    expect(payload.status).toBe("edit_failed");
    expect(payload.failures[0]!.search.length).toBeLessThanOrEqual(220);
    expect(payload.failures[0]!.search).toMatch(/\[truncated\]$/);
  });

  it("compile reports not_configured when no compile URL was given", async () => {
    const { surface } = projectFixture();
    const client = await connectedClient({ surface });
    const result = await client.callTool({ name: "compile", arguments: {} });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(firstText(result)) as { status: string; message: string };
    expect(payload.status).toBe("not_configured");
    expect(payload.message).toContain("--compile-url");
  });

  it("compile posts the project input to the injected service and relays diagnostics", async () => {
    const { surface } = projectFixture("= Title\nbody\n");
    const seen: CompileInput[] = [];
    const fake = {
      check: async (input: CompileInput): Promise<CheckResult> => {
        seen.push(input);
        return {
          ok: false,
          diagnostics: [{ severity: "error", message: "unknown variable: x" }],
          pageCount: null,
          durationMs: 3,
        };
      },
    };
    const client = await connectedClient({ surface, compileService: fake });
    const result = await client.callTool({ name: "compile", arguments: {} });
    const payload = JSON.parse(firstText(result)) as {
      status: string;
      ok: boolean;
      diagnostics: { message: string }[];
    };
    expect(payload.status).toBe("ok");
    expect(payload.ok).toBe(false);
    expect(payload.diagnostics[0]!.message).toBe("unknown variable: x");
    // The whole project went to the service (imports resolve like the preview).
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "project", main: "/main.typ" });
  });

  // --- #16.2a read context: list_files / read_file at the tool boundary ------

  it("list_files returns the live files (path + UTF-8 size), deleted files excluded", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    project.create("/notes.typ", "café\n", HUMAN); // 6 UTF-8 bytes
    const gone = project.create("/gone.typ", "bye\n", HUMAN);
    project.delete(gone, HUMAN);

    const client = await connectedClient({ surface });
    const result = await client.callTool({ name: "list_files", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result))).toEqual({
      files: [
        { path: "/main.typ", sizeBytes: 13, sizeExact: true, duplicate: false },
        { path: "/notes.typ", sizeBytes: 6, sizeExact: true, duplicate: false },
      ],
      truncated: false,
      omitted: 0,
    });
  });

  it("read_file returns a sibling's raw text by exact path", async () => {
    const { project, surface } = projectFixture();
    project.create("/notes.typ", "notes body\n", HUMAN);
    const client = await connectedClient({ surface });
    const result = await client.callTool({ name: "read_file", arguments: { path: "/notes.typ" } });
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toBe("notes body\n");
  });

  it("read_file rejects junk paths at the zod boundary (missing / empty / non-string / over-long)", async () => {
    const { surface } = projectFixture();
    const client = await connectedClient({ surface });
    for (const args of [
      {},
      { path: "" },
      { path: 42 },
      { path: `/${"p".repeat(READ_LIMITS.maxPathChars)}` },
    ]) {
      const result = await client.callTool({ name: "read_file", arguments: args });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain("validation");
    }
  });

  it("read_file fails honestly on a path that is not a live file (exact match only)", async () => {
    const { project, surface } = projectFixture();
    project.create("/notes.typ", "notes\n", HUMAN);
    const client = await connectedClient({ surface });
    for (const path of ["/missing.typ", "notes.typ", "/a/../notes.typ"]) {
      const result = await client.callTool({ name: "read_file", arguments: { path } });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain(path);
      expect(firstText(result)).toContain("not present");
    }
  });

  it("read_file REFUSES an over-cap file with a structured error — the content is never dumped (pinned: refusal, not truncation)", async () => {
    const { project, surface } = projectFixture();
    const huge = "x".repeat(READ_LIMITS.maxFileBytes + 1);
    project.create("/huge.typ", huge, HUMAN);
    const client = await connectedClient({ surface });

    const result = await client.callTool({ name: "read_file", arguments: { path: "/huge.typ" } });
    expect(result.isError).toBe(true);
    const text = firstText(result);
    expect(text).toContain(`${READ_LIMITS.maxFileBytes}-byte read cap`);
    expect(text).toContain(`${READ_LIMITS.maxFileBytes + 1} bytes`);
    expect(text.length).toBeLessThan(300); // the refusal itself is bounded
    expect(text).not.toContain("xxxx"); // no payload leakage

    // …but list_files still surfaces it (bounded entry: path + size only), so
    // the client can see WHY the read was refused.
    const listed = await client.callTool({ name: "list_files", arguments: {} });
    expect(JSON.parse(firstText(listed)).files).toContainEqual({
      path: "/huge.typ",
      sizeBytes: READ_LIMITS.maxFileBytes + 1,
      sizeExact: true,
      duplicate: false,
    });
  });

  it("read_file refuses a duplicate-path conflict with a structured error (no silent winner)", async () => {
    const { project, surface } = projectFixture();
    project.create("/dup.typ", "first\n", HUMAN);
    project.create("/dup.typ", "second\n", HUMAN);
    const client = await connectedClient({ surface });

    const result = await client.callTool({ name: "read_file", arguments: { path: "/dup.typ" } });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("duplicate-path conflict");
    // Neither candidate's content leaks through the refusal.
    expect(firstText(result)).not.toContain("first");
    expect(firstText(result)).not.toContain("second");

    // list_files shows the conflict so the agent can see project state honestly.
    const listed = await client.callTool({ name: "list_files", arguments: {} });
    const files = (JSON.parse(firstText(listed)) as {
      files: { path: string; duplicate: boolean }[];
    }).files;
    expect(files.filter((f) => f.duplicate).map((f) => f.path)).toEqual(["/dup.typ", "/dup.typ"]);
  });

  it("read_file errors echo hostile control-char paths JSON-escaped (one-line errors)", async () => {
    const { surface } = projectFixture();
    const client = await connectedClient({ surface });
    const hostile = "/evil\n\r.typ";
    const result = await client.callTool({ name: "read_file", arguments: { path: hostile } });
    expect(result.isError).toBe(true);
    const text = firstText(result);
    expect(text).not.toMatch(/[\n\r\u0000-\u001f]/);
    expect(text).toContain(JSON.stringify(hostile));
  });

  it("read context adds NO write surface: propose_edit stays pinned to the session's one target file (a smuggled `path` arg is inert)", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    project.create("/notes.typ", "notes\n", HUMAN);
    const client = await connectedClient({ surface });

    // Read a sibling first, then try to aim the proposal at it.
    await client.callTool({ name: "read_file", arguments: { path: "/notes.typ" } });
    const result = await client.callTool({
      name: "propose_edit",
      arguments: {
        path: "/notes.typ", // not part of the schema — must be ignored
        filePath: "/notes.typ", // likewise
        request: "x",
        edits: [{ search: "body\n", replace: "body!\n" }],
      },
    });
    const payload = JSON.parse(firstText(result)) as { status: string; proposalId: string };
    expect(payload.status).toBe("pending_review");
    const pending = getPendingProposals(project);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.filePath).toBe("/main.typ");
    // And no file text changed anywhere, sibling included.
    expect(
      project
        .snapshot()
        .files.map((f) => [f.path, f.text])
        .sort(),
    ).toEqual([
      ["/main.typ", "= Title\nbody\n"],
      ["/notes.typ", "notes\n"],
    ]);
  });

  // --- #16.2b retrieval-aware project context at the tool boundary -----------

  it("project_context returns query-relevant excerpts with provenance as bounded JSON", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    project.create(
      "/physics.typ",
      "= Quantum\n\nQuantum entanglement links particle states.\n",
      HUMAN,
    );
    const client = await connectedClient({ surface });
    const result = await client.callTool({
      name: "project_context",
      arguments: { query: "quantum entanglement", budget: 256 },
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(firstText(result)) as {
      excerpts: { path: string; startLine: number; endLine: number; text: string }[];
      skipped: unknown[];
      omitted: number;
      filesTruncated: boolean;
      scanTruncated: boolean;
      selectionTruncated: boolean;
    };
    const physics = payload.excerpts.find((e) => e.path === "/physics.typ");
    expect(physics).toMatchObject({ startLine: 1, endLine: 3 });
    // The response budget bounds the total excerpt text.
    expect(payload.excerpts.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(256);
    expect(payload.skipped).toEqual([]);
    expect(payload.omitted).toBe(0);
  });

  it("project_context rejects junk input at the zod boundary (missing/empty/over-long query; out-of-range or non-integer budget)", async () => {
    const { surface } = projectFixture();
    const client = await connectedClient({ surface });
    for (const args of [
      {},
      { query: "" },
      { query: 42 },
      { query: "q".repeat(READ_LIMITS.maxQueryChars + 1) },
      { query: "ok", budget: READ_LIMITS.minContextChars - 1 },
      { query: "ok", budget: READ_LIMITS.maxContextChars + 1 },
      { query: "ok", budget: 1.5 },
      { query: "ok", budget: "6000" },
    ]) {
      const result = await client.callTool({ name: "project_context", arguments: args });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain("validation");
    }
  });

  it("project_context echoes hostile skipped paths JSON-escaped (control chars never raw)", async () => {
    const { project, surface } = projectFixture();
    const hostile = "/evil\n\r.typ";
    project.create(hostile, "a\n", HUMAN);
    project.create(hostile, "b\n", HUMAN); // duplicate-path → lands in `skipped`
    const client = await connectedClient({ surface });
    const result = await client.callTool({
      name: "project_context",
      arguments: { query: "anything" },
    });
    expect(result.isError).toBeFalsy();
    const text = firstText(result);
    // The hostile path appears only in its JSON-escaped form — the raw JSON
    // carries no control character beyond its own pretty-print newlines.
    expect(text).toContain(JSON.stringify(hostile));
    expect(text).not.toMatch(/[\r\u0000-\u0009\u000b-\u001f]/);
    const payload = JSON.parse(text) as { skipped: { path: string; reason: string }[] };
    expect(payload.skipped).toEqual([
      { path: hostile, reason: "duplicate-path" },
      { path: hostile, reason: "duplicate-path" },
    ]);
  });

  it("project_context is read-only at the boundary — no mutation, no proposal", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    project.create("/notes.typ", "notes\n", HUMAN);
    const before = project.snapshot();
    const client = await connectedClient({ surface });
    await client.callTool({ name: "project_context", arguments: { query: "notes" } });
    expect(project.snapshot()).toEqual(before);
    expect(getPendingProposals(project)).toHaveLength(0);
  });

  // --- ADR-0024 §1: honest liveness merged into every per-project result ------

  const watched = () => ({
    relayConnected: true,
    browserAttached: true,
    humanPeers: 1,
    lastBrowserSeenMs: 123,
  });
  const unwatched = () => ({
    relayConnected: true,
    browserAttached: false,
    humanPeers: 0,
    lastBrowserSeenMs: null,
  });

  it("list_files / project_context / compile carry the liveness field when a provider is given", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    project.create("/notes.typ", "notes\n", HUMAN);
    const fake = {
      check: async (): Promise<CheckResult> => ({
        ok: true,
        diagnostics: [],
        pageCount: 1,
        durationMs: 1,
      }),
    };
    const client = await connectedClient({ surface, compileService: fake, liveness: watched });

    for (const call of [
      { name: "list_files", arguments: {} },
      { name: "project_context", arguments: { query: "notes" } },
      { name: "compile", arguments: {} },
    ]) {
      const result = await client.callTool(call);
      const payload = JSON.parse(firstText(result)) as { liveness?: typeof watched extends () => infer R ? R : never };
      expect(payload.liveness).toEqual(watched());
    }
  });

  it("read_document / read_file return text PLUS a liveness sidecar when a provider is given", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    project.create("/notes.typ", "notes\n", HUMAN);
    const client = await connectedClient({ surface, liveness: watched });

    const doc = await client.callTool({ name: "read_document", arguments: {} });
    const docPayload = JSON.parse(firstText(doc)) as { text: string; liveness: unknown };
    expect(docPayload.text).toBe("= Title\nbody\n");
    expect(docPayload.liveness).toEqual(watched());

    const file = await client.callTool({ name: "read_file", arguments: { path: "/notes.typ" } });
    const filePayload = JSON.parse(firstText(file)) as { text: string; liveness: unknown };
    expect(filePayload.text).toBe("notes\n");
    expect(filePayload.liveness).toEqual(watched());
  });

  it("propose_edit reports pending_review when a browser is attached, pending_review_unwatched when not", async () => {
    const a = projectFixture("= Title\nbody\n");
    const attached = await connectedClient({ surface: a.surface, liveness: watched });
    const r1 = await attached.callTool({
      name: "propose_edit",
      arguments: { request: "x", edits: [{ search: "body\n", replace: "body!\n" }] },
    });
    const p1 = JSON.parse(firstText(r1)) as { status: string; liveness: unknown; note?: string };
    expect(p1.status).toBe("pending_review");
    expect(p1.note).toBeUndefined();
    expect(p1.liveness).toEqual(watched());

    const b = projectFixture("= Title\nbody\n");
    const lonely = await connectedClient({ surface: b.surface, liveness: unwatched });
    const r2 = await lonely.callTool({
      name: "propose_edit",
      arguments: { request: "x", edits: [{ search: "body\n", replace: "body!\n" }] },
    });
    const p2 = JSON.parse(firstText(r2)) as { status: string; liveness: unknown; note: string };
    expect(p2.status).toBe("pending_review_unwatched");
    expect(p2.note).toMatch(/no browser is attached/i);
    expect(p2.liveness).toEqual(unwatched());
    // The proposal is STILL published — a browser may attach later.
    expect(getPendingProposals(b.project)).toHaveLength(1);
  });

  it("propose_files reports pending_review_unwatched (still published) when no browser is attached", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    const client = await connectedClient({ surface, liveness: unwatched });
    const result = await client.callTool({
      name: "propose_files",
      arguments: { request: "x", ops: [{ kind: "create", path: "/new.typ", text: "ok\n" }] },
    });
    const payload = JSON.parse(firstText(result)) as { status: string; note: string; liveness: unknown };
    expect(payload.status).toBe("pending_review_unwatched");
    expect(payload.note).toMatch(/no browser is attached/i);
    expect(payload.liveness).toEqual(unwatched());
    expect(getPendingFileProposals(project)).toHaveLength(1);
  });

  it("galley_ping reports relay/browser status when a session is bound", async () => {
    const { surface } = projectFixture();
    const client = await connectedClient({ surface, liveness: watched });
    const result = await client.callTool({ name: "galley_ping", arguments: {} });
    const payload = JSON.parse(firstText(result)) as {
      pong: boolean;
      version: string;
      relayConnected: boolean;
      browserAttached: boolean;
      humanPeers: number;
    };
    expect(payload.pong).toBe(true);
    expect(payload.version).toBe(GALLEY_MCP_SERVER_VERSION);
    expect(payload.relayConnected).toBe(true);
    expect(payload.browserAttached).toBe(true);
    expect(payload.humanPeers).toBe(1);
  });

  it("compile maps a service failure to an honest one-line error (no stack leak)", async () => {
    const { surface } = projectFixture();
    const fake = {
      check: async (): Promise<CheckResult> => {
        throw new Error("compile service responded 503: compile unavailable");
      },
    };
    const client = await connectedClient({ surface, compileService: fake });
    const result = await client.callTool({ name: "compile", arguments: {} });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe("compile: compile service responded 503: compile unavailable");
    expect(firstText(result)).not.toContain("at "); // no stack frames
  });

  // --- F9/F5: browser-routed compile fallback (no loopback --compile-url) ------
  // When no loopback compileService is configured, `compile` routes a
  // diagnostics-only compile through the paired browser's preview compiler.

  it("compile keeps not_configured when neither loopback service nor browser seam is present", async () => {
    const { surface } = projectFixture();
    const client = await connectedClient({ surface });
    const result = await client.callTool({ name: "compile", arguments: {} });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(firstText(result)) as { status: string };
    expect(payload.status).toBe("not_configured");
  });

  it("compile routes through the browser seam when no loopback service is configured", async () => {
    const { surface } = projectFixture();
    const client = await connectedClient({
      surface,
      compileBrowser: async () => ({ ok: true, pageCount: 3, diagnostics: [] }),
    });
    const result = await client.callTool({ name: "compile", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result))).toEqual({
      status: "ok",
      source: "browser",
      ok: true,
      pageCount: 3,
      diagnostics: [],
    });
  });

  it("compile relays the browser seam's failing diagnostics faithfully", async () => {
    const { surface } = projectFixture();
    const client = await connectedClient({
      surface,
      compileBrowser: async () => ({
        ok: false,
        pageCount: null,
        diagnostics: [{ severity: "error", message: "unknown variable: x" }],
      }),
    });
    const result = await client.callTool({ name: "compile", arguments: {} });
    const payload = JSON.parse(firstText(result)) as {
      status: string;
      source: string;
      ok: boolean;
      pageCount: number | null;
      diagnostics: { severity: string; message: string }[];
    };
    expect(payload.status).toBe("ok");
    expect(payload.source).toBe("browser");
    expect(payload.ok).toBe(false);
    expect(payload.pageCount).toBeNull();
    expect(payload.diagnostics).toEqual([{ severity: "error", message: "unknown variable: x" }]);
  });

  it("compile surfaces a browser seam {error} as an isError result prefixed compile:", async () => {
    const { surface } = projectFixture();
    const client = await connectedClient({
      surface,
      compileBrowser: async () => ({ error: "the browser refused the compile" }),
    });
    const result = await client.callTool({ name: "compile", arguments: {} });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe("compile: the browser refused the compile");
  });

  it("compile falls through to not_configured when the browser seam is {unavailable:true}", async () => {
    const { surface } = projectFixture();
    const client = await connectedClient({
      surface,
      compileBrowser: async () => ({ unavailable: true }),
    });
    const result = await client.callTool({ name: "compile", arguments: {} });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(firstText(result)) as { status: string };
    expect(payload.status).toBe("not_configured");
  });

  it("compile maps a thrown browser seam to an honest one-line error (no stack leak)", async () => {
    const { surface } = projectFixture();
    const client = await connectedClient({
      surface,
      compileBrowser: async () => {
        throw new Error("control RPC timed out after 10000ms");
      },
    });
    const result = await client.callTool({ name: "compile", arguments: {} });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe("compile: control RPC timed out after 10000ms");
    expect(firstText(result)).not.toContain("at "); // no stack frames
  });

  it("compile lets the loopback service WIN — the browser seam is never called", async () => {
    const { surface } = projectFixture();
    let browserCalls = 0;
    const fake = {
      check: async (): Promise<CheckResult> => ({
        ok: true,
        diagnostics: [],
        pageCount: 1,
        durationMs: 2,
      }),
    };
    const client = await connectedClient({
      surface,
      compileService: fake,
      compileBrowser: async () => {
        browserCalls += 1;
        return { ok: false, pageCount: null, diagnostics: [] };
      },
    });
    const result = await client.callTool({ name: "compile", arguments: {} });
    const payload = JSON.parse(firstText(result)) as { status: string; source: string };
    expect(payload.status).toBe("ok");
    expect(payload.source).toBe("loopback");
    expect(browserCalls).toBe(0);
  });
});

// --- F5: HONEST propose_* disposition under auto-accept (ADR-0023) -----------
// The kernel must not claim "pending — a human must Accept" about a SIGNED
// proposal the browser auto-accept applier is already applying. A signed
// session awaits the verdict and reports what actually happened; an unsigned
// session keeps the accurate manual-review wording.
describe("galley mcp kernel — honest propose_* disposition (F5)", () => {
  it("signed + accepted → status \"applied\" (the document changed)", async () => {
    const { project, surface } = signedFixture("= Title\nbody\n");
    const client = await connectedClient({ surface });

    // The browser applier flips the signed proposal to accepted. Schedule the
    // flip on a microtask AFTER publish so the await observes the status change
    // replicate into this same doc (the real apply path), not a pre-set value.
    const real = surface.publishProposal.bind(surface);
    surface.publishProposal = async (input) => {
      const id = await real(input);
      queueMicrotask(() => resolveProposal(project, id, "accepted", HUMAN));
      return id;
    };

    const result = await client.callTool({
      name: "propose_edit",
      arguments: { request: "Add a line", edits: [{ search: "body\n", replace: "body\nmore\n" }] },
    });
    const payload = JSON.parse(firstText(result)) as { status: string; filePath: string; message: string };
    expect(payload.status).toBe("applied");
    expect(payload.filePath).toBe("/main.typ");
    // Status-factual wording: "Accepted" (not "applied automatically" — a fast
    // human Accept reaches this branch too) and a re-read pointer.
    expect(payload.message).toMatch(/Accepted in Galley/i);
    expect(payload.message).toMatch(/re-read/i);
    expect(payload.message).not.toMatch(/automatic/i);
    // The proposal still published exactly as before (publish side-effect intact).
    expect(getPendingProposals(project)).toHaveLength(0); // it was accepted
  });

  it("signed + no verdict in window → HONEST pending_review (apply may be in flight)", async () => {
    const { surface } = signedFixture("= Title\nbody\n");
    const client = await connectedClient({ surface });

    // No applier flips the status — the await must time out and say so honestly,
    // never claim a human-only manual gate.
    const result = await client.callTool({
      name: "propose_edit",
      arguments: { request: "Add a line", edits: [{ search: "body\n", replace: "body\nmore\n" }] },
    });
    const payload = JSON.parse(firstText(result)) as { status: string; message: string };
    expect(payload.status).toBe("pending_review");
    expect(payload.message).toMatch(/750ms/);
    expect(payload.message).toMatch(/re-check/i);
    // Anti-regression: timeout must NOT overclaim a pending apply, and must
    // hold open the manual-Accept possibility ("Auto-accept may …").
    expect(payload.message).not.toMatch(/will apply/i);
    expect(payload.message).toMatch(/may/);
  });

  it("signed + rejected → status \"rejected\" (the document is unchanged)", async () => {
    const { project, surface } = signedFixture("= Title\nbody\n");
    const client = await connectedClient({ surface });

    const real = surface.publishProposal.bind(surface);
    surface.publishProposal = async (input) => {
      const id = await real(input);
      queueMicrotask(() => resolveProposal(project, id, "rejected", HUMAN));
      return id;
    };

    const result = await client.callTool({
      name: "propose_edit",
      arguments: { request: "Add a line", edits: [{ search: "body\n", replace: "body\nmore\n" }] },
    });
    const payload = JSON.parse(firstText(result)) as { status: string; message: string };
    expect(payload.status).toBe("rejected");
    expect(payload.message).toMatch(/rejected/i);
    expect(payload.message).toMatch(/unchanged/i);
    // The live document is untouched.
    expect(project.snapshot().files.find((f) => f.path === "/main.typ")!.text).toBe("= Title\nbody\n");
  });

  it("UNSIGNED (local) → immediate pending_review with manual-Accept wording (no await)", async () => {
    const { surface } = projectFixture("= Title\nbody\n");
    expect(surface.autoAcceptEligible).toBe(false);
    const client = await connectedClient({ surface });

    const result = await client.callTool({
      name: "propose_edit",
      arguments: { request: "Add a line", edits: [{ search: "body\n", replace: "body\nmore\n" }] },
    });
    const payload = JSON.parse(firstText(result)) as { status: string; message: string };
    expect(payload.status).toBe("pending_review");
    expect(payload.message).toMatch(/a human must Accept it/i);
    expect(payload.message).not.toMatch(/750ms/); // the await path never ran
  });

  it("propose_files honors the same disposition: signed + accepted → \"applied\" with ops", async () => {
    const { project, surface } = signedFixture("= Title\nbody\n");
    const client = await connectedClient({ surface });

    const real = surface.publishFileProposal.bind(surface);
    surface.publishFileProposal = async (input) => {
      const id = await real(input);
      queueMicrotask(() => resolveFileProposal(project, id, "accepted", HUMAN));
      return id;
    };

    const result = await client.callTool({
      name: "propose_files",
      arguments: {
        request: "Add an intro",
        ops: [{ kind: "create", path: "/intro.typ", text: "= Intro\n" }],
      },
    });
    const payload = JSON.parse(firstText(result)) as {
      status: string;
      ops: { kind: string; path: string }[];
      message: string;
    };
    expect(payload.status).toBe("applied");
    expect(payload.ops).toEqual([{ kind: "create", path: "/intro.typ" }]);
    expect(payload.message).toMatch(/Accepted in Galley/i);
    expect(payload.message).not.toMatch(/automatic/i);
    expect(getPendingFileProposals(project)).toHaveLength(0); // accepted
  });

  it("propose_files UNSIGNED → immediate pending_review (manual-Accept wording, ops preserved)", async () => {
    const { surface } = projectFixture("= Title\nbody\n");
    const client = await connectedClient({ surface });
    const result = await client.callTool({
      name: "propose_files",
      arguments: {
        request: "Add an intro",
        ops: [{ kind: "create", path: "/intro.typ", text: "= Intro\n" }],
      },
    });
    const payload = JSON.parse(firstText(result)) as {
      status: string;
      ops: { kind: string; path: string }[];
      message: string;
    };
    expect(payload.status).toBe("pending_review");
    expect(payload.ops).toEqual([{ kind: "create", path: "/intro.typ" }]);
    expect(payload.message).toMatch(/a human must Accept it/i);
  });
});

// --- A2: propose_files create-binary (upload-then-publish, fail-closed) ------
describe("galley mcp kernel — propose_files create-binary (A2)", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]); // PNG magic + body
  const PNG_B64 = PNG.toString("base64");

  /**
   * A KernelTools whose uploadBinary records the calls and returns the REAL
   * content hash (the content-addressed store echoes sha256(bytes); the handler
   * asserts the upload hash matches the bytes it hashed, so a fixed hash would
   * be rejected as a content mismatch).
   */
  function fixtureWithUploader() {
    const { project, surface } = projectFixture("= Title\nbody\n");
    const calls: { mime: string; size: number }[] = [];
    const released: { hash: string; size: number }[][] = [];
    const tools: KernelTools = {
      surface,
      uploadBinary: async (bytes, mime) => {
        calls.push({ mime, size: bytes.length });
        return { ok: true, hash: await sha256Hex(bytes), size: bytes.length, mime };
      },
      releaseBinary: async (hashes) => {
        released.push(hashes);
      },
    };
    return { project, surface, tools, calls, released };
  }

  it("uploads the bytes FIRST, then publishes ONE proposal carrying the create-binary pointer", async () => {
    const { project, tools, calls } = fixtureWithUploader();
    const client = await connectedClient(tools);
    const result = await client.callTool({
      name: "propose_files",
      arguments: {
        request: "Add a logo",
        ops: [
          { kind: "create", path: "/main2.typ", text: "#image(\"/logo.png\")\n" },
          { kind: "create-binary", path: "/logo.png", bytes: PNG_B64 },
        ],
      },
    });
    const payload = JSON.parse(firstText(result)) as { status: string; ops: { kind: string; path: string }[] };
    expect(calls).toHaveLength(1);
    expect(calls[0]!.size).toBe(PNG.length);
    // The published proposal carries BOTH the text create AND the binary pointer.
    const pending = getPendingFileProposals(project);
    expect(pending).toHaveLength(1);
    const kinds = pending[0]!.ops.map((o) => o.kind).sort();
    expect(kinds).toEqual(["create", "create-binary"]);
    const binOp = pending[0]!.ops.find((o) => o.kind === "create-binary")!;
    expect(binOp.binaryAsset).toEqual({
      type: "binary",
      hash: await sha256Hex(new Uint8Array(PNG)),
      size: PNG.length,
      mime: "image/png",
    });
    // D3: the published op order PRESERVES the input order (text create first).
    expect(pending[0]!.ops.map((o) => o.kind)).toEqual(["create", "create-binary"]);
    expect(payload.ops.map((o) => o.kind)).toEqual(["create", "create-binary"]);
  });

  it("a session with NO uploadBinary seam refuses a create-binary op (binary_unsupported), publishing nothing", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    const client = await connectedClient({ surface });
    const result = await client.callTool({
      name: "propose_files",
      arguments: { request: "Add a logo", ops: [{ kind: "create-binary", path: "/logo.png", bytes: PNG_B64 }] },
    });
    const payload = JSON.parse(firstText(result)) as { status: string };
    expect(payload.status).toBe("binary_unsupported");
    expect(getPendingFileProposals(project)).toHaveLength(0);
  });

  it("an upload FAILURE publishes NO proposal (fail-closed; atomic with text ops)", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    const tools: KernelTools = {
      surface,
      uploadBinary: async () => ({ ok: false, reason: "blob_quota_exceeded", message: "buffer full" }),
    };
    const client = await connectedClient(tools);
    const result = await client.callTool({
      name: "propose_files",
      arguments: {
        request: "Add a logo",
        ops: [
          { kind: "create", path: "/main2.typ", text: "x\n" },
          { kind: "create-binary", path: "/logo.png", bytes: PNG_B64 },
        ],
      },
    });
    const payload = JSON.parse(firstText(result)) as { status: string };
    expect(payload.status).toBe("blob_quota_exceeded");
    // Atomic: the text create did NOT get published either.
    expect(getPendingFileProposals(project)).toHaveLength(0);
  });

  it("invalid base64 bytes are refused before any upload (invalid_bytes)", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    let uploaded = false;
    const tools: KernelTools = {
      surface,
      uploadBinary: async () => { uploaded = true; return { ok: true, hash: "a".repeat(64), size: 1, mime: "image/png" }; },
    };
    const client = await connectedClient(tools);
    const result = await client.callTool({
      name: "propose_files",
      arguments: { request: "x", ops: [{ kind: "create-binary", path: "/logo.png", bytes: "not!base64!!" }] },
    });
    const payload = JSON.parse(firstText(result)) as { status: string };
    expect(payload.status).toBe("invalid_bytes");
    expect(uploaded).toBe(false);
    expect(getPendingFileProposals(project)).toHaveLength(0);
  });

  it("a create-binary path colliding with another op's path is refused (duplicate_path)", async () => {
    const { project, tools } = fixtureWithUploader();
    const client = await connectedClient(tools);
    const result = await client.callTool({
      name: "propose_files",
      arguments: {
        request: "x",
        ops: [
          { kind: "create", path: "/logo.png", text: "x\n" },
          { kind: "create-binary", path: "/logo.png", bytes: PNG_B64 },
        ],
      },
    });
    const payload = JSON.parse(firstText(result)) as { status: string };
    expect(payload.status).toBe("duplicate_path");
    expect(getPendingFileProposals(project)).toHaveLength(0);
  });

  // A1: the WHOLE proposal is validated BEFORE any upload — so a validation
  // failure on a LATER op means an EARLIER (valid, decode-able) binary op was
  // never uploaded. This pins the cap-before-upload ordering invariant (the
  // aggregate byte caps themselves are unit-tested in proposal-mailbox.test.ts).
  it("a validation failure on a later op uploads NOTHING for earlier binary ops (validate-before-upload)", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    let uploads = 0;
    const tools: KernelTools = {
      surface,
      uploadBinary: async (bytes, mime) => {
        uploads++;
        return { ok: true, hash: await sha256Hex(bytes), size: bytes.length, mime };
      },
    };
    const client = await connectedClient(tools);
    const unsafePath = "/../escape.png"; // passes zod length, fails isSafeProjectPath → invalid_path
    const result = await client.callTool({
      name: "propose_files",
      arguments: {
        request: "x",
        ops: [
          { kind: "create-binary", path: "/ok.png", bytes: PNG_B64 },
          { kind: "create-binary", path: unsafePath, bytes: PNG_B64 },
        ],
      },
    });
    const payload = JSON.parse(firstText(result)) as { status: string };
    expect(payload.status).toBe("invalid_path");
    // The CRUX: validation runs fully BEFORE any upload, so the first (valid) op
    // never uploaded despite being decode-able.
    expect(uploads).toBe(0);
    expect(getPendingFileProposals(project)).toHaveLength(0);
  });

  // A1: a multi-binary request whose blobs SUM over the aggregate cap is rejected
  // (proposal_too_large) and NOTHING is decoded or uploaded — the gate runs on the
  // DECLARED LENGTHS (computed from the base64 strings) BEFORE any decode/upload,
  // so no bytes are ever materialized. `uploadBinary` receives DECODED bytes, so
  // "never called" proves "never decoded".
  it("an over-AGGREGATE-cap multi-binary request rejects WITHOUT decoding/uploading", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    let uploads = 0;
    const tools: KernelTools = {
      surface,
      uploadBinary: async (bytes, mime) => {
        uploads++;
        return { ok: true, hash: await sha256Hex(bytes), size: bytes.length, mime };
      },
    };
    const client = await connectedClient(tools);
    // Each op just over half the aggregate cap → the SUM breaches it, but each is
    // UNDER the per-op cap. "AAAA" (k groups) decodes to 3k zero-bytes; pick k so
    // the decoded length is ~half the cap + a margin.
    const halfBytes = Math.floor(FILE_PROPOSAL_LIMITS.maxTotalBlobBytes / 2) + 3;
    const groups = Math.ceil(halfBytes / 3);
    const b64 = "A".repeat(groups * 4); // canonical, decodes to groups*3 bytes
    const result = await client.callTool({
      name: "propose_files",
      arguments: {
        request: "two big images",
        ops: [
          { kind: "create-binary", path: "/a.png", bytes: b64 },
          { kind: "create-binary", path: "/b.png", bytes: b64.slice(0, b64.length - 4) + "AAAB" },
        ],
      },
    });
    const payload = JSON.parse(firstText(result)) as { status: string };
    expect(payload.status).toBe("proposal_too_large");
    expect(uploads).toBe(0); // never decoded, never uploaded
    expect(getPendingFileProposals(project)).toHaveLength(0);
  });

  // C1: a partial upload that then fails RELEASES the already-uploaded hashes.
  it("a SECOND-blob upload failure RELEASES the first blob (no orphan/pin)", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    const released: { hash: string; size: number }[][] = [];
    let n = 0;
    const tools: KernelTools = {
      surface,
      uploadBinary: async (bytes, mime) => {
        n++;
        if (n === 1) return { ok: true, hash: await sha256Hex(bytes), size: bytes.length, mime };
        return { ok: false, reason: "push_failed", message: "lost" };
      },
      releaseBinary: async (hashes) => {
        released.push(hashes);
      },
    };
    const client = await connectedClient(tools);
    const A = Buffer.from([1, 2, 3, 4]).toString("base64");
    const B = Buffer.from([5, 6, 7, 8]).toString("base64");
    const result = await client.callTool({
      name: "propose_files",
      arguments: {
        request: "two images",
        ops: [
          { kind: "create-binary", path: "/a.png", bytes: A },
          { kind: "create-binary", path: "/b.png", bytes: B },
        ],
      },
    });
    const payload = JSON.parse(firstText(result)) as { status: string };
    expect(payload.status).toBe("push_failed");
    // The first (successful) upload's hash was released exactly once.
    expect(released).toHaveLength(1);
    expect(released[0]).toHaveLength(1);
    expect(released[0]![0]!.hash).toBe(await sha256Hex(new Uint8Array([1, 2, 3, 4])));
    expect(getPendingFileProposals(project)).toHaveLength(0);
  });

  // C1: a publishFileProposal THROW after uploads releases the uploaded blobs.
  it("a publish throw after upload RELEASES the uploaded blobs (no orphan)", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    const realPublish = surface.publishFileProposal.bind(surface);
    surface.publishFileProposal = async () => {
      throw new Error("doc gone");
    };
    void realPublish;
    const released: { hash: string; size: number }[][] = [];
    const tools: KernelTools = {
      surface,
      uploadBinary: async (bytes, mime) => ({ ok: true, hash: await sha256Hex(bytes), size: bytes.length, mime }),
      releaseBinary: async (hashes) => {
        released.push(hashes);
      },
    };
    const client = await connectedClient(tools);
    const result = await client.callTool({
      name: "propose_files",
      arguments: { request: "img", ops: [{ kind: "create-binary", path: "/a.png", bytes: PNG_B64 }] },
    });
    const payload = JSON.parse(firstText(result)) as { status: string };
    expect(payload.status).toBe("publish_failed");
    expect(released).toHaveLength(1);
    expect(released[0]![0]!.hash).toBe(await sha256Hex(new Uint8Array(PNG)));
    expect(getPendingFileProposals(project)).toHaveLength(0);
  });

  // D2: non-canonical base64 (extra padding / stray chars) is rejected pre-upload.
  it("rejects NON-canonical base64 (strict decode) before any upload", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    let uploaded = false;
    const tools: KernelTools = {
      surface,
      uploadBinary: async (bytes, mime) => { uploaded = true; return { ok: true, hash: await sha256Hex(bytes), size: bytes.length, mime }; },
    };
    const client = await connectedClient(tools);
    // "QQ" canonical-pads to "QQ==" (decodes to one byte 0x41); the un-padded form
    // "QQ" is NOT canonical and must be rejected (length not a multiple of 4).
    const result = await client.callTool({
      name: "propose_files",
      arguments: { request: "x", ops: [{ kind: "create-binary", path: "/a.png", bytes: "QQ" }] },
    });
    const payload = JSON.parse(firstText(result)) as { status: string };
    expect(payload.status).toBe("invalid_bytes");
    expect(uploaded).toBe(false);
    expect(getPendingFileProposals(project)).toHaveLength(0);
  });
});

describe("galley mcp kernel — propose_files create-binary-path (F8, local-path import)", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]); // PNG magic + body

  // Track every temp file we create so afterEach can remove them (best-effort).
  const tmpFiles: string[] = [];
  function tmpPath(suffix = ".png"): string {
    const p = path.join(os.tmpdir(), `galley-f8-${randomUUID()}${suffix}`);
    tmpFiles.push(p);
    return p;
  }

  /** Same uploader fixture as the create-binary block: echoes the real content hash. */
  function fixtureWithUploader() {
    const { project, surface } = projectFixture("= Title\nbody\n");
    const calls: { mime: string; size: number }[] = [];
    const tools: KernelTools = {
      surface,
      uploadBinary: async (bytes, mime) => {
        calls.push({ mime, size: bytes.length });
        return { ok: true, hash: await sha256Hex(bytes), size: bytes.length, mime };
      },
      releaseBinary: async () => {},
    };
    return { project, surface, tools, calls };
  }

  // Remove every temp file created during a test (sparse/over-cap files too).
  afterEach(async () => {
    const pending = tmpFiles.splice(0, tmpFiles.length);
    await Promise.all(pending.map((p) => fsRm(p, { force: true }).catch(() => {})));
  });

  it("reads the LOCAL file by absolute path, uploads it, and publishes a create-binary pointer (no base64)", async () => {
    const { project, tools, calls } = fixtureWithUploader();
    const src = tmpPath(".png");
    await fsWriteFile(src, PNG);
    const client = await connectedClient(tools);
    const result = await client.callTool({
      name: "propose_files",
      arguments: {
        request: "Add a logo from disk",
        ops: [
          { kind: "create", path: "/main2.typ", text: "#image(\"/logo.png\")\n" },
          { kind: "create-binary-path", path: "/logo.png", srcPath: src },
        ],
      },
    });
    const payload = JSON.parse(firstText(result)) as { status: string; ops: { kind: string; path: string }[] };
    expect(calls).toHaveLength(1);
    expect(calls[0]!.size).toBe(PNG.length);
    const pending = getPendingFileProposals(project);
    expect(pending).toHaveLength(1);
    // The PUBLISHED op kind is create-binary (NOT create-binary-path) — an ordinary
    // BinaryAsset pointer, preserving input order (text create first).
    expect(pending[0]!.ops.map((o) => o.kind)).toEqual(["create", "create-binary"]);
    expect(payload.ops.map((o) => o.kind)).toEqual(["create", "create-binary"]);
    const binOp = pending[0]!.ops.find((o) => o.kind === "create-binary")!;
    expect(binOp.binaryAsset).toEqual({
      type: "binary",
      hash: await sha256Hex(new Uint8Array(PNG)),
      size: PNG.length,
      mime: "image/png", // inferred from the bytes (no mime supplied)
    });
  });

  it("rejects a NON-absolute srcPath (invalid_src_path), uploading nothing", async () => {
    const { project, tools, calls } = fixtureWithUploader();
    const client = await connectedClient(tools);
    const result = await client.callTool({
      name: "propose_files",
      arguments: { request: "x", ops: [{ kind: "create-binary-path", path: "/logo.png", srcPath: "relative/logo.png" }] },
    });
    const payload = JSON.parse(firstText(result)) as { status: string };
    expect(payload.status).toBe("invalid_src_path");
    expect(calls).toHaveLength(0);
    expect(getPendingFileProposals(project)).toHaveLength(0);
  });

  it("rejects a MISSING/unreadable source file (src_unreadable), uploading nothing", async () => {
    const { project, tools, calls } = fixtureWithUploader();
    const missing = tmpPath(".png"); // tracked but never created
    const client = await connectedClient(tools);
    const result = await client.callTool({
      name: "propose_files",
      arguments: { request: "x", ops: [{ kind: "create-binary-path", path: "/logo.png", srcPath: missing }] },
    });
    const payload = JSON.parse(firstText(result)) as { status: string };
    expect(payload.status).toBe("src_unreadable");
    expect(calls).toHaveLength(0);
    expect(getPendingFileProposals(project)).toHaveLength(0);
  });

  it("rejects a DIRECTORY srcPath (src_unreadable), uploading nothing", async () => {
    const { project, tools, calls } = fixtureWithUploader();
    const client = await connectedClient(tools);
    const result = await client.callTool({
      name: "propose_files",
      arguments: { request: "x", ops: [{ kind: "create-binary-path", path: "/logo.png", srcPath: os.tmpdir() }] },
    });
    const payload = JSON.parse(firstText(result)) as { status: string };
    expect(payload.status).toBe("src_unreadable");
    expect(calls).toHaveLength(0);
    expect(getPendingFileProposals(project)).toHaveLength(0);
  });

  it("rejects an OVER-CAP source file by its stat size (blob_too_large), uploading nothing", async () => {
    const { project, tools, calls } = fixtureWithUploader();
    const big = tmpPath(".bin");
    // Truncate to just over the cap — a SPARSE file on macOS/Linux, so no real
    // bytes are written; the stat-size gate trips without materializing the blob.
    const fh = await fsOpen(big, "w");
    try {
      await fh.truncate(FILE_PROPOSAL_LIMITS.maxBlobBytes + 1);
    } finally {
      await fh.close();
    }
    const client = await connectedClient(tools);
    const result = await client.callTool({
      name: "propose_files",
      arguments: { request: "x", ops: [{ kind: "create-binary-path", path: "/big.bin", srcPath: big }] },
    });
    const payload = JSON.parse(firstText(result)) as { status: string };
    expect(payload.status).toBe("blob_too_large");
    expect(calls).toHaveLength(0);
    expect(getPendingFileProposals(project)).toHaveLength(0);
  });

  it("a session with NO uploadBinary seam refuses create-binary-path (binary_unsupported), publishing nothing", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    const src = tmpPath(".png");
    await fsWriteFile(src, PNG);
    const client = await connectedClient({ surface });
    const result = await client.callTool({
      name: "propose_files",
      arguments: { request: "x", ops: [{ kind: "create-binary-path", path: "/logo.png", srcPath: src }] },
    });
    const payload = JSON.parse(firstText(result)) as { status: string };
    expect(payload.status).toBe("binary_unsupported");
    expect(getPendingFileProposals(project)).toHaveLength(0);
  });

  it("an upload FAILURE publishes NO proposal (fail-closed; atomic with text ops)", async () => {
    const { project, surface } = projectFixture("= Title\nbody\n");
    const src = tmpPath(".png");
    await fsWriteFile(src, PNG);
    const tools: KernelTools = {
      surface,
      uploadBinary: async () => ({ ok: false, reason: "blob_quota_exceeded", message: "buffer full" }),
    };
    const client = await connectedClient(tools);
    const result = await client.callTool({
      name: "propose_files",
      arguments: {
        request: "x",
        ops: [
          { kind: "create", path: "/main2.typ", text: "x\n" },
          { kind: "create-binary-path", path: "/logo.png", srcPath: src },
        ],
      },
    });
    const payload = JSON.parse(firstText(result)) as { status: string };
    expect(payload.status).toBe("blob_quota_exceeded");
    // Atomic: the text create did NOT get published either.
    expect(getPendingFileProposals(project)).toHaveLength(0);
  });
});
