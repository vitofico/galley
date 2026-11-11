/**
 * The READ tools' results, shared by the two ways into Galley: the local bridge
 * (server.ts, stdio, one attached project) and the hosted connector
 * (hosted/tools.ts, HTTP, the project named per call — ADR-0033 §5). Each
 * function turns a {@link ToolSurface} outcome into the MCP result, so both
 * connections answer a read identically.
 *
 * All bounding lives in the surface (metadata-first scans, byte caps, escaped
 * path echoes); nothing here touches the replica directly.
 */
import type { CompileService } from "./compile-client.js";
import type { ToolSurface } from "./surface.js";
import {
  summarizeContextTruncation,
  summarizeListTruncation,
} from "./truncation-summary.js";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function jsonResult(value: unknown): ToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

export function errorResult(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** What a read needs of a project binding. */
export interface ReadBinding {
  surface: ToolSurface;
  /**
   * Room-derived liveness (ADR-0024 §1). When present, EVERY result carries the
   * current value; when absent, results are byte-for-byte without it.
   */
  liveness?: () => unknown;
}

/** Merge the liveness field into a JSON payload, read at send time. */
export const withLiveness = (
  att: ReadBinding,
  value: Record<string, unknown>,
): ToolResult =>
  jsonResult(
    att.liveness === undefined ? value : { ...value, liveness: att.liveness() },
  );

/**
 * Plain text when there is no liveness provider, a `{ text, liveness }` sidecar
 * when there is (a read must never imply a browser is attached — ADR-0024 §1).
 */
export const textOrJson = (att: ReadBinding, text: string): ToolResult =>
  att.liveness === undefined
    ? textResult(text)
    : jsonResult({ text, liveness: att.liveness() });

export function listFilesResult(att: ReadBinding): ToolResult {
  const listed = att.surface.listFiles();
  if (!listed.ok) return errorResult(`list_files: ${listed.error}`);
  // D1: one human-readable line when the listing was cut (entry cap, hidden
  // forged paths, or sizes reported as lower bounds). Null ⇒ omitted, so a
  // complete listing's result is byte-for-byte unchanged.
  const truncationSummary = summarizeListTruncation({
    truncated: listed.truncated,
    omitted: listed.omitted,
    inexactSizes: listed.files.filter((f) => !f.sizeExact).length,
  });
  return withLiveness(att, {
    files: listed.files,
    truncated: listed.truncated,
    omitted: listed.omitted,
    ...(truncationSummary !== null ? { truncationSummary } : {}),
  });
}

export function readFileResult(att: ReadBinding, path: string): ToolResult {
  // ALL read_file bounding lives in the surface (Security round 2): the
  // byte cap is enforced BEFORE the text is materialized (O(1) length
  // pre-check), duplicate-path conflicts are a structured refusal, and
  // hostile path echoes come back JSON-escaped.
  const read = att.surface.readFile(path);
  if (!read.ok) return errorResult(`read_file: ${read.error}`);
  // A3: a binary file has no text — return its structured pointer
  // ({ kind:"binary", path, hash, size, mime }) so the agent learns it is
  // binary + its content-address, without bytes (no transport for them yet).
  if ("kind" in read) {
    return withLiveness(att, {
      kind: "binary",
      path: read.path,
      hash: read.hash,
      size: read.size,
      mime: read.mime,
    });
  }
  return textOrJson(att, read.text);
}

export function projectContextResult(
  att: ReadBinding,
  query: string,
  budget: number | undefined,
): ToolResult {
  // ALL context bounding lives in the surface (the read_file pattern): the
  // metadata-first scan, the per-file cap, the cumulative materialization
  // budget, and the response budget are enforced there. Surface errors echo no
  // caller-controlled text (the query is ranking input, never an echo).
  const ctx = att.surface.projectContext(query, budget);
  if (!ctx.ok) return errorResult(`project_context: ${ctx.error}`);
  // D1: one human-readable line aggregating what was left out of the ranking
  // / selection (file cap, hidden forged paths, per-reason skips, response
  // budget). Null ⇒ omitted, so an untruncated result is unchanged.
  const truncationSummary = summarizeContextTruncation({
    omitted: ctx.omitted,
    filesTruncated: ctx.filesTruncated,
    scanTruncated: ctx.scanTruncated,
    chunksTruncated: ctx.chunksTruncated,
    selectionTruncated: ctx.selectionTruncated,
    skippedReasons: ctx.skipped.map((s) => s.reason),
  });
  return withLiveness(att, {
    excerpts: ctx.excerpts,
    skipped: ctx.skipped,
    omitted: ctx.omitted,
    filesTruncated: ctx.filesTruncated,
    scanTruncated: ctx.scanTruncated,
    chunksTruncated: ctx.chunksTruncated,
    selectionTruncated: ctx.selectionTruncated,
    ...(truncationSummary !== null ? { truncationSummary } : {}),
  });
}

/**
 * Type-check the project against a compile service. `source` names which
 * service answered: `"loopback"` for the local bridge's `--compile-url`,
 * `"server"` for the hosted connector's own compile service.
 */
export async function compileServiceResult(
  att: ReadBinding,
  compileService: CompileService,
  source: "loopback" | "server",
): Promise<ToolResult> {
  const input = att.surface.compileInput();
  if (typeof input === "object" && input !== null && "error" in input) {
    return errorResult(`compile: ${input.error}`);
  }
  try {
    const check = await compileService.check(input);
    return withLiveness(att, {
      status: "ok",
      // ADDITIVE (F9): symmetry with the browser-routed path so an agent can
      // tell which diagnostics source answered.
      source,
      ok: check.ok,
      pageCount: check.pageCount,
      diagnostics: check.diagnostics,
      durationMs: check.durationMs,
      // ADDITIVE (D3): when the compile produced output bytes, surface a
      // descriptor (size + sha256 + mime) so the agent knows the build
      // genuinely succeeded and how big it is. Omitted on a failed/empty
      // compile or a service that predates the field.
      ...(check.artifact !== undefined ? { artifact: check.artifact } : {}),
    });
  } catch (err) {
    // Honest message, no stack: the client sees what failed, not our internals.
    return errorResult(
      `compile: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
