/**
 * Entry point of the hosted connector service (ADR-0033). Run as its own
 * container from the shared image:
 *
 *   apps/mcp/node_modules/.bin/tsx apps/mcp/src/hosted/main.ts
 */
import { Server as HttpServer } from "node:http";
import { serve } from "@hono/node-server";
import { createConnectorApp } from "./app.js";
import { parseHostedConfig } from "./config.js";
import { buildConnectorDeps, createStateSweep } from "./wiring.js";

const config = parseHostedConfig(process.env);
const app = createConnectorApp(buildConnectorDeps(config));
const server = serve({
  fetch: app.fetch,
  port: config.port,
  hostname: "0.0.0.0",
});
if (server instanceof HttpServer) {
  server.headersTimeout = 30_000;
  server.requestTimeout = 90_000;
}
// The request line is never logged: with the path form it carries a token.
console.error(
  `@galley/mcp hosted connector listening on :${config.port}, compile: ${config.compileUrl !== undefined ? "on" : "off"}, applies changes (Auto): ${config.stateDir !== undefined ? "on" : "off"}`,
);

// A disconnected project's checkpoints and trail are erased within a minute.
const sweep = createStateSweep(config);
void sweep();
setInterval(() => void sweep(), 30_000).unref();

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
