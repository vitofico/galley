/**
 * Roadmap #3 — the SHARED agent tool surface.
 *
 * One typed registry of tool entries `{ spec, access, run }` that BOTH agent
 * surfaces consume: the internal iterate-until-clean loop (run-agent.ts) now,
 * and the MCP control responder (via the pure adapter in
 * apps/web/src/control-tool-adapter.ts, mounted behind per-project content
 * consent in control-responder-mount.ts). Before this module the three tools
 * were hardcoded: tools.ts held the `ToolSpec[]` literals and run-agent.ts
 * dispatched on `call.name` inline — adding a tool meant editing both, and the
 * MCP surface would have had to duplicate the lot.
 *
 * Design rules (and WHY):
 *   - The registry is the single source of truth for SPECS and BEHAVIOR.
 *     `AGENT_TOOLS` / `RETRIEVAL_TOOLS` are now DERIVED here (tools.ts /
 *     context-view.ts re-export them), so the spec a model sees and the run
 *     function the loop executes can never drift apart.
 *   - Byte-for-byte compatibility: the derived arrays are module-level consts
 *     reusing the SAME spec objects as before (run-agent passes the very same
 *     array identity when no project seam is given), the run functions are the
 *     loop's old inline branches moved verbatim, and each run is an async
 *     GENERATOR so mid-tool events (edit_applied, iteration, diagnostics) keep
 *     their exact order AND timing relative to awaits (`yield*` in the loop).
 *   - Access discipline: every entry is `"readonly"` except `propose_edit` —
 *     the ONLY mutating tool, and even it only mutates the run's SCRATCH (the
 *     human still Accepts). A registry test pins this invariant so a future
 *     entry can't quietly open a new direct write path.
 *   - The new read-only project tools (`search_project`, `list_files`,
 *     `read_file`) depend on an OPTIONAL `ProjectToolsSeam`. DEFAULT OFF: when
 *     the seam is absent (every pre-existing call site) the tools are not
 *     offered, not runnable, and the model-visible request payload is
 *     unchanged — proven by identity/deep-equal tests.
 *   - Output caps: every project-tool result is clamped by the explicit
 *     constants in {@link PROJECT_TOOL_CAPS} so a single tool result can never
 *     blow the model context, no matter what the seam returns.
 *
 * No imports from tools.ts / context-view.ts / run-agent.ts — those modules
 * import (or re-export from) THIS one, so the dependency graph stays acyclic.
 */

import type {
  AgentEvent,
  CheckResult,
  Diagnostic,
  EditBlock,
  EditFailure,
} from "@galley/shared";
import type { ToolSpec } from "./model.js";
import { applyEdits } from "./apply-edits.js";
import { parseBibliography } from "./bibliography.js";
import type { CitationEntry } from "./citation.js";
import {
  checkConstraints,
  constraintViolationsToDiagnostics,
  formatConstraintViolationsForModel,
  type ConstraintViolation,
  type DocumentConstraints,
} from "./instructions.js";

// ---------------------------------------------------------------------------
// Pure formatting helpers (moved verbatim from tools.ts, which re-exports them
// — they live here because the run functions below are their only producers).
// ---------------------------------------------------------------------------

/** Render source with 1-based, right-aligned line numbers for `read_document`. */
export function lineNumbered(source: string): string {
  const lines = source.split("\n");
  const width = String(lines.length).length;
  return lines
    .map((line, i) => `${String(i + 1).padStart(width, " ")}| ${line}`)
    .join("\n");
}

export function errorCount(check: CheckResult): number {
  return check.diagnostics.filter((d) => d.severity === "error").length;
}

/** Human/model-readable summary of a compile result (fed back as a tool result). */
export function formatCheckForModel(check: CheckResult): string {
  const detail = check.diagnostics.map((d) => {
    const loc = d.span ? ` (line ${d.span.start.line}, col ${d.span.start.column})` : "";
    return `${d.severity}${loc}: ${d.message}`;
  });
  if (check.ok) {
    const head =
      check.diagnostics.length === 0
        ? `Compiled cleanly. Pages: ${check.pageCount ?? "?"}.`
        : `Compiled with ${check.diagnostics.length} warning(s). Pages: ${check.pageCount ?? "?"}.`;
    return [head, ...detail].join("\n");
  }
  return [`Compilation failed with ${errorCount(check)} error(s):`, ...detail].join("\n");
}

/** Explain edit failures so the model can correct and retry (all-or-nothing). */
export function formatFailuresForModel(failures: EditFailure[]): string {
  const lines = failures.map((f) => {
    switch (f.reason) {
      case "no_match":
        return `no_match: the search text was not found. Re-read the document and copy the exact text.`;
      case "multiple_matches":
        return `multiple_matches: the search text matched ${f.matchCount} times. Add more surrounding context so it is unique.`;
      case "overlap":
        return `overlap: this edit touches text already changed by an earlier edit in the same batch.`;
      case "stale_base":
        // RESERVED for a planned revision-check gate; not currently emitted by any apply path.
        return `stale_base: the document changed underneath the edit.`;
      default: {
        const _x: never = f.reason;
        return `unknown failure: ${String(_x)}`;
      }
    }
  });
  return [`No edits were applied (all-or-nothing). Fix and retry:`, ...lines].join("\n");
}

/** Validate `propose_edit` arguments into typed `EditBlock`s. */
export function parseEdits(
  args: unknown,
): { ok: true; edits: EditBlock[] } | { ok: false; error: string } {
  if (!args || typeof args !== "object") {
    return { ok: false, error: "arguments must be an object with an 'edits' array" };
  }
  const edits = (args as Record<string, unknown>).edits;
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: "'edits' must be a non-empty array of { search, replace }" };
  }
  const out: EditBlock[] = [];
  for (const e of edits) {
    if (!e || typeof e !== "object") {
      return { ok: false, error: "each edit must be an object with string 'search' and 'replace'" };
    }
    const { search, replace } = e as Record<string, unknown>;
    if (typeof search !== "string" || typeof replace !== "string") {
      return { ok: false, error: "each edit must have string 'search' and 'replace'" };
    }
    out.push({ search, replace });
  }
  return { ok: true, edits: out };
}

/**
 * Diagnostics + model-facing text for a compile, with constraint violations
 * folded in (moved verbatim from run-agent's `renderCheck` closure — pure).
 */
function renderCheck(
  check: CheckResult,
  violations: ConstraintViolation[],
): { diagnostics: Diagnostic[]; text: string } {
  return {
    diagnostics: violations.length
      ? [...check.diagnostics, ...constraintViolationsToDiagnostics(violations)]
      : check.diagnostics,
    text: violations.length
      ? `${formatCheckForModel(check)}\n\n${formatConstraintViolationsForModel(violations)}`
      : formatCheckForModel(check),
  };
}

// ---------------------------------------------------------------------------
// Seams: what a tool run may touch. Everything is injected — no network, no
// DOM, no app state — so the registry unit-tests offline like the loop does.
// ---------------------------------------------------------------------------

/** One project file's identity, as the read-only project tools list it. */
export interface ProjectFileEntry {
  fileId: string;
  path: string;
}

/** A single search match the seam reports (a structural subset of the web's
 * `SearchMatch` — the registry needs only the line + snippet for the model). */
export interface ProjectSearchMatchLike {
  line: number;
  snippet: string;
}

/** Per-file search results from the seam (structural subset of `SearchFileResult`). */
export interface ProjectSearchFileLike {
  path: string;
  matches: ProjectSearchMatchLike[];
  truncated?: boolean;
}

/** The seam's whole search result (structural subset of the web's `SearchResult`,
 * so `searchProjectFiles(...)` output assigns directly). */
export interface ProjectSearchResultLike {
  files: ProjectSearchFileLike[];
  totalMatches: number;
  truncated?: boolean;
}

/**
 * The OPTIONAL project seams the read-only project tools depend on (roadmap #3).
 * Implementations read the LIVE project at call time (multi-file awareness) —
 * the web builds one in apps/web/src/agent-project-tools.ts. Absent seam ⇒ the
 * project tools are not offered and the run is byte-for-byte the original.
 */
export interface ProjectToolsSeam {
  /** Every visible project file's identity (no contents — that's `readFile`). */
  listFiles(): ProjectFileEntry[];
  /** The full text of the file at `path`, or null when no such file exists. */
  readFile(path: string): string | null;
  /** Literal (case-insensitive substring) search across the project's files. */
  search(query: string): ProjectSearchResultLike;
}

/**
 * The loop's MUTABLE per-run state, shared with the tool runs. The registry
 * mutates it exactly where the old inline dispatch mutated the loop's locals
 * (scratch/blocks on an applied edit; lastCheck/lastViolations on a compile;
 * the iteration/failure counters) — run-agent owns the object, tools write
 * through it, and the loop's outcome classification reads it back.
 */
export interface ToolLoopState {
  scratch: string;
  blocks: EditBlock[];
  lastCheck: CheckResult | null;
  lastViolations: ConstraintViolation[];
  compileIters: number;
  failedConsecutive: number;
}

/** What the registry needs from a compiler (structural subset of `AgentCompiler`,
 * declared here so run-agent can keep owning the public interface — acyclic). */
export interface ToolCompiler {
  check(source: string): Promise<CheckResult>;
}

/**
 * Everything a tool run may touch, injected per run by the loop (or by the MCP
 * adapter). `retrieval.render` is a closure the loop builds over context-view's
 * `renderRetrievalRead` — injected as a seam so this module never imports
 * context-view (which imports tools.ts, which re-exports from here).
 */
export interface ToolSeams {
  state: ToolLoopState;
  compiler: ToolCompiler;
  /** The self-correction cap (for the `iteration` event's `max`). */
  max: number;
  /** Active 14-D constraints, or null (checked only on a CLEAN compile). */
  constraints: DocumentConstraints | null;
  /** Retrieval-aware read_document (#9): active runs render via the injected closure. */
  retrieval:
    | { active: false }
    | { active: true; render(args: unknown): Promise<{ text: string; summary: string }> };
  /** The optional project seams; absent ⇒ project tools are not offered. */
  projectTools?: ProjectToolsSeam;
}

/** What a tool run hands back to the loop: the model-facing result text, the
 * one-line UI summary, and (propose_edit only) whether this apply converged. */
export interface ToolRunResult {
  resultText: string;
  summary: string;
  /** True when an applied edit compiled clean with no constraint violations. */
  converged?: boolean;
}

export type ToolAccess = "readonly" | "mutating";

/** One registry entry: the spec a model sees + how the loop executes it. */
export interface ToolRegistryEntry {
  spec: ToolSpec;
  /** Spec swap when retrieval is active (read_document gains scopes; #9). */
  retrievalSpec?: ToolSpec;
  /**
   * "readonly" tools never change the scratch or any document state; the ONLY
   * "mutating" entry is propose_edit, whose writes still flow scratch →
   * pendingRun → human Accept (never a direct document write).
   */
  access: ToolAccess;
  /** Offered ONLY when `seams.projectTools` is present (default OFF). */
  requiresProjectSeam?: boolean;
  /**
   * Execute the tool. An async GENERATOR so a run can interleave AgentEvents
   * with its awaits exactly as the old inline dispatch did (the loop `yield*`s
   * it); the return value feeds the model + the trace summary.
   */
  run(seams: ToolSeams, args: unknown): AsyncGenerator<AgentEvent, ToolRunResult, void>;
}

// ---------------------------------------------------------------------------
// Output caps for the project tools. Explicit constants (not "whatever the
// seam returned") so a tool RESULT can never blow the model context — the seam
// may cap too (searchProjectFiles does), but the registry clamps regardless.
// ---------------------------------------------------------------------------

export const PROJECT_TOOL_CAPS = {
  /** Max characters of a `read_file` body (raw, pre-numbering) fed to the model. */
  readFileMaxChars: 24_000,
  /** Max entries a `list_files` result names. */
  listFilesMaxEntries: 200,
  /** Max files a `search_project` result covers. */
  searchMaxFiles: 10,
  /** Max matches shown per file in a `search_project` result. */
  searchMaxMatchesPerFile: 10,
  /** Max characters of one search snippet (a pathological one-line file can't flood). */
  searchSnippetMaxChars: 160,
  /**
   * HARD ceiling on the FINAL ASSEMBLED result of EVERY project tool, applied
   * last (after numbering/joining/markers). The per-field caps above bound the
   * inputs, but ASSEMBLY can still expand them — line-numbering a newline-heavy
   * file multiplies its size severalfold — so the assembled string is clamped
   * too (Security round, finding HIGH-b).
   */
  resultMaxChars: 28_000,
  /** Max characters of a project PATH echoed into a result (paths are user/peer text). */
  pathMaxChars: 200,
  /** Max characters of a search QUERY echoed back on a no-match result. */
  queryEchoMaxChars: 120,
  // --- list_bibliography: bound the parsing WORK, not only the output --------
  // A `.bib` library can be a 200-entry / multi-hundred-KB file (or a hostile
  // project could seed hundreds of them), and a `read_file` would silently
  // truncate at readFileMaxChars — the whole reason this tool exists. So BOTH
  // the input to the parser (file count + aggregate source chars) AND the output
  // (entry count + per-field length + the shared resultMaxChars clamp) are capped
  // (Architect: bounding the output alone still lets a hostile library blow parse
  // cost). Truncation is always reported honestly, never silent.
  /** Max `.bib` files read (a project can't force reading hundreds). */
  bibMaxFiles: 20,
  /** Max AGGREGATE source characters fed to the parser (stop reading past it). */
  bibMaxSourceChars: 400_000,
  /** Max bibliography entries a result renders (the rest reported as "N of M"). */
  bibMaxEntries: 200,
  /** Max characters of ONE rendered bib field (key / author / title / year / locator). */
  bibFieldMaxChars: 200,
  /** Max author/editor names shown per entry before an "et al." elision. */
  bibMaxAuthors: 6,
} as const;

/**
 * Make user-/peer-controlled text safe to ECHO into a tool result (Security
 * round, finding HIGH-a). Project paths and search queries are author-typed
 * (and, in a shared room, PEER-typed) strings: a hostile filename could be 50k
 * chars (context/cost exhaustion) or carry newlines/control characters that
 * fake new "lines" of tool output — a prompt-injection channel that fires
 * before any file is even read. So every echo is (1) escaped — control
 * characters (C0/C1, DEL, U+2028/9) become VISIBLE JS-style escapes (`\n`,
 * `\u0007`), never raw — and (2) truncated to `max` with an ellipsis.
 * Pre-sliced so escaping never chews through megabytes of hostile input.
 */
/**
 * Turn every control character (C0/C1, DEL, U+2028/9) into a VISIBLE JS-style
 * escape, never raw. This is the half of {@link sanitizeEcho} that defends the
 * model context against a fake-new-line / prompt-injection channel; exported so
 * other surfaces that echo author-controlled strings to a model (the MCP
 * `list_projects`/`list_versions` metadata) share ONE escape policy. Does NOT
 * truncate — pair it with a length cap at the call site.
 */
// eslint-disable-next-line no-control-regex -- escaping control chars is the point
const CONTROL_CHAR_RE = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "g");
export function escapeControlChars(text: string): string {
  return text.replace(CONTROL_CHAR_RE, (ch) => {
    if (ch === "\n") return "\\n";
    if (ch === "\r") return "\\r";
    if (ch === "\t") return "\\t";
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

function sanitizeEcho(text: string, max: number): string {
  const pre = text.length > max ? text.slice(0, max) : text;
  const escaped = escapeControlChars(pre);
  const truncated = text.length > max || escaped.length > max;
  const body = escaped.length > max ? escaped.slice(0, max) : escaped;
  return truncated ? `${body}…` : body;
}

/**
 * The LAST line of defense for the model context: clamp a fully ASSEMBLED
 * project-tool result to {@link PROJECT_TOOL_CAPS}.resultMaxChars, truncation
 * marker INCLUDED (the clamped string never exceeds the cap). Every project
 * tool's resultText passes through here, whatever the per-field caps already
 * did — per-field caps bound inputs; this bounds the output.
 */
function clampResult(text: string): string {
  const cap = PROJECT_TOOL_CAPS.resultMaxChars;
  if (text.length <= cap) return text;
  const marker = "\n… (tool result truncated) …";
  return `${text.slice(0, cap - marker.length)}${marker}`;
}

// ---------------------------------------------------------------------------
// Tool specs. The three core literals moved VERBATIM from tools.ts /
// context-view.ts (the pin test deep-equals them against hardcoded copies of
// the previous arrays); the three project-tool specs are new.
// ---------------------------------------------------------------------------

const READ_DOCUMENT_SPEC: ToolSpec = {
  name: "read_document",
  description:
    "Return the current scratch document source, with line numbers for reference.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const COMPILE_SPEC: ToolSpec = {
  name: "compile",
  description:
    "Compile the current scratch document; returns diagnostics and page count.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const PROPOSE_EDIT_SPEC: ToolSpec = {
  name: "propose_edit",
  description:
    "Apply search/replace edits to the scratch document in order, then compile and return diagnostics.",
  parameters: {
    type: "object",
    properties: {
      edits: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            search: {
              type: "string",
              description: "Exact text to find. Must be unique in the document.",
            },
            replace: { type: "string", description: "Replacement text." },
          },
          required: ["search", "replace"],
          additionalProperties: false,
        },
      },
    },
    required: ["edits"],
    additionalProperties: false,
  },
};

/**
 * `read_document` with retrieval scopes (#9, moved verbatim from context-view.ts,
 * which re-exports it). Identical name to the base tool — only the parameters +
 * rendering differ, and only for a run where retrieval is active.
 */
export const RETRIEVAL_READ_DOCUMENT: ToolSpec = {
  name: "read_document",
  description:
    "Return document context. This document is large, so by default this returns the " +
    "most RELEVANT sections, shown with TRUE document line numbers and " +
    '"… omitted lines X–Y …" markers where text is hidden. Other scopes: "outline" ' +
    '(a cheap heading map to navigate), "section" with heading to read one whole ' +
    'section, "range" with {startLine,endLine} for a line window, "full" for the entire ' +
    "document. Pass query to refocus the selected excerpt. Edits still match on the " +
    "document TEXT via search/replace (never on line numbers) and apply against the " +
    "full document even if a region was omitted from your view.",
  parameters: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["selected", "range", "full", "outline", "section"],
        description:
          'How much to return: "selected" (default, relevant excerpt), "outline" (heading map), "section" (one whole section, needs heading), "range" (a line window, needs range), or "full".',
      },
      range: {
        type: "object",
        properties: {
          startLine: { type: "integer", description: "First line to show (1-based)." },
          endLine: { type: "integer", description: "Last line to show (1-based, inclusive)." },
        },
        required: ["startLine", "endLine"],
        additionalProperties: false,
      },
      heading: {
        type: "string",
        description: 'For scope:"section" — the heading title of the section to read (as shown in the outline).',
      },
      query: {
        type: "string",
        description: "Optional focus query to refine the selected excerpt.",
      },
    },
    additionalProperties: false,
  },
};

const SEARCH_PROJECT_SPEC: ToolSpec = {
  name: "search_project",
  description:
    "Search every file in the project for a literal text query (case-insensitive substring " +
    "match, NOT a regex). Returns matching lines as path:line: snippet. Use this to find " +
    "where something is defined or mentioned across the whole project.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The literal text to search for (taken verbatim, case-insensitive).",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

const LIST_FILES_SPEC: ToolSpec = {
  name: "list_files",
  description:
    "List the project's files (paths only). Use this to discover what exists before " +
    "reading a specific file with read_file.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const READ_FILE_SPEC: ToolSpec = {
  name: "read_file",
  description:
    "Return the full text of one project file by its path (as shown by list_files), with " +
    "line numbers for reference. Read-only: edits still go through propose_edit on the " +
    "active document.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The project path of the file to read (e.g. /main.typ).",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

const LIST_BIBLIOGRAPHY_SPEC: ToolSpec = {
  name: "list_bibliography",
  description:
    "List the project's bibliography as compact one-line entries (cite key — authors " +
    "(year). title. doi/url). Reads EVERY .bib file in the project, de-duplicates across " +
    "them, and returns globally-unique cite keys. Prefer this over read_file for a " +
    "bibliography: a large .bib often exceeds read_file's size cap and is silently " +
    "truncated, whereas this returns one bounded line per entry. Read-only. Only BibTeX " +
    "(.bib) files are covered — NOT Hayagriva (.yml) bibliographies.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

// ---------------------------------------------------------------------------
// Run implementations. The three core runs are the loop's old inline branches
// moved VERBATIM (same mutations, same event order, same strings); the three
// project runs are new, capped, and fail-soft on bad arguments (the model gets
// a correctable error result, never a crash).
// ---------------------------------------------------------------------------

/* eslint-disable require-yield -- some runs legitimately emit no events */

async function* runReadDocument(
  seams: ToolSeams,
  args: unknown,
): AsyncGenerator<AgentEvent, ToolRunResult, void> {
  if (seams.retrieval.active) {
    const view = await seams.retrieval.render(args);
    return { resultText: view.text, summary: view.summary };
  }
  const scratch = seams.state.scratch;
  return {
    resultText: lineNumbered(scratch),
    summary: `${scratch.split("\n").length} lines`,
  };
}

async function* runCompile(
  seams: ToolSeams,
  _args: unknown,
): AsyncGenerator<AgentEvent, ToolRunResult, void> {
  const st = seams.state;
  const check = await seams.compiler.check(st.scratch);
  st.lastCheck = check;
  // Compile errors win: constraints are only checked on a CLEAN compile.
  const violations =
    seams.constraints && check.ok ? checkConstraints(st.scratch, seams.constraints) : [];
  st.lastViolations = violations;
  const rendered = renderCheck(check, violations);
  yield { type: "diagnostics", diagnostics: rendered.diagnostics };
  const summary = !check.ok
    ? `${errorCount(check)} error(s)`
    : violations.length
      ? `ok, but ${violations.length} constraint violation(s)`
      : `ok, ${check.pageCount ?? "?"} page(s)`;
  return { resultText: rendered.text, summary };
}

async function* runProposeEdit(
  seams: ToolSeams,
  args: unknown,
): AsyncGenerator<AgentEvent, ToolRunResult, void> {
  const st = seams.state;
  const parsed = parseEdits(args);
  if (!parsed.ok) {
    st.failedConsecutive += 1;
    return { resultText: `Invalid arguments: ${parsed.error}`, summary: "invalid edit arguments" };
  }
  const applied = applyEdits(st.scratch, parsed.edits);
  if (!applied.ok) {
    st.failedConsecutive += 1;
    yield { type: "edit_failed", failures: applied.failures };
    return {
      resultText: formatFailuresForModel(applied.failures),
      summary: `${applied.failures.length} edit failure(s)`,
    };
  }
  st.failedConsecutive = 0;
  st.scratch = applied.source;
  st.blocks.push(...parsed.edits);
  yield { type: "edit_applied", blocks: parsed.edits };
  const check = await seams.compiler.check(st.scratch);
  st.lastCheck = check;
  // Compile errors win: constraints are only checked on a CLEAN compile.
  const violations =
    seams.constraints && check.ok ? checkConstraints(st.scratch, seams.constraints) : [];
  st.lastViolations = violations;
  st.compileIters += 1;
  yield { type: "iteration", index: st.compileIters, max: seams.max };
  const rendered = renderCheck(check, violations);
  yield { type: "diagnostics", diagnostics: rendered.diagnostics };
  const summary = !check.ok
    ? `applied; ${errorCount(check)} error(s) remain`
    : violations.length
      ? `applied; compiled clean but ${violations.length} constraint violation(s)`
      : `applied; compiled clean (${check.pageCount ?? "?"} page(s))`;
  return {
    resultText: rendered.text,
    summary,
    converged: check.ok && violations.length === 0,
  };
}

/** The string arg at `key`, trimmed, or null when absent/ill-typed/empty. */
function stringArg(args: unknown, key: string): string | null {
  if (!args || typeof args !== "object") return null;
  const value = (args as Record<string, unknown>)[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function* runSearchProject(
  seams: ToolSeams,
  args: unknown,
): AsyncGenerator<AgentEvent, ToolRunResult, void> {
  const pt = seams.projectTools;
  // Defense-in-depth: an un-offered tool can't be dispatched (the loop refuses
  // it as unknown), but a direct registry caller without the seam still gets a
  // graceful result, never a crash.
  if (!pt) {
    return { resultText: "Project tools are not available in this run.", summary: "unavailable" };
  }
  const query = stringArg(args, "query");
  if (query === null) {
    return {
      resultText: "Invalid arguments: 'query' must be a non-empty string.",
      summary: "invalid arguments",
    };
  }
  const result = pt.search(query);
  // Clamp to the registry caps REGARDLESS of what the seam returned: the model
  // context is the asset being protected, so the last line of defense is here.
  // Paths and snippets are user/peer text → sanitized + per-field capped
  // (HIGH-a), and the assembled result is clamped once more at the end.
  const caps = PROJECT_TOOL_CAPS;
  const files = result.files.slice(0, caps.searchMaxFiles);
  let truncated = result.truncated === true || files.length < result.files.length;
  let shown = 0;
  const lines: string[] = [];
  for (const file of files) {
    const matches = file.matches.slice(0, caps.searchMaxMatchesPerFile);
    if (file.truncated === true || matches.length < file.matches.length) truncated = true;
    const safePath = sanitizeEcho(file.path, caps.pathMaxChars);
    for (const m of matches) {
      const snippet = sanitizeEcho(m.snippet.trim(), caps.searchSnippetMaxChars);
      lines.push(`${safePath}:${m.line}: ${snippet}`);
      shown += 1;
    }
  }
  if (shown === 0) {
    return {
      resultText: clampResult(
        `No matches for "${sanitizeEcho(query, caps.queryEchoMaxChars)}".`,
      ),
      summary: "0 matches",
    };
  }
  if (result.totalMatches > shown) truncated = true;
  const head = `Found ${result.totalMatches} match(es); showing ${shown}:`;
  const tail = truncated ? "\n(results truncated — refine the query to see more)" : "";
  return {
    resultText: clampResult(`${head}\n${lines.join("\n")}${tail}`),
    summary: `${shown} match(es) in ${files.length} file(s)${truncated ? " (truncated)" : ""}`,
  };
}

async function* runListFiles(
  seams: ToolSeams,
  _args: unknown,
): AsyncGenerator<AgentEvent, ToolRunResult, void> {
  const pt = seams.projectTools;
  if (!pt) {
    return { resultText: "Project tools are not available in this run.", summary: "unavailable" };
  }
  const all = pt.listFiles();
  const shown = all.slice(0, PROJECT_TOOL_CAPS.listFilesMaxEntries);
  const tail =
    all.length > shown.length
      ? `\n… and ${all.length - shown.length} more (list truncated)`
      : "";
  // Paths are user/peer text: sanitize + cap each echo (HIGH-a), then clamp
  // the assembled list — 200 entries × hostile-length names must still fit.
  const names = shown.map((f) => sanitizeEcho(f.path, PROJECT_TOOL_CAPS.pathMaxChars));
  return {
    resultText: clampResult(`${all.length} file(s) in the project:\n${names.join("\n")}${tail}`),
    summary: `${all.length} file(s)`,
  };
}

async function* runReadFile(
  seams: ToolSeams,
  args: unknown,
): AsyncGenerator<AgentEvent, ToolRunResult, void> {
  const pt = seams.projectTools;
  if (!pt) {
    return { resultText: "Project tools are not available in this run.", summary: "unavailable" };
  }
  const path = stringArg(args, "path");
  if (path === null) {
    return {
      resultText: "Invalid arguments: 'path' must be a non-empty string.",
      summary: "invalid arguments",
    };
  }
  // The path arrives from the model, but it ORIGINATES as user/peer text (the
  // model copies it from list_files), so the echo is sanitized + capped like
  // every other path echo (HIGH-a). The RAW path still does the lookup.
  const safePath = sanitizeEcho(path, PROJECT_TOOL_CAPS.pathMaxChars);
  const text = pt.readFile(path);
  if (text === null) {
    return {
      resultText: clampResult(
        `No file exists at path "${safePath}". Call list_files to see the project's files.`,
      ),
      summary: "file not found",
    };
  }
  const cap = PROJECT_TOOL_CAPS.readFileMaxChars;
  const truncated = text.length > cap;
  const body = truncated ? text.slice(0, cap) : text;
  const tail = truncated
    ? `\n… truncated: showing the first ${cap} of ${text.length} characters …`
    : "";
  // The raw cap above bounds the WORK; the budget bites AFTER numbering via
  // clampResult (HIGH-b): a newline-heavy file would otherwise expand its
  // per-line "NN| " prefixes far past the raw cap.
  return {
    resultText: clampResult(`${lineNumbered(body)}${tail}`),
    summary: `${safePath}: ${body.split("\n").length} lines${truncated ? " (truncated)" : ""}`,
  };
}

/**
 * Render ONE citation as a compact, single-line entry for the model:
 * `key — Author; Author et al. (year). Title. doi:…`.
 *
 * SECURITY: every field here is PEER-writable text — a `.bib` in a shared room
 * is authored by any peer — so each is passed through {@link sanitizeEcho}
 * (escape control chars + cap length). The cite KEY is the sharpest edge: unlike
 * title/author/etc. it is NOT whitespace-collapsed by the parser (it is the raw
 * text before the entry's first comma), so a newline or control char there would
 * otherwise fake a new line of tool output — a prompt-injection channel that must
 * be closed on EVERY field, the key included. Author/editor lists are elided to
 * `bibMaxAuthors` names (+"et al.") so one entry can't dominate the result.
 */
function formatBibEntry(entry: CitationEntry): string {
  const cap = PROJECT_TOOL_CAPS.bibFieldMaxChars;
  const key = sanitizeEcho(entry.key.length > 0 ? entry.key : "ref", cap);
  const bits: string[] = [];
  // Authors, else editors (tagged "(eds.)" so the distinction survives).
  const authors = entry.author && entry.author.length > 0 ? entry.author : undefined;
  const names = authors ?? entry.editor;
  let head = "";
  if (names && names.length > 0) {
    const shown = names.slice(0, PROJECT_TOOL_CAPS.bibMaxAuthors);
    const rendered = shown.map((n) => sanitizeEcho(n, cap)).join("; ");
    const etAl = names.length > shown.length ? " et al." : "";
    const eds = authors ? "" : " (eds.)";
    head = `${rendered}${etAl}${eds}`;
  }
  if (entry.year) head += (head.length > 0 ? " " : "") + `(${sanitizeEcho(entry.year, cap)})`;
  if (head.length > 0) bits.push(head);
  if (entry.title) bits.push(sanitizeEcho(entry.title, cap));
  // One locator, most specific first: DOI, else URL, else the journal/venue.
  const locator = entry.doi
    ? `doi:${entry.doi}`
    : entry.url
      ? entry.url
      : entry.journal;
  if (locator) bits.push(sanitizeEcho(locator, cap));
  return bits.length > 0 ? `${key} — ${bits.join(". ")}` : key;
}

async function* runListBibliography(
  seams: ToolSeams,
  _args: unknown,
): AsyncGenerator<AgentEvent, ToolRunResult, void> {
  const pt = seams.projectTools;
  if (!pt) {
    return { resultText: "Project tools are not available in this run.", summary: "unavailable" };
  }
  const caps = PROJECT_TOOL_CAPS;
  const bibFiles = pt.listFiles().filter((f) => f.path.toLowerCase().endsWith(".bib"));
  if (bibFiles.length === 0) {
    return {
      resultText: "No .bib files in the project — no bibliography to list.",
      summary: "no bibliography",
    };
  }
  // BOUND THE WORK: cap the FILE COUNT and the AGGREGATE source chars fed to the
  // parser, so a hostile project (hundreds of files / a multi-MB .bib) cannot blow
  // parse cost. Honest truncation notes below, never a silent cut.
  const considered = bibFiles.slice(0, caps.bibMaxFiles);
  const filesTruncated = bibFiles.length > considered.length;
  const sources: string[] = [];
  let totalChars = 0;
  let sourceTruncated = false;
  for (const f of considered) {
    const text = pt.readFile(f.path);
    if (text === null) continue;
    const remaining = caps.bibMaxSourceChars - totalChars;
    if (text.length > remaining) {
      // Take only the prefix that fits, then stop. parseBibtex tolerates a
      // truncated trailing entry (its braces never balance ⇒ it is skipped), so a
      // mid-entry cut never corrupts the entries before it.
      sources.push(text.slice(0, remaining));
      sourceTruncated = true;
      break;
    }
    sources.push(text);
    totalChars += text.length;
  }
  // parseBibliography dedupes ACROSS files (DOI, else title+year; first wins) and
  // yields globally-unique keys — the SAME pure pipeline the app's own cite-key
  // features feed on. Never parse per-file (keys would collide across files).
  const entries = parseBibliography(sources.join("\n"));
  if (entries.length === 0) {
    return {
      resultText: "No bibliography entries found in the project's .bib files.",
      summary: "no bibliography",
    };
  }
  const shown = entries.slice(0, caps.bibMaxEntries);
  const entriesTruncated = entries.length > shown.length;
  const lines = shown.map(formatBibEntry);
  const head = entriesTruncated
    ? `Bibliography: ${shown.length} of ${entries.length} entries (truncated):`
    : `Bibliography: ${entries.length} ${entries.length === 1 ? "entry" : "entries"}:`;
  const notes: string[] = [];
  if (filesTruncated) {
    notes.push(`… only the first ${caps.bibMaxFiles} .bib files were read (project truncated)`);
  }
  if (sourceTruncated) {
    notes.push(`… stopped reading .bib files after ${caps.bibMaxSourceChars} characters`);
  }
  const tail = notes.length > 0 ? `\n${notes.join("\n")}` : "";
  const truncated = entriesTruncated || filesTruncated || sourceTruncated;
  // The per-field caps bound each line; clampResult is the last wall on the
  // ASSEMBLED result (many entries can still exceed resultMaxChars).
  return {
    resultText: clampResult(`${head}\n${lines.join("\n")}${tail}`),
    summary: `${shown.length} ${shown.length === 1 ? "entry" : "entries"}${truncated ? " (truncated)" : ""}`,
  };
}

/* eslint-enable require-yield */

// ---------------------------------------------------------------------------
// The registry + derivations.
// ---------------------------------------------------------------------------

/**
 * The shared tool registry, in advertised order. Core trio first (their order
 * is the legacy AGENT_TOOLS order — part of the byte-for-byte contract), then
 * the seam-gated project tools (appended only when the seam exists).
 */
export const TOOL_REGISTRY: readonly ToolRegistryEntry[] = [
  {
    spec: READ_DOCUMENT_SPEC,
    retrievalSpec: RETRIEVAL_READ_DOCUMENT,
    access: "readonly",
    run: runReadDocument,
  },
  { spec: COMPILE_SPEC, access: "readonly", run: runCompile },
  { spec: PROPOSE_EDIT_SPEC, access: "mutating", run: runProposeEdit },
  {
    spec: SEARCH_PROJECT_SPEC,
    access: "readonly",
    requiresProjectSeam: true,
    run: runSearchProject,
  },
  { spec: LIST_FILES_SPEC, access: "readonly", requiresProjectSeam: true, run: runListFiles },
  { spec: READ_FILE_SPEC, access: "readonly", requiresProjectSeam: true, run: runReadFile },
  {
    // ACCEPTED ASYMMETRY (out of scope this lane): the control-mode MCP surface
    // and the in-app loop offer this tool, but after open_project binds the
    // per-project MCP surface the content tools are retired and the per-project
    // ToolSurface has NO bibliography equivalent — read a .bib with read_file
    // there instead. Closing that gap is deliberately deferred.
    spec: LIST_BIBLIOGRAPHY_SPEC,
    access: "readonly",
    requiresProjectSeam: true,
    run: runListBibliography,
  },
];

const CORE_ENTRIES = TOOL_REGISTRY.filter((e) => e.requiresProjectSeam !== true);
const PROJECT_ENTRIES = TOOL_REGISTRY.filter((e) => e.requiresProjectSeam === true);

/**
 * The legacy tool arrays, now DERIVED from the registry (tools.ts and
 * context-view.ts re-export these names). Module-level consts on purpose:
 * run-agent passes the ARRAY IDENTITY through to the model when no project
 * seam is given, and existing tests assert `toBe(AGENT_TOOLS)` — the request
 * payload is provably the same object, not merely an equal one.
 */
export const AGENT_TOOLS: ToolSpec[] = CORE_ENTRIES.map((e) => e.spec);
export const RETRIEVAL_TOOLS: ToolSpec[] = CORE_ENTRIES.map((e) => e.retrievalSpec ?? e.spec);

/** Spec arrays for the project tools (exported for the offered-tools derivation + tests). */
export const PROJECT_TOOL_SPECS: ToolSpec[] = PROJECT_ENTRIES.map((e) => e.spec);

/**
 * The tool specs a run advertises to the model. Without a project seam this
 * RETURNS the legacy array objects themselves (identity, not a copy) — the
 * default-OFF guarantee that pre-existing request payloads are unchanged. With
 * a seam, the project tools append after the core trio.
 */
export function offeredToolSpecs(opts: {
  retrieval: boolean;
  projectTools?: ProjectToolsSeam | undefined;
}): ToolSpec[] {
  const core = opts.retrieval ? RETRIEVAL_TOOLS : AGENT_TOOLS;
  if (!opts.projectTools) return core;
  return [...core, ...PROJECT_TOOL_SPECS];
}

/**
 * Look up the registry entry for a tool call, honoring the seam gate: a
 * project tool WITHOUT the seam resolves to undefined — exactly as unknown as
 * a hallucinated name, so an un-offered tool can never run.
 */
export function offeredEntry(
  name: string,
  hasProjectTools: boolean,
): ToolRegistryEntry | undefined {
  const entry = TOOL_REGISTRY.find((e) => e.spec.name === name);
  if (!entry) return undefined;
  if (entry.requiresProjectSeam === true && !hasProjectTools) return undefined;
  return entry;
}

/**
 * The tool list quoted in the loop's unknown-tool nudge. The core trio keeps
 * the EXACT legacy wording/order ("read_document, propose_edit, compile" —
 * note: NOT the array order) so the default-path tool-result text stays
 * byte-for-byte; project tools append only when offered.
 */
export function availableToolsLine(hasProjectTools: boolean): string {
  const core = ["read_document", "propose_edit", "compile"];
  const names = hasProjectTools
    ? [...core, ...PROJECT_ENTRIES.map((e) => e.spec.name)]
    : core;
  return names.join(", ");
}

