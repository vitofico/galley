import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { savePairing } from "./pairing-store.js";
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
  it("resumes an authenticated durable pairing using only --sync", async () => {
    const dir = await mkdtemp(join(tmpdir(), "galley-resume-"));
    const env = { GALLEY_MCP_PAIRING_FILE: join(dir, "pairing.json") };
    await savePairing({
      controlRoom: "share-0123456789abcdef0123456789abcdef",
      responseKey: Buffer.alloc(32, 7).toString("base64url"),
    }, env);
    const port = await deadPort();
    const client = new Client({ name: "galley-resume-test", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, "--sync", `ws://127.0.0.1:${port}`],
      env,
      stderr: "ignore",
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.some((t) => t.name === "list_projects")).toBe(true);
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails with a pairing instruction when durable authority is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "galley-no-pairing-"));
    const child = spawn(process.execPath, [BIN, "--sync", "ws://127.0.0.1:1"], {
      env: { ...process.env, GALLEY_MCP_PAIRING_FILE: join(dir, "missing.json") },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    try {
      const code = await new Promise((resolve) => child.once("exit", resolve));
      expect(code).toBe(1);
      expect(stderr).toContain("Settings → Agent Access");
    } finally {
      child.kill();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

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

  it("exits cleanly when the client closes stdin, the stdio transport's shutdown signal", async () => {
    const port = await deadPort();
    const child = spawn(
      process.execPath,
      [BIN, "--sync", `ws://127.0.0.1:${port}`, "--room", "probe-room", "--file", "/main.typ"],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    child.stdin.end();
    const code = await Promise.race([
      exited,
      new Promise<"still running">((resolve) => setTimeout(() => resolve("still running"), 15_000)),
    ]);
    if (code === "still running") child.kill("SIGKILL");
    expect(code).toBe(0);
  }, 30_000);
});
