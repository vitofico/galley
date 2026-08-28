/**
 * The agent's tools (docs/agent-loop.md "Tools exposed to the model") plus the
 * pure helpers that format tool output for the model and the UI.
 *
 *   read_document — the scratch source, line-numbered (reference only; edits use
 *                   search/replace, never line numbers).
 *   propose_edit  — apply search/replace blocks to the scratch, then auto-check.
 *   compile       — check the scratch for diagnostics + page count.
 *
 * Roadmap #3: the spec literals, the formatting helpers, and the tool BEHAVIOR
 * now live in the shared tool registry (tool-registry.ts) — the single source
 * of truth both the internal loop and the (future) MCP surface consume.
 * `AGENT_TOOLS` is a DERIVATION from that registry; this module re-exports it
 * (plus the helpers) so every existing import path keeps working unchanged.
 * Only the system prompt remains defined here: it is loop-surface copy, not a
 * registry concern (the MCP surface has its own envelope, not a prompt).
 */

export {
  AGENT_TOOLS,
  formatCheckForModel,
  formatFailuresForModel,
  lineNumbered,
  parseEdits,
} from "./tool-registry.js";

export const SYSTEM_PROMPT = `You are Galley's editing agent for Typst documents.
You operate on a scratch copy of the document; the human reviews your changes
before anything is applied. Use the tools to inspect and edit it:

- read_document: get the current scratch source, with line numbers for reference.
- propose_edit: apply one or more search/replace edits, then auto-compile. Every
  "search" must match EXACTLY ONCE — include enough surrounding context to be
  unique. Edits in a batch apply in order. Never put line numbers in "search";
  match on the document text itself.
- compile: compile the scratch and return diagnostics + page count.

Work iteratively: after editing, read the compiler diagnostics and fix any
errors with further edits until the document compiles cleanly. When you are done
(or if the request was a question that needs no edit), reply with a short final
message and make no tool call.`;
