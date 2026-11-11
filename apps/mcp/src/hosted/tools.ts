/**
 * The hosted connector's tool list, read side (ADR-0033 §5). The endpoint
 * keeps no session, so there is no "attached project": every tool names its
 * project, and `list_projects` says which exist. Results are built by the same
 * functions as the local bridge's (read-tools.ts), so a read answers
 * identically over either connection.
 *
 * Writes (`propose_edit`, `propose_files`) are not registered here yet.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConnectedProject } from "@galley/auth";
import type { Author } from "@galley/shared";
import type { CompileService } from "../compile-client.js";
import {
  compileServiceResult,
  errorResult,
  jsonResult,
  listFilesResult,
  projectContextResult,
  readFileResult,
  type ReadBinding,
  type ToolResult,
} from "../read-tools.js";
import { createToolSurface, READ_LIMITS } from "../surface.js";
import { ProjectUnavailableError, type ProjectRunner } from "./room.js";

/** The connector as an author: an agent that is not the local bridge. */
export const CONNECTOR_AUTHOR: Author = { kind: "agent", runId: "connector" };

export interface HostedToolDeps {
  /** The caller's connected projects, read fresh on every call. */
  listProjects: () => Promise<ConnectedProject[]>;
  withProject: ProjectRunner;
  /** Absent → `compile` reports `not_configured`. */
  compileService?: CompileService;
}

const projectParam = z
  .string()
  .min(1)
  .max(256)
  .describe(
    "The projectId of a connected project, as returned by list_projects.",
  );

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

export function registerHostedTools(
  server: McpServer,
  deps: HostedToolDeps,
): void {
  /**
   * Run one read against a named project. Every refusal is a one-line result
   * that echoes nothing the caller sent and nothing about the room.
   */
  const onProject = async (
    tool: string,
    projectId: string,
    run: (binding: ReadBinding) => ToolResult | Promise<ToolResult>,
  ): Promise<ToolResult> => {
    // Read the grant on every call: disconnecting a project takes effect on
    // the next one, with nothing to invalidate.
    const grant = (await deps.listProjects()).find(
      (p) => p.projectId === projectId,
    );
    if (grant === undefined)
      return errorResult(
        `${tool}: no connected project has that id. Call list_projects to see the ones this token can reach.`,
      );
    try {
      return await deps.withProject(grant.roomId, (project) => {
        const snapshot = project.snapshot();
        if (
          snapshot.files.length === 0 &&
          (snapshot.binaryFiles ?? []).length === 0
        )
          return errorResult(
            `${tool}: the server has no copy of this project yet. It fills the next time the project is opened in Galley; open it once and try again.`,
          );
        const mainId = project.mainFileId();
        const mainPath =
          (mainId != null ? project.getFile(mainId)?.path : undefined) ??
          snapshot.files[0]?.path ??
          "/main.typ";
        return run({
          surface: createToolSurface(project, mainPath, CONNECTOR_AUTHOR),
        });
      });
    } catch (err) {
      if (err instanceof ProjectUnavailableError)
        return errorResult(
          `${tool}: the project could not be reached on the server. Try again in a moment.`,
        );
      throw err;
    }
  };

  server.registerTool(
    "list_projects",
    {
      title: "List the connected projects",
      description:
        "Lists the Galley projects this token can reach: the ones its owner connected to " +
        "the hosted connector. Each has a projectId (pass it as `project` to every other " +
        "tool), a name when one was recorded, and its review mode: `ask` means a proposed " +
        "change waits for the owner to accept it in Galley, `auto` means it is applied " +
        "at once. Projects that were never connected are not on this server and cannot " +
        "be listed or opened here.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      jsonResult({
        projects: (await deps.listProjects()).map((p) => ({
          projectId: p.projectId,
          ...(p.name !== undefined ? { name: p.name } : {}),
          reviewMode: p.reviewMode,
        })),
      }),
  );

  server.registerTool(
    "list_files",
    {
      title: "List a project's files",
      description:
        "Lists the live (non-deleted) files of a connected project: exact path and size " +
        "(UTF-8 bytes when sizeExact, else a cheap lower bound), in a deterministic order; " +
        "duplicate-path conflicts are flagged per entry. BINARY files (images/PDFs) appear " +
        'too, carrying a { kind:"binary", hash, mime } descriptor. Read-only.',
      inputSchema: { project: projectParam },
      annotations: READ_ONLY,
    },
    ({ project }) => onProject("list_files", project, listFilesResult),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read a project file by path",
      description:
        "Returns the current text of a file in a connected project by EXACT path (as listed " +
        "by list_files: no normalization, no globbing). Read-only. Files over " +
        `${READ_LIMITS.maxFileBytes} UTF-8 bytes are refused with an error, never truncated. ` +
        'A BINARY file (image/PDF) returns { kind: "binary", path, hash, size, mime } ' +
        "instead of text; its bytes are not available through this tool.",
      inputSchema: {
        project: projectParam,
        path: z
          .string()
          .min(1)
          .max(READ_LIMITS.maxPathChars)
          .describe(
            "Exact file path as returned by list_files, e.g. /notes.typ.",
          ),
      },
      annotations: READ_ONLY,
    },
    ({ project, path }) =>
      onProject("read_file", project, (b) => readFileResult(b, path)),
  );

  server.registerTool(
    "project_context",
    {
      title: "Query-relevant project context",
      description:
        "Returns the most RELEVANT excerpts across ALL the live files of a connected project " +
        "for a query (lexical ranking over structural chunks), each with provenance: file " +
        "path, 1-based line range, and Typst heading path. Budget-limited and read-only: " +
        "files with duplicate-path conflicts or over the per-file cap are skipped (listed in " +
        "`skipped` with a reason), and `selectionTruncated` reports when relevant chunks did " +
        "not fit the budget. Use read_file for a complete file.",
      inputSchema: {
        project: projectParam,
        query: z
          .string()
          .min(1)
          .max(READ_LIMITS.maxQueryChars)
          .describe(
            "What you are looking for; ranks chunks across the whole project.",
          ),
        budget: z
          .number()
          .int()
          .min(READ_LIMITS.minContextChars)
          .max(READ_LIMITS.maxContextChars)
          .optional()
          .describe(
            `Response budget in characters of excerpt text (default ${READ_LIMITS.defaultContextChars}).`,
          ),
      },
      annotations: READ_ONLY,
    },
    ({ project, query, budget }) =>
      onProject("project_context", project, (b) =>
        projectContextResult(b, query, budget),
      ),
  );

  server.registerTool(
    "compile",
    {
      title: "Compile a project for diagnostics",
      description:
        "Type-checks a connected project on the server and returns its diagnostics " +
        "(errors/warnings and page count); never modifies the document. Text files only: " +
        "the server compile cannot see a project's images or other binary files, so a " +
        "document that includes them reports them as missing.",
      inputSchema: { project: projectParam },
      annotations: READ_ONLY,
    },
    async ({ project }) => {
      const compileService = deps.compileService;
      if (compileService === undefined)
        return jsonResult({
          status: "not_configured",
          message:
            "This server has no compile service for the hosted connector.",
        });
      return onProject("compile", project, (b) =>
        compileServiceResult(b, compileService, "server"),
      );
    },
  );
}
