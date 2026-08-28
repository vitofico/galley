/**
 * Agent event stream.
 *
 * The agent loop emits a stream of typed events the UI renders as live
 * progress. We stream PROGRESS, TOOL CALLS, DIAGNOSTICS, and ASSISTANT TEXT —
 * not raw model "reasoning" (which not all providers expose). See
 * docs/agent-loop.md ("Event stream").
 */

import type { Diagnostic } from "./diagnostics.js";
import type { EditBlock, EditFailure } from "./edits.js";

export type AgentEvent =
  | { type: "run_started"; runId: string; baseRevision: number }
  | { type: "assistant_text"; text: string } // incremental assistant message chunk
  | { type: "tool_call"; tool: AgentToolName; args: unknown }
  | { type: "tool_result"; tool: AgentToolName; summary: string }
  | { type: "iteration"; index: number; max: number }
  | { type: "diagnostics"; diagnostics: Diagnostic[] }
  | { type: "edit_applied"; blocks: EditBlock[] }
  | { type: "edit_failed"; failures: EditFailure[] }
  | { type: "run_finished"; runId: string; outcome: AgentRunOutcome }
  | { type: "error"; message: string };

/**
 * Every tool name the agent loop can advertise: the core trio plus the
 * read-only project tools (roadmap #3 — offered only when the run is given a
 * `projectTools` seam, default OFF). This union is the event-stream AND
 * model-seam contract; consumers render the name as opaque text (no exhaustive
 * switch on it exists), so adding a name here is additive for every consumer.
 */
export type AgentToolName =
  | "read_document"
  | "propose_edit"
  | "compile"
  | "search_project"
  | "list_files"
  | "read_file"
  | "list_bibliography";

export type AgentRunOutcome =
  | "compiled_clean" // converged: scratch compiles with no errors
  | "max_iters_reached" // stopped at the cap, possibly still with errors
  | "no_edits" // model answered without proposing any edit
  | "cancelled"
  | "error";
