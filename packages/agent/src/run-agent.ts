/**
 * `runAgent` — the iterate-until-clean loop (docs/agent-loop.md "State machine").
 *
 * It seeds a SCRATCH string from the base snapshot and drives the model through
 * its tools (read_document / propose_edit / compile, plus the optional read-only
 * project tools), feeding compiler diagnostics back until the scratch compiles
 * cleanly or a cap is hit. It NEVER touches live document state and NEVER
 * auto-applies — on completion the caller holds the final scratch + accumulated
 * edit blocks to present for Accept/Reject.
 *
 * Determinism: the model and compiler are injected, so the whole loop is
 * unit-testable with a fake model + fake compiler — no provider, no WASM
 * (manifest "Determinism" layer; the core-loop acceptance test).
 *
 * Roadmap #3: tool SPECS and BEHAVIOR live in the shared registry
 * (tool-registry.ts). The loop derives the advertised tool set from it and
 * dispatches each call through the matching entry's `run` (a `yield*`, so
 * mid-tool events keep their exact order and timing) — the loop itself only
 * owns turn/abort/outcome bookkeeping. Without `projectTools` the offered set
 * is the IDENTICAL legacy array and every behavior is byte-for-byte unchanged.
 */

import { DEFAULT_MAX_ITERS } from "@galley/shared";
import type {
  AgentEvent,
  AgentRunOutcome,
  CheckResult,
  EditBlock,
} from "@galley/shared";
import type { LanguageModelClient, ModelMessage, ModelStep } from "./model.js";
import { normalizeNewlines } from "./apply-edits.js";
import { SYSTEM_PROMPT } from "./tools.js";
import {
  DEFAULT_CHUNK_MAX_CHARS,
  DEFAULT_SELECT_MAX_CHARS,
  RETRIEVAL_SYSTEM_PROMPT,
  renderRetrievalRead,
  retrievalActive,
  type RetrievalContextOptions,
} from "./context-view.js";
import {
  hasConstraints,
  type AgentInstructions,
} from "./instructions.js";
import {
  availableToolsLine,
  offeredEntry,
  offeredToolSpecs,
  type ProjectToolsSeam,
  type ToolLoopState,
  type ToolSeams,
} from "./tool-registry.js";

/**
 * What the loop needs from the compiler: a diagnostics-only `check`. A
 * structural subset of `@galley/compiler`'s `Compiler`, injected so the agent
 * package stays decoupled from typst.ts and tests use a fake compiler.
 */
export interface AgentCompiler {
  check(source: string): Promise<CheckResult>;
}

export interface RunAgentOptions {
  userRequest: string;
  /** The document source at the start of the run (the scratch base). */
  baseSource: string;
  baseRevision: number;
  model: LanguageModelClient;
  compiler: AgentCompiler;
  /** Cap on self-correction iterations. Defaults to `DEFAULT_MAX_ITERS` (5). */
  maxIters?: number;
  signal?: AbortSignal;
  /** Stable run id; injectable so tests are deterministic. */
  runId?: string;
  /**
   * Context economics (roadmap #9, default OFF). `{ mode: "full" }` (or omitted) is
   * the unchanged whole-document path. `{ mode: "retrieval" }` makes `read_document`
   * return a SELECTED excerpt — but only for a base source larger than
   * `thresholdChars` (decided once per run, so the tool schema + system prompt are
   * stable mid-run). Small docs are byte-for-byte unchanged.
   */
  context?: RetrievalContextOptions;
  /**
   * `.galley/instructions` steering + deterministic constraints (roadmap 14-D,
   * default OFF). `steering` is appended to the system preamble, clearly
   * delimited; `constraints` become a NON-COMPILE success signal: after a clean
   * compile the scratch must also pass `checkConstraints`, otherwise the
   * violations feed back to the model like compile diagnostics and the loop
   * continues (bounded by the same `maxIters`). Without this option the run is
   * byte-for-byte the original behavior.
   */
  instructions?: AgentInstructions;
  /**
   * Read-only project tools (roadmap #3, default OFF). When present, the run
   * additionally offers `search_project` / `list_files` / `read_file`, all
   * answered through these seams against the project AS IT EXISTS AT CALL TIME
   * (multi-file awareness). Absent — every pre-existing call site — the tools
   * are NOT offered and the model-visible request payload is unchanged (the
   * offered set is the identical legacy array object).
   */
  projectTools?: ProjectToolsSeam;
}

/** The generator's return value: everything the caller needs for the diff/Accept. */
export interface AgentRunResult {
  outcome: AgentRunOutcome;
  /** Final scratch source (base -> this is the reviewable diff). */
  finalSource: string;
  /** Edit blocks that were successfully applied, in order — re-matched on Accept. */
  blocks: EditBlock[];
  /** The last compile result, if any compile happened. */
  check: CheckResult | null;
}

export async function* runAgent(
  opts: RunAgentOptions,
): AsyncGenerator<AgentEvent, AgentRunResult, void> {
  const max = opts.maxIters ?? DEFAULT_MAX_ITERS;
  const runId = opts.runId ?? `run-${opts.baseRevision}`;
  const { model, compiler, signal } = opts;

  // The loop's mutable per-run state, shared with the registry's tool runs
  // (roadmap #3): the runs mutate scratch/blocks/lastCheck/… exactly where the
  // old inline dispatch mutated the loop's locals, and the loop reads it back
  // for outcome classification. `failedConsecutive` bounds a propose-edit
  // *failure* loop: `compileIters` only advances on a SUCCESSFUL apply (it
  // gates the self-correction cap), so a model that keeps proposing edits whose
  // search text never matches would never hit that cap — only the coarse
  // `maxTurns` ceiling far above. Consecutive failed proposals (bad arguments
  // or no apply) bail out once they reach `max`, resetting the moment an edit
  // lands so a normal "miss, then fix" stays cheap.
  const state: ToolLoopState = {
    scratch: normalizeNewlines(opts.baseSource),
    blocks: [],
    lastCheck: null,
    lastViolations: [],
    compileIters: 0,
    failedConsecutive: 0,
  };

  // 14-D deterministic constraints: when active, "clean" means the compile is
  // ok AND the scratch passes `checkConstraints` — violations feed back to the
  // model exactly like compile diagnostics (a non-compile success signal in
  // iterate-until-clean). Inactive (the default, or an inert constraints
  // object): `lastViolations` stays [] forever, so `cleanNow()` degenerates to
  // the original `lastCheck?.ok` and every branch below is byte-for-byte the
  // original behavior.
  const maybeConstraints = opts.instructions?.constraints;
  const constraints = hasConstraints(maybeConstraints) ? maybeConstraints : null;
  const cleanNow = (): boolean =>
    state.lastCheck?.ok === true && state.lastViolations.length === 0;

  // Decide retrieval activation ONCE per run (so the tool schema + system prompt
  // stay stable mid-run). Inactive → the system/tools/read_document path is
  // byte-for-byte the original full-document behaviour.
  const retrieval = retrievalActive(opts.context, opts.baseSource);
  const baseSystem = retrieval ? RETRIEVAL_SYSTEM_PROMPT : SYSTEM_PROMPT;
  // 14-D steering: append the project's `.galley/instructions` prose to the
  // system preamble, clearly delimited. Absent/empty steering leaves the
  // preamble byte-for-byte unchanged.
  const steering = opts.instructions?.steering?.trim();
  const system = steering
    ? `${baseSystem}\n\nProject instructions (from this project's .galley/instructions file — follow them in every edit and answer):\n${steering}`
    : baseSystem;
  // The advertised tool set, derived from the registry. No projectTools (every
  // pre-existing call site) ⇒ the IDENTICAL legacy array object — the request
  // payload is provably unchanged, not merely equal.
  const tools = offeredToolSpecs({ retrieval, projectTools: opts.projectTools });
  const retrievalMaxChars = opts.context?.maxChars ?? DEFAULT_SELECT_MAX_CHARS;
  const retrievalChunkMaxChars = opts.context?.chunkMaxChars ?? DEFAULT_CHUNK_MAX_CHARS;

  // The seams a registry tool run may touch. `retrieval.render` closes over the
  // LIVE state (scratch + lastCheck at call time), mirroring the old inline
  // read_document branch; the registry stays free of context-view imports.
  const hasProjectTools = opts.projectTools !== undefined;
  const seams: ToolSeams = {
    state,
    compiler,
    max,
    constraints,
    retrieval: retrieval
      ? {
          active: true,
          render: (args) =>
            renderRetrievalRead(
              args,
              {
                scratch: state.scratch,
                userRequest: opts.userRequest,
                lastCheck: state.lastCheck,
                maxChars: retrievalMaxChars,
                chunkMaxChars: retrievalChunkMaxChars,
              },
              opts.context?.ranker,
            ),
        }
      : { active: false },
    ...(opts.projectTools ? { projectTools: opts.projectTools } : {}),
  };

  const result = (outcome: AgentRunOutcome): AgentRunResult => ({
    outcome,
    finalSource: state.scratch,
    blocks: state.blocks,
    check: state.lastCheck,
  });

  yield { type: "run_started", runId, baseRevision: opts.baseRevision };

  if (signal?.aborted) {
    yield { type: "run_finished", runId, outcome: "cancelled" };
    return result("cancelled");
  }

  const messages: ModelMessage[] = [{ role: "user", content: opts.userRequest }];

  // Bound total model turns so a misbehaving model can't loop forever even if it
  // never triggers the compile-iteration cap (e.g. only ever reads).
  const maxTurns = max * 3 + 4;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) {
      yield { type: "run_finished", runId, outcome: "cancelled" };
      return result("cancelled");
    }

    let step: ModelStep;
    // Did the streaming path already emit the assistant text as chunks? If so,
    // we must NOT re-emit the whole `step.text` below (that would double-count).
    let textAlreadyStreamed = false;
    try {
      const turnInput = { system, messages, tools, ...(signal ? { signal } : {}) };
      if (model.stepStream) {
        // Streaming turn: drive the generator, emitting each incremental text
        // delta as its own `assistant_text` chunk (reusing the event — the UI
        // accumulates consecutive chunks into one growing block). The generator
        // RETURNS the final ModelStep (full text + tool calls). Tool execution
        // and outcome classification below are SHARED with the non-streaming path.
        const stream = model.stepStream(turnInput);
        let streamed = "";
        let delta = await stream.next();
        while (!delta.done) {
          const chunk = delta.value.text;
          if (chunk) {
            streamed += chunk;
            yield { type: "assistant_text", text: chunk };
          }
          delta = await stream.next();
        }
        step = delta.value;
        // Streamed any text? Then the whole-step emit below is suppressed. If the
        // client streamed nothing but the final step still carries text, fall
        // through and let the shared emit below surface it once.
        textAlreadyStreamed = streamed.length > 0;
      } else {
        step = await model.step(turnInput);
      }
    } catch (err) {
      // Abort wins: if the run was cancelled, the model call almost always
      // throws *because* of the abort (AbortError). Reporting "cancelled"
      // reflects user intent, not the incidental error the abort caused.
      if (signal?.aborted) {
        yield { type: "run_finished", runId, outcome: "cancelled" };
        return result("cancelled");
      }
      const message = err instanceof Error ? err.message : String(err);
      yield { type: "error", message };
      yield { type: "run_finished", runId, outcome: "error" };
      return result("error");
    }

    // Abort wins, even when the step resolved NORMALLY. A non-streaming
    // `model.step()` throws on abort (handled above), but a streaming
    // `stepStream()` can observe the abort, break, and RETURN a final step — so
    // re-check here, BEFORE pushing the assistant message or running any tool, so
    // a Stop never leaks post-abort side effects (edit_applied/compile) or a
    // wrong terminal outcome. Same `cancelled` idiom as the top of the loop.
    if (signal?.aborted) {
      yield { type: "run_finished", runId, outcome: "cancelled" };
      return result("cancelled");
    }

    if (step.text && !textAlreadyStreamed) yield { type: "assistant_text", text: step.text };
    messages.push({
      role: "assistant",
      content: step.text,
      ...(step.toolCalls.length ? { toolCalls: step.toolCalls } : {}),
    });

    if (step.toolCalls.length === 0) {
      // Terminal classification (the AgentRunOutcome enum is the fixed contract,
      // docs/agent-loop.md): no edits => a question/answer; clean => converged;
      // otherwise the model stopped with unresolved errors. The last bucket is
      // labelled `max_iters_reached` — the enum's catch-all for "stopped, still
      // with errors" — and gets the same UI treatment (present + warn) whether
      // the model gave up early or the cap was hit.
      const outcome: AgentRunOutcome =
        state.blocks.length === 0 ? "no_edits" : cleanNow() ? "compiled_clean" : "max_iters_reached";
      yield { type: "run_finished", runId, outcome };
      return result(outcome);
    }

    let converged = false;
    for (const call of step.toolCalls) {
      // Re-check the abort BETWEEN tool calls in a batch (L1-C3): a Stop pressed
      // mid-batch must not keep running the remaining calls (wasted compiles +
      // post-abort events). Same `cancelled` idiom as the top of the loop and the
      // post-stepStream check, so a Stop always yields one clean terminal outcome.
      if (signal?.aborted) {
        yield { type: "run_finished", runId, outcome: "cancelled" };
        return result("cancelled");
      }
      yield { type: "tool_call", tool: call.name, args: call.args };
      let resultText: string;
      let summary: string;

      // Registry dispatch (roadmap #3): resolve the call against the OFFERED
      // entries — a project tool without the seam is exactly as unknown as a
      // hallucinated name, so an un-offered tool can never run. `yield*`
      // forwards the run's events with their original order and timing.
      const entry = offeredEntry(call.name, hasProjectTools);
      if (entry) {
        let ran;
        try {
          ran = yield* entry.run(seams, call.args);
        } catch (err) {
          // Abort wins: a Stop pressed mid-tool-run almost always surfaces as a
          // rejection (the seam's compile/check observes the abort and throws), so
          // report user intent rather than the incidental error. Same idiom as the
          // model-call catch above.
          if (signal?.aborted) {
            yield { type: "run_finished", runId, outcome: "cancelled" };
            return result("cancelled");
          }
          // A tool/seam rejection must not escape runAgent as an unhandled
          // rejection — that breaks the terminal-event contract (every run ends in
          // exactly one run_finished). Surface it as an error terminal instead.
          const message = err instanceof Error ? err.message : String(err);
          yield { type: "error", message };
          yield { type: "run_finished", runId, outcome: "error" };
          return result("error");
        }
        resultText = ran.resultText;
        summary = ran.summary;
        if (ran.converged === true) converged = true;
      } else {
        // A hallucinated / unsupported tool name. Surface it to the model as a
        // tool-result error (so it can correct on the next turn) instead of
        // silently routing it into propose_edit/parseEdits, and don't crash the loop.
        resultText = `Unknown tool "${call.name}". Available tools: ${availableToolsLine(hasProjectTools)}.`;
        summary = `unknown tool: ${call.name}`;
      }

      yield { type: "tool_result", tool: call.name, summary };
      messages.push({
        role: "tool",
        content: resultText,
        toolCallId: call.id,
        toolName: call.name,
      });
    }

    // A Stop landing during the LAST tool call of a batch (e.g. while its compile
    // was in flight) must win over the batch's result — otherwise an abort during
    // a converging compile would still report compiled_clean (L1-C3, completeness
    // beyond the between-calls check above).
    if (signal?.aborted) {
      yield { type: "run_finished", runId, outcome: "cancelled" };
      return result("cancelled");
    }
    if (converged) {
      yield { type: "run_finished", runId, outcome: "compiled_clean" };
      return result("compiled_clean");
    }
    if (state.compileIters >= max && !cleanNow()) {
      yield { type: "run_finished", runId, outcome: "max_iters_reached" };
      return result("max_iters_reached");
    }
    // A run that only ever fails to apply edits never advances `compileIters`,
    // so the cap above can't catch it. Bail once consecutive failures reach the
    // same `max` budget — "stopped, still with errors" → max_iters_reached.
    if (state.failedConsecutive >= max) {
      yield { type: "run_finished", runId, outcome: "max_iters_reached" };
      return result("max_iters_reached");
    }
  }

  // Exhausted the total turn budget (a model that never finalizes). Same
  // catch-all classification as a voluntary stop with unresolved errors.
  const outcome: AgentRunOutcome = cleanNow()
    ? "compiled_clean"
    : state.blocks.length > 0
      ? "max_iters_reached"
      : "no_edits";
  yield { type: "run_finished", runId, outcome };
  return result(outcome);
}
