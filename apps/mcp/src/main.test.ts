import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * The `galley-mcp` bin end to end, as an MCP client spawns it: over real stdio,
 * with NO Galley and NO relay running. An MCP client (or a registry probing the
 * server) must be able to complete the handshake and list the tools before the
 * user opens the project; only tool calls depend on the file replicating.
 */

const BIN = fileURLToPath(new URL("../bin/galley-mcp.mjs", import.meta.url));

/** A loopback port with nothing listening: bind an ephemeral one, then release it. */
async function deadPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe("galley-mcp bin — starts with no Galley running", () => {
  it("answers initialize and tools/list in per-project mode while the relay is unreachable", async () => {
    const port = await deadPort();
    const client = new Client({ name: "galley-mcp-bin-test", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, "--sync", `ws://127.0.0.1:${port}`, "--room", "probe-room", "--file", "/main.typ"],
      stderr: "ignore",
    });
    try {
      await client.connect(transport);
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
    } finally {
      await client.close();
    }
  }, 30_000);
});
