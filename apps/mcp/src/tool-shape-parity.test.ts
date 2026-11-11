import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CollabProject } from "@galley/collab";
import type { Author } from "@galley/shared";
import { createGalleyMcpServer } from "./server.js";
import { registerControlTools } from "./control-tools.js";
import { createToolSurface } from "./surface.js";
import { registerHostedTools } from "./hosted/tools.js";

/**
 * ADR-0033 §5: the two ways into Galley carry ONE tool list. The seven tools
 * the hosted connector serves exist on the local bridge under the same names
 * with the same input shapes, so instructions written for one work on the
 * other. This pins it: a rename or a new required parameter on either side
 * fails here.
 */

const SHARED_TOOLS = [
  "list_projects",
  "list_files",
  "read_file",
  "project_context",
  "compile",
  "propose_edit",
  "propose_files",
] as const;

type Schema = Record<string, unknown>;

/** The input schema without its prose: names, types, bounds and required-ness only. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "description" && key !== "title")
      .map(([key, inner]) => [key, shape(inner)]),
  );
}

async function inputSchemas(server: McpServer): Promise<Map<string, Schema>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parity", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  return new Map(tools.map((t) => [t.name, shape(t.inputSchema) as Schema]));
}

const never = (): never => {
  throw new Error("listing tools must not call a dependency");
};

async function hosted(): Promise<Map<string, Schema>> {
  const server = new McpServer({ name: "hosted", version: "0.0.0" });
  registerHostedTools(server, { listProjects: never, withProject: never });
  return inputSchemas(server);
}

async function localRoomMode(): Promise<Map<string, Schema>> {
  const project = new CollabProject();
  const author: Author = { kind: "agent", runId: "mcp" };
  return inputSchemas(
    createGalleyMcpServer({ surface: createToolSurface(project, "/main.typ", author) }),
  );
}

async function localControlMode(): Promise<Map<string, Schema>> {
  const server = createGalleyMcpServer();
  registerControlTools(server, {
    rpc: never,
    configuredSyncUrl: "ws://localhost:1234",
    controlRoom: "control-room",
    responseKey: new Uint8Array(32),
  });
  return inputSchemas(server);
}

/** `propose_files` op variants, keyed by their `kind`. */
function opKinds(schema: Schema): Map<string, unknown> {
  const ops = (schema["properties"] as Record<string, Schema>)["ops"]!;
  const items = ops["items"] as Schema;
  const variants = (items["oneOf"] ?? items["anyOf"]) as Schema[];
  return new Map(
    variants.map((v) => [
      ((v["properties"] as Record<string, Schema>)["kind"]!["const"] as string),
      v,
    ]),
  );
}

describe("one tool list for the local bridge and the hosted connector", () => {
  for (const [mode, local] of [
    ["started on a room", localRoomMode],
    ["paired with Agent Access", localControlMode],
  ] as const) {
    it(`the local bridge ${mode} serves the hosted connector's tools with the same input shapes`, async () => {
      const [remote, here] = await Promise.all([hosted(), local()]);
      for (const tool of SHARED_TOOLS) {
        expect(here.has(tool), `${tool} exists locally`).toBe(true);
        if (tool === "propose_files") continue;
        expect(here.get(tool), tool).toEqual(remote.get(tool));
      }
    });

    it(`propose_files ${mode} accepts every hosted op unchanged, plus the local binary ops`, async () => {
      const [remote, here] = await Promise.all([hosted(), local()]);
      const remoteFiles = remote.get("propose_files")!;
      const localFiles = here.get("propose_files")!;
      // Everything but the op variants is identical...
      const withoutOps = (s: Schema): unknown => {
        const { ops: _ops, ...rest } = s["properties"] as Record<string, unknown>;
        return { ...s, properties: rest };
      };
      expect(withoutOps(localFiles)).toEqual(withoutOps(remoteFiles));
      // ...and each op the hosted connector takes has the same shape locally.
      const remoteOps = opKinds(remoteFiles);
      const localOps = opKinds(localFiles);
      for (const [kind, variant] of remoteOps) {
        expect(localOps.get(kind), kind).toEqual(variant);
      }
      // The local bridge alone can upload bytes: it has the browser's channel.
      expect(
        [...localOps.keys()].filter((kind) => !remoteOps.has(kind)).sort(),
      ).toEqual(["create-binary", "create-binary-path"]);
    });
  }

  it("the hosted connector serves nothing the local bridge lacks", async () => {
    const remote = await hosted();
    expect([...remote.keys()].sort()).toEqual([...SHARED_TOOLS].sort());
  });
});
