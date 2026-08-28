/**
 * Drives an agent run: streams `runAgent` events into state and holds the final
 * result for diff review. The agent gets its OWN compiler instance (a second
 * worker) so its scratch compiles never contend with — or get cancelled by —
 * the live preview (scratch isolation; docs/architecture.md).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { runAgent } from "@galley/agent";
import type {
  AgentInstructions,
  AgentRunResult,
  LanguageModelClient,
  ProjectToolsSeam,
  RetrievalContextOptions,
} from "@galley/agent";
import type { AgentEvent, CompileInput } from "@galley/shared";
import type { Compiler } from "@galley/compiler";
import { initCompiler } from "./compiler-assets.js";
import { accumulateUsage, type UsageEstimate } from "./cost-estimate.js";

/**
 * Transforms the agent's scratch (the active document text) into the compile
 * input used for self-correction. Single-file: identity (the scratch IS the
 * input). Multi-file: substitute the scratch into the whole project so the
 * agent's `check` sees cross-file imports + project-wide diagnostics.
 */
export type BuildCheckInput = (scratch: string) => CompileInput;

export interface AgentState {
  running: boolean;
  events: AgentEvent[];
  result: AgentRunResult | null;
  /** The source the run started from (for conflict-aware Accept). */
  baseSource: string | null;
  error: string | null;
  /**
   * True when the LAST run ended because the user pressed Stop (an abort) rather
   * than finishing or erroring. A clean stopped state: not running, no error,
   * partial trace retained. Reset on the next `run`/`clear`.
   */
  stopped: boolean;
}

const IDLE: AgentState = {
  running: false,
  events: [],
  result: null,
  baseSource: null,
  error: null,
  stopped: false,
};

/**
 * The end-of-run state patch, as a PURE function of how the run ended. Extracted
 * so the abort→clean-stopped contract is unit-testable without a DOM/React env:
 *   - aborted  → clean STOPPED state: not running, no error, no held result.
 *   - finished → not running, holds the result for diff review.
 *   - threw    → not running, surfaces the error.
 * An abort ALWAYS wins over a thrown error (a user Stop typically makes the
 * in-flight model call throw an AbortError — that is not an error to show).
 */
export function endOfRun(
  outcome:
    | { kind: "aborted" }
    | { kind: "finished"; result: AgentRunResult }
    | { kind: "threw"; error: unknown },
): Pick<AgentState, "running" | "result" | "error" | "stopped"> {
  if (outcome.kind === "aborted") {
    return { running: false, stopped: true, result: null, error: null };
  }
  if (outcome.kind === "finished") {
    return { running: false, stopped: false, result: outcome.result, error: null };
  }
  const error = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
  return { running: false, stopped: false, result: null, error };
}

export function useAgent() {
  const compilerRef = useRef<Compiler | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const [state, setState] = useState<AgentState>(IDLE);

  // Abort any in-flight run and stop updating state once unmounted.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      compilerRef.current?.dispose();
      compilerRef.current = null;
    };
  }, []);

  const set: typeof setState = (update) => {
    if (mountedRef.current) setState(update);
  };

  const run = useCallback(
    async (
      request: string,
      baseSource: string,
      model: LanguageModelClient,
      buildInput?: BuildCheckInput,
      context?: RetrievalContextOptions,
      instructions?: AgentInstructions,
      projectTools?: ProjectToolsSeam,
    ) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    set({ running: true, events: [], result: null, baseSource, error: null, stopped: false });
    try {
      if (!compilerRef.current) compilerRef.current = await initCompiler();
      // For a project, wrap the compiler so the agent's scratch is checked in the
      // whole-project context (cross-file imports resolve); single-file passes the
      // scratch straight through.
      const base = compilerRef.current;
      const compiler = buildInput ? { check: (s: string) => base.check(buildInput(s)) } : base;
      const gen = runAgent({
        userRequest: request,
        baseSource,
        baseRevision: 0,
        model,
        compiler,
        signal: controller.signal,
        // Retrieval auto-engages only past the size threshold (roadmap #9/#14); a
        // small doc is byte-for-byte the same path. Absent when no context given.
        ...(context ? { context } : {}),
        // 14-D: the project's `.galley/instructions` steering + deterministic
        // constraints. Absent → spread nothing → byte-for-byte the original run.
        ...(instructions ? { instructions } : {}),
        // #3: the read-only project tools seam (search/list/read across the
        // live project). Absent → spread nothing → the offered tool set and the
        // request payload are byte-for-byte the original run.
        ...(projectTools ? { projectTools } : {}),
      });
      let next = await gen.next();
      while (!next.done) {
        // A superseded run (a newer `run()` already replaced `abortRef`) must stop
        // writing: don't append its trailing events onto the NEW run's array, and
        // stop pulling its generator so it can't keep streaming. We return outright
        // (not break) so the superseded driver also skips its terminal patch.
        if (abortRef.current !== controller) return;
        const event = next.value;
        set((s) => ({ ...s, events: [...s.events, event] }));
        next = await gen.next();
      }
      // A user Stop (abort) yields a CLEAN stopped state — never a held result or
      // an error — even though the generator returns a "cancelled" result. The
      // partial trace stays for context; no DiffReview is offered.
      const patch = controller.signal.aborted
        ? endOfRun({ kind: "aborted" })
        : endOfRun({ kind: "finished", result: next.value });
      // Only the CURRENT run may apply its terminal patch; a superseded driver
      // must not clobber the in-flight run's state.
      if (abortRef.current === controller) set((s) => ({ ...s, ...patch }));
    } catch (err) {
      // An abort that surfaces as a thrown AbortError is still a clean Stop, not
      // an error: the run was cancelled by the user, so present the stopped state.
      const patch = controller.signal.aborted
        ? endOfRun({ kind: "aborted" })
        : endOfRun({ kind: "threw", error: err });
      if (abortRef.current === controller) set((s) => ({ ...s, ...patch }));
    }
  }, []);

  const cancel = useCallback(() => abortRef.current?.abort(), []);
  const clear = useCallback(() => setState(IDLE), []);

  // Live, ESTIMATED token/cost usage derived from the events collected so far.
  // Additive: a rough meter for UX, recomputed as events stream in. See
  // cost-estimate.ts — this is not billing-grade. Rates are intentionally left
  // unset here (provider-agnostic); a caller wanting cost can re-accumulate
  // `events` with rates. Memoized on the events array so an unrelated re-render
  // (or a streamed event in a sibling) doesn't re-scan the whole trace.
  const usage: UsageEstimate = useMemo(() => accumulateUsage(state.events), [state.events]);

  return { ...state, run, cancel, clear, usage };
}
