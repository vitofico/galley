/**
 * The hosted connector's HTTP surface (ADR-0033): an MCP endpoint at `/mcp`
 * that works with no Galley tab open.
 *
 * STATELESS. Every POST is authenticated, served by a fresh MCP server and
 * transport, and forgotten: no session id, no stream held open, nothing kept
 * between calls. That is what lets a revoked token or a disconnected project
 * stop working on the very next request.
 *
 * THE CREDENTIAL is a connector token, accepted in two places because clients
 * differ in what they can send:
 *   - `Authorization: Bearer gly_…` at `/mcp` (clients that can set a header);
 *   - the URL path, `/mcp/gly_…` (chat clients that take only an address).
 * With the second form the whole address is the secret. This service never
 * logs a request line, and answers `Referrer-Policy: no-referrer`.
 */
import { Hono, type Context } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ConnectedProject } from "@galley/auth";
import { isConnectorToken } from "@galley/shared";
import type { CompileService } from "../compile-client.js";
import type { ProjectRunner } from "./room.js";
import { registerHostedTools } from "./tools.js";

/** An MCP request is small JSON; a write (later) carries at most a few files. */
export const MAX_REQUEST_BYTES = 1024 * 1024;
/** Calls served at once. Each one holds a websocket and a project replica. */
export const DEFAULT_MAX_CONCURRENT = 8;

export interface ConnectorAppDeps {
  /** Resolve a well-formed token to its owner, or null. Must not throw. */
  authenticate: (
    token: string,
  ) => Promise<{ userId: string; tokenId: string } | null>;
  listProjects: (userId: string) => Promise<ConnectedProject[]>;
  withProject: ProjectRunner;
  compileService?: CompileService;
  maxConcurrent?: number;
}

const BASE_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const json = (
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...BASE_HEADERS, ...extra },
  });

/** The token a request presents: the path form wins, then the bearer header. */
function presentedToken(c: Context): string | null {
  const fromPath = c.req.param("token");
  if (fromPath !== undefined)
    return isConnectorToken(fromPath) ? fromPath : null;
  const header = c.req.header("authorization");
  const match = header === undefined ? null : /^Bearer ([^\s]+)$/.exec(header);
  return match !== null && isConnectorToken(match[1]) ? match[1]! : null;
}

export function createConnectorApp(deps: ConnectorAppDeps): Hono {
  const app = new Hono();
  const maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  let inFlight = 0;

  app.get("/healthz", (c) => c.text("ok"));

  const handle = async (c: Context): Promise<Response> => {
    // POST only: with no session there is no server-to-client stream to open
    // (GET) and nothing to end (DELETE).
    if (c.req.method !== "POST")
      return json(405, { error: "method_not_allowed" }, { allow: "POST" });

    // One constant refusal for a missing, malformed, unknown, expired or
    // revoked token, and for a closed account.
    const token = presentedToken(c);
    const who = token === null ? null : await deps.authenticate(token);
    if (who === null)
      return json(
        401,
        { error: "unauthorized" },
        { "www-authenticate": 'Bearer realm="galley-connector"' },
      );

    if (inFlight >= maxConcurrent)
      return json(503, { error: "busy" }, { "retry-after": "2" });
    inFlight++;
    const server = new McpServer({ name: "galley", version: "0.0.0" });
    try {
      registerHostedTools(server, {
        listProjects: () => deps.listProjects(who.userId),
        withProject: deps.withProject,
        ...(deps.compileService !== undefined
          ? { compileService: deps.compileService }
          : {}),
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        // No sessionIdGenerator = stateless: no session id is issued or expected.
        // A plain JSON answer, complete when the handler returns.
        enableJsonResponse: true,
        maxRequestBodySize: MAX_REQUEST_BYTES,
      });
      await server.connect(transport);
      const res = await transport.handleRequest(c.req.raw);
      for (const [k, v] of Object.entries(BASE_HEADERS)) res.headers.set(k, v);
      return res;
    } finally {
      inFlight--;
      void server.close().catch(() => {});
    }
  };

  app.all("/mcp", handle);
  app.all("/mcp/:token", handle);
  app.notFound(() => json(404, { error: "not_found" }));
  // Never a stack, never the request line (the path may be a token).
  app.onError(() => json(500, { error: "internal" }));
  return app;
}
