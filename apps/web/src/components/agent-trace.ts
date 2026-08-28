/**
 * Deep agent pane — pure trace helpers (roadmap #15, first slice).
 *
 * DISPLAY-ONLY. These functions render the EXISTING `AgentEvent` stream into a
 * richer, chronological, collapsible trace. They never touch the run loop, the
 * Accept gate, or any write path, and they invent NO new event fields — every
 * row is derived from data already on the `AgentEvent` union.
 *
 * Split out of AgentPanel.tsx so the ordering/coalescing/role logic is a pure
 * function with unit tests (the repo's test layer is the `node` env, no jsdom).
 */

import type { AgentEvent } from "@galley/shared";

/** A non-text agent event — everything except the streamed `assistant_text`. */
export type StepEvent = Exclude<AgentEvent, { type: "assistant_text" }>;

/**
 * A trace row: either a coalesced run of consecutive `assistant_text` chunks
 * (one growing message), or a single non-text STEP event. Rows preserve the
 * arrival order of `agent.events`, so the streamed assistant text and the
 * tool/iteration/diagnostics steps INTERLEAVE chronologically — text does not
 * pool to the top and steps to the bottom.
 */
export type TraceRow =
  | { kind: "text"; text: string }
  | { kind: "event"; event: StepEvent };

/**
 * Coalesce the flat event stream into ordered trace rows. Consecutive
 * `assistant_text` chunks merge into one growing `text` row (token-level
 * streaming yields many tiny chunks per turn); a non-text event flushes the
 * current text run and starts a fresh row after it — so a later assistant turn
 * that follows a tool step becomes its OWN text row, correctly interleaved.
 */
export function coalesce(events: readonly AgentEvent[]): TraceRow[] {
  const rows: TraceRow[] = [];
  for (const event of events) {
    if (event.type === "assistant_text") {
      const last = rows[rows.length - 1];
      if (last && last.kind === "text") last.text += event.text;
      else rows.push({ kind: "text", text: event.text });
    } else {
      rows.push({ kind: "event", event });
    }
  }
  return rows;
}

/**
 * Coarse visual ROLE for a step event, used to pick a stable row style. Groups
 * the union into a few buckets the eye can scan: the model calling a tool, a
 * tool's result, a compile-diagnostics summary, lifecycle markers, and errors.
 */
export type StepRole = "tool_call" | "tool_result" | "diagnostics" | "lifecycle" | "error";

export function stepRole(event: StepEvent): StepRole {
  switch (event.type) {
    case "tool_call":
      return "tool_call";
    case "tool_result":
      return "tool_result";
    case "diagnostics":
      // A clean compile reads as lifecycle; errors read as the diagnostics role.
      return event.diagnostics.some((d) => d.severity === "error") ? "diagnostics" : "lifecycle";
    case "edit_failed":
    case "error":
      return "error";
    case "run_started":
    case "iteration":
    case "edit_applied":
    case "run_finished":
      return "lifecycle";
  }
}

/**
 * Hard cap on the rendered args fragment (chars). Honors the SEC-22.2 posture:
 * `args` arrives as `unknown` (model-controlled, possibly huge/hostile), so the
 * rendering is BOUNDED — a giant arg can never blow up the trace row. Ellipsized
 * past the cap. Kept modest so the args stay visually SECONDARY to the tool name.
 */
export const ARGS_MAX_LEN = 120;

/**
 * Matches RAW control characters (C0 NUL..US plus DEL). Built from `\u` escapes
 * so no raw control byte ever lives in this source file. Defence-in-depth: a
 * control byte riding inside a key/value can't break the single-line row layout.
 */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]+", "g");

/**
 * Matches the textual control-char ESCAPES that `JSON.stringify` emits for a
 * control byte inside a string: the short forms `\n \r \t \f \b` and the long
 * `\u00xx` form. These are ordinary characters in the serialized JSON
 * (a backslash + letters), so they'd otherwise survive into the row as literal
 * "\n" noise — collapse them to a single space so the args read as one tidy line.
 */
const JSON_CONTROL_ESCAPES = /\\(?:[nrtfb]|u00[01][0-9a-fA-F]|u007[fF])/g;

/**
 * Compact, SAFE, human-readable rendering of a tool call's `args` for the trace.
 *
 * `args` is `unknown` and may be hostile: huge, deeply nested, circular, or
 * carrying control bytes. This is DISPLAY-ONLY, so it is defensive end-to-end:
 *   - control characters (incl. raw newlines/tabs) are collapsed to spaces so
 *     nothing injects extra lines or escape sequences into the row,
 *   - the result is hard-capped to {@link ARGS_MAX_LEN} chars and ellipsized,
 *   - non-serializable / circular / `undefined` payloads FAIL SOFT (a safe
 *     placeholder), never throwing.
 *
 * Returns "" when there is nothing meaningful to show (empty object, `null`,
 * `undefined`, or a value JSON can't represent) so the caller renders no extra
 * fragment — the tool_call line stays byte-for-byte as before when args is empty.
 */
export function describeArgs(args: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(args);
  } catch {
    // Circular reference / non-serializable (bigint, throwing toJSON, …).
    return "…";
  }
  // `undefined`, a function, or a symbol stringify to `undefined` → nothing to show.
  if (json === undefined) return "";
  // `null` / an empty object / an empty array carry no information — no fragment.
  if (json === "null" || json === "{}" || json === "[]") return "";
  // Neutralize control chars both as raw bytes (defence-in-depth) AND as the
  // textual "\n"/"\t"/"\u00xx" escapes JSON.stringify emits, so neither injects
  // extra lines nor leaks escape noise into the row; collapse whitespace runs.
  const clean = json
    .replace(CONTROL_CHARS, " ")
    .replace(JSON_CONTROL_ESCAPES, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (clean === "") return "";
  return clean.length > ARGS_MAX_LEN ? clean.slice(0, ARGS_MAX_LEN - 1) + "…" : clean;
}

/** One-line summary of a non-text step event for the live trace. */
export function describe(event: StepEvent): string {
  switch (event.type) {
    case "run_started":
      return "▶ run started";
    case "tool_call": {
      // Show WHAT the agent called the tool with, not just the name. Args are
      // rendered compactly + safely (capped, control-stripped, fail-soft); when
      // there's nothing to show the line is byte-for-byte the old `🔧 name`.
      const argsText = describeArgs(event.args);
      return argsText ? `🔧 ${event.tool} ${argsText}` : `🔧 ${event.tool}`;
    }
    case "tool_result":
      return `↳ ${event.summary}`;
    case "iteration":
      return `↻ iteration ${event.index}/${event.max}`;
    case "diagnostics": {
      const errs = event.diagnostics.filter((d) => d.severity === "error").length;
      return errs > 0 ? `⚠ ${errs} error(s)` : "✓ compiled clean";
    }
    case "edit_applied":
      return `✎ applied ${event.blocks.length} edit(s)`;
    case "edit_failed":
      return `✗ ${event.failures.length} edit failure(s)`;
    case "run_finished":
      return `■ finished: ${event.outcome}`;
    case "error":
      return `error: ${event.message}`;
  }
}

/** Whether a row is a collapsible STEP (vs the always-visible assistant text). */
export function isStepRow(row: TraceRow): boolean {
  return row.kind === "event";
}

// ---------------------------------------------------------------------------
// Collapse-toggle persistence — mirrors focus-mode.ts's `galley.*` pattern.
// A tiny inline helper (no new dependency); importing has ZERO side effects.
// ---------------------------------------------------------------------------

/** localStorage key the "show step detail" preference is persisted under. */
export const TRACE_STEPS_KEY = "galley.agentTraceSteps";

/** The minimal storage surface this helper needs (a subset of `Storage`). */
export interface TraceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): TraceStorage | null {
  const s = (globalThis as { localStorage?: TraceStorage }).localStorage;
  return s ?? null;
}

/**
 * Read the persisted "show step detail" flag. Defaults to `true` (steps SHOWN)
 * when unset, invalid, or storage is unavailable — so the default panel reads
 * essentially as before.
 */
export function loadShowSteps(storage?: TraceStorage | null): boolean {
  const s = storage === undefined ? defaultStorage() : storage;
  if (!s) return true;
  try {
    // Only an explicit "0" hides steps; anything else (incl. unset) → shown.
    return s.getItem(TRACE_STEPS_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Persist the "show step detail" flag. Best-effort — failures are swallowed. */
export function saveShowSteps(show: boolean, storage?: TraceStorage | null): void {
  const s = storage === undefined ? defaultStorage() : storage;
  if (!s) return;
  try {
    s.setItem(TRACE_STEPS_KEY, show ? "1" : "0");
  } catch {
    /* persistence is best-effort */
  }
}
