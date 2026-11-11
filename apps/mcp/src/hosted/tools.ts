/**
 * The hosted connector's tool list, read side (ADR-0033 §5). The endpoint
 * keeps no session, so there is no "attached project": every tool names its
 * project, and `list_projects` says which exist. Results are built by the same
 * functions as the local bridge's (read-tools.ts), so a read answers
 * identically over either connection.
 *
 * WRITES ARE PROPOSALS. `propose_edit` and `propose_files` publish a pending
 * record into the project's room, exactly what the local bridge publishes, and
 * stop. The document changes only when its owner accepts the proposal in
 * Galley. Applying on the server (a project in Auto mode, ADR-0033 §4) is not
 * in this release, so an Auto project is reviewed like an Ask one.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConnectedProject } from "@galley/auth";
import {
  FILE_PROPOSAL_LIMITS,
  PROPOSAL_LIMITS,
  fileProposalSizeViolation,
  getFileProposal,
  getPendingFileProposals,
  getPendingProposals,
  getProposal,
  proposalSizeViolation,
  publishFileProposal,
  publishProposal,
  type CollabProject,
  type FileProposalOp,
} from "@galley/collab";
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
import { buildTextOp, claimPath, TEXT_OP_SCHEMAS } from "../propose-build.js";
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
/** A proposal changes nothing by itself and is discarded by a Reject. */
const PROPOSES = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

/**
 * Proposals waiting for review, per project, before the connector refuses to
 * add more. Each one is stored in the document until its owner answers it, so
 * a client that keeps proposing with nobody reviewing must be stopped.
 */
export const MAX_PENDING_PROPOSALS = 20;

/** How often, and how far apart, a publish is looked for on the relay. */
const DELIVERY_CHECKS = 3;
const DELIVERY_CHECK_GAP_MS = 150;

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
    run: (
      binding: ReadBinding,
      project: CollabProject,
      grant: ConnectedProject,
    ) => ToolResult | Promise<ToolResult>,
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
        return run(
          { surface: createToolSurface(project, mainPath, CONNECTOR_AUTHOR) },
          project,
          grant,
        );
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

  /**
   * Publish a built proposal and answer honestly. The record is written into
   * this call's replica, which is then closed; the answer says "published" only
   * after a SECOND, fresh join finds the record on the relay. Without that
   * check a dropped connection would report a proposal nobody will ever see.
   */
  const propose = (
    tool: "propose_edit" | "propose_files",
    projectId: string,
    build: (binding: ReadBinding) =>
      | { refusal: Record<string, unknown> }
      | {
          publish: (project: CollabProject) => Promise<string>;
          found: (project: CollabProject, id: string) => boolean;
          identity: Record<string, unknown>;
        },
  ): Promise<ToolResult> => {
    let roomId: string | undefined;
    let delivered:
      | {
          id: string;
          check: (p: CollabProject) => boolean;
          body: Record<string, unknown>;
        }
      | undefined;
    return onProject(tool, projectId, async (binding, project, grant) => {
      if (
        getPendingProposals(project).length +
          getPendingFileProposals(project).length >=
        MAX_PENDING_PROPOSALS
      )
        return jsonResult({
          status: "too_many_pending",
          message: `No proposal was published: ${MAX_PENDING_PROPOSALS} proposals are already waiting for review in this project. Ask its owner to open Galley and accept or reject them.`,
        });
      const built = build(binding);
      if ("refusal" in built) return jsonResult(built.refusal);
      let id: string;
      try {
        id = await built.publish(project);
      } catch {
        return jsonResult({
          status: "publish_failed",
          message:
            "No proposal was published: the change was refused by the project's proposal limits.",
        });
      }
      roomId = grant.roomId;
      delivered = {
        id,
        check: (p) => built.found(p, id),
        body: {
          status: "pending_review",
          proposalId: id,
          project: projectId,
          ...built.identity,
          message:
            "Published for review. The document has NOT changed: the change is applied only when the project's owner accepts it in Galley." +
            (grant.reviewMode === "auto"
              ? " (This project is set to Auto, but this server does not apply changes on its own yet, so it waits for review like any other.)"
              : ""),
        },
      };
      return jsonResult(delivered.body);
    }).then(async (result) => {
      if (delivered === undefined || roomId === undefined) return result;
      const { check } = delivered;
      for (let attempt = 0; attempt < DELIVERY_CHECKS; attempt++) {
        if (attempt > 0)
          await new Promise((r) => setTimeout(r, DELIVERY_CHECK_GAP_MS));
        try {
          if (await deps.withProject(roomId, check)) return result;
        } catch (err) {
          if (!(err instanceof ProjectUnavailableError)) throw err;
        }
      }
      return errorResult(
        `${tool}: the proposal could not be confirmed on the server. It may not have been published; read the project again before retrying.`,
      );
    });
  };

  server.registerTool(
    "propose_edit",
    {
      title: "Propose an edit to one file (published for review)",
      description:
        "Applies search/replace edits to a scratch copy of ONE text file of a connected project " +
        "and publishes the result as a proposal. It never edits the document: the change waits " +
        "for the project's owner to accept it in Galley, and the answer says so (status " +
        '"pending_review"). Each `search` must match the file\'s current text exactly once; ' +
        'failures come back as structured data (status "edit_failed"): refine and retry. To ' +
        "create, rename or delete files, or to change several at once, use propose_files.",
      inputSchema: {
        project: projectParam,
        path: z
          .string()
          .min(1)
          .max(READ_LIMITS.maxPathChars)
          .describe(
            "Exact path of the EXISTING file to edit (as listed by list_files).",
          ),
        request: z
          .string()
          .min(1)
          .max(PROPOSAL_LIMITS.maxRequestChars)
          .describe(
            "A short human-readable title for the change (shown in the review card).",
          ),
        edits: z
          .array(
            z.object({
              search: z
                .string()
                .max(PROPOSAL_LIMITS.maxBlockBytes)
                .describe("Exact text to find; must match exactly once."),
              replace: z
                .string()
                .max(PROPOSAL_LIMITS.maxBlockBytes)
                .describe("Replacement text."),
            }),
          )
          .min(1)
          .max(PROPOSAL_LIMITS.maxBlocks)
          .describe(
            "Search/replace blocks, applied in order against the running text.",
          ),
      },
      annotations: PROPOSES,
    },
    ({ project, path, request, edits }) =>
      propose("propose_edit", project, ({ surface }) => {
        const seen = new Set<string>();
        const refusal = claimPath(seen, path);
        if (refusal !== null) return { refusal };
        const built = buildTextOp(surface, { kind: "edit", path, edits }, seen);
        if ("refusal" in built) return built;
        const input = {
          filePath: path,
          baseText: built.op.baseText,
          proposedText: built.op.proposedText,
          blocks: built.op.blocks,
          request,
        };
        const violation = proposalSizeViolation(input);
        if (violation !== null)
          return {
            refusal: {
              status: "proposal_too_large",
              message: `No proposal was published: ${violation}. Propose a smaller change.`,
            },
          };
        return {
          publish: (p) => publishProposal(p, input, CONNECTOR_AUTHOR),
          found: (p, id) => getProposal(p, id) !== undefined,
          identity: { filePath: path },
        };
      }),
  );

  server.registerTool(
    "propose_files",
    {
      title: "Propose a multi-file change (published for review)",
      description:
        "Proposes a change set across the files of a connected project as ONE proposal: create " +
        "new text files, edit existing ones, rename or move them, or delete them (for example " +
        "add /chapters/intro.typ and #include it from /main.typ). It never changes the project: " +
        "the set waits for the project's owner to accept it in Galley and lands all-or-nothing " +
        '(status "pending_review"). For `edit` ops each `search` must match that file\'s current ' +
        "text exactly once; failures come back as structured data. Delete is a recoverable " +
        "soft-delete. Paths must be safe in-tree project paths (leading slash, no traversal, not " +
        "under /.galley). Text files only: images and other binary files cannot be added through " +
        `the hosted connector. One proposal holds at most ${FILE_PROPOSAL_LIMITS.maxOps} ops.`,
      inputSchema: {
        project: projectParam,
        request: z
          .string()
          .min(1)
          .max(FILE_PROPOSAL_LIMITS.maxRequestChars)
          .describe(
            "A short human-readable title for the whole change set (shown in the review card).",
          ),
        ops: z
          .array(z.discriminatedUnion("kind", [...TEXT_OP_SCHEMAS]))
          .min(1)
          .max(FILE_PROPOSAL_LIMITS.maxOps)
          .describe("The file operations, applied all-or-nothing on Accept."),
      },
      annotations: PROPOSES,
    },
    ({ project, request, ops }) =>
      propose("propose_files", project, ({ surface }) => {
        const seen = new Set<string>();
        const built: FileProposalOp[] = [];
        for (const op of ops) {
          const refusal = claimPath(seen, op.path);
          if (refusal !== null) return { refusal };
          const one = buildTextOp(surface, op, seen);
          if ("refusal" in one) return one;
          built.push(one.op);
        }
        const input = { request, ops: built };
        const violation = fileProposalSizeViolation(input);
        if (violation !== null)
          return {
            refusal: {
              status: "proposal_too_large",
              message: `No proposal was published: ${violation}. Propose a smaller change set.`,
            },
          };
        return {
          publish: (p) => publishFileProposal(p, input, CONNECTOR_AUTHOR),
          found: (p, id) => getFileProposal(p, id) !== undefined,
          identity: {
            ops: built.map((op) => ({
              kind: op.kind,
              path: op.path,
              ...(op.kind === "rename" ? { newPath: op.newPath } : {}),
            })),
          },
        };
      }),
  );
}
