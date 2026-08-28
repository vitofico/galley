import { useEffect, useRef, useState } from "react";
import type {
  AgentInstructions,
  LanguageModelClient,
  ProjectToolsSeam,
  RetrievalContextOptions,
  ListModelsResult,
} from "@galley/agent";
import { useAgent, type BuildCheckInput } from "../useAgent.js";
import { buildRefineRun } from "../refine-run.js";
import { DiffReview } from "./DiffReview.js";
import { adviceOnlyModel } from "./explain-error.js";
import { coalesce } from "./agent-trace.js";
import { useAgentSessions } from "./useAgentSessions.js";
import { makeMessage } from "./agent-sessions.js";
import { SessionBar } from "./SessionBar.js";
import { AgentTranscript } from "./AgentTranscript.js";
import { AgentComposer } from "./AgentComposer.js";
import { composeAgentRequest, type MentionableFile } from "./agent-mentions.js";
import { decideInAppAuto } from "../in-app-auto.js";
import { appendInAppAudit } from "../in-app-audit.js";
import type { AgentAcceptanceMode } from "../agent-acceptance-mode.js";
import "./agent-ux.css";
import "./agent-redesign.css";

/** One-off example prompt the composer is seeded with; clears on first focus. */
const DEMO_SEED_REQUEST = "Add a demo section to the document.";

/**
 * The IN-APP auto-apply seam (ADR-0025 §4). When provided AND the project is in
 * Auto mode with a mutating role, a finished run is applied through the SAME
 * conflict-aware accept path the manual Accept uses — but only after a pre-apply
 * checkpoint (the Undo target). ANY failure falls back to the Ask `DiffReview`
 * gate. Absent (the single-file shell, or a host with no checkpoint/version API)
 * → the panel is byte-for-byte unchanged: every run shows the Ask gate.
 */
export interface InAppAutoSeam {
  /** The project id (keys the local in-app audit). */
  projectId: string;
  /** Read the project's in-app acceptance mode FRESH at run-finish. */
  mode: () => AgentAcceptanceMode;
  /** Whether the local role may mutate the doc (a viewer never auto-applies). */
  canMutate: boolean;
  /** Take a restorable pre-apply checkpoint; resolves to its version id or null. */
  checkpoint: (request: string) => Promise<string | null>;
  /**
   * The HARDENED final apply (H2). Runs INSIDE ProjectApp, AFTER the checkpoint,
   * and RE-READS LIVE — the project's acceptance mode, `canMutate`, and the active
   * file id + current text — then runs the conflict-aware `resolveAccept` against
   * that FRESH text before `applyAcceptedFileAsAgent`. Returns `true` only if it
   * actually applied; `false` (a flip to Ask, a role drop, or a concurrent edit /
   * conflict) means the caller must FALL BACK to the Ask gate. Never uses the
   * run-finish React closure for any of the gated values.
   */
  commit: (run: {
    baseSource: string;
    finalSource: string;
    blocks: { search: string; replace: string }[];
  }) => boolean;
  /** Restore a checkpoint version (the Undo action). */
  restore: (versionId: string) => void;
  /**
   * Optional: notify the host that the in-app audit changed (a run auto-applied
   * or failed) so it can refresh any merged audit view (the Agent access panel,
   * ADR-0025 §5). Best-effort — never throws across the seam.
   */
  onAudited?: () => void;
}

/** The inline "auto-applied this run" summary + Undo state shown post-apply. */
interface AppliedSummary {
  runId: string;
  request: string;
  outcome: string;
  checkpointVersionId: string;
  undone: boolean;
}

/** A transient notification shown inside the agent section. */
interface Toast {
  id: number;
  kind: "finished" | "stopped" | "error";
  message: string;
}

const TOAST_TTL_MS = 5000;

/**
 * Extract the run's id (ADR-0025 §4) from its event stream. The runId is carried
 * on `run_started`/`run_finished`; we prefer `run_finished` (the terminal event)
 * and fall back to `run_started`. Returns null if neither is present (e.g. a
 * legacy/stubbed run) — the caller then omits runId (it is a hint, never required).
 */
function runIdFromEvents(events: { type: string; runId?: string }[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.type === "run_finished" && typeof e.runId === "string") return e.runId;
  }
  for (const e of events) {
    if (e && e.type === "run_started" && typeof e.runId === "string") return e.runId;
  }
  return null;
}

export function AgentPanel({
  model,
  source,
  onAccept,
  buildCheckInput,
  showCostMeter = false,
  tokenBudget,
  context,
  pendingRun,
  instructions,
  projectTools,
  onEditInstructions,
  instructionsActive = false,
  threadId,
  mentionFiles,
  modelPicker,
  autoAccept,
}: {
  model: LanguageModelClient;
  source: string;
  /** Apply the run's edits to the live document (conflict-aware). Returns true if applied. */
  onAccept: (result: {
    baseSource: string;
    finalSource: string;
    blocks: { search: string; replace: string }[];
  }) => boolean;
  /**
   * Optional: transform the scratch into a whole-project compile input for the
   * agent's self-correction (multi-file projects). Omit for single-file.
   */
  buildCheckInput?: BuildCheckInput;
  /**
   * Optional: show the ESTIMATED token/cost meter. Defaults OFF so the panel's
   * output is byte-for-byte unchanged (the agent e2e suite asserts on it).
   */
  showCostMeter?: boolean;
  /** Optional soft token budget; when the estimate exceeds it, a warning shows. */
  tokenBudget?: number;
  /**
   * Optional retrieval/context options (roadmap #9/#14). When provided, the
   * agent's `read_document` becomes retrieval-aware ONLY past a size threshold
   * (small docs are unchanged); omitted = the whole-doc path, byte-for-byte.
   */
  context?: RetrievalContextOptions;
  /**
   * Optional externally-triggered run (roadmap #11.4b quick-fix): when `nonce`
   * changes, the panel fills the request with `request` and starts a run — still
   * producing a reviewable diff (Accept stays mandatory; never auto-applied). The
   * default-OFF case (prop absent) leaves the panel byte-for-byte unchanged.
   *
   * `adviceOnly` (roadmap #18.4 explain-error) marks the run as ADVICE: the
   * model is wrapped so `propose_edit` is stripped (the document can never
   * change) and the completed run shows NO diff/Accept gate — the streamed
   * text IS the result. Absent/false keeps the quick-fix path byte-for-byte.
   */
  pendingRun?: { request: string; nonce: number; adviceOnly?: boolean };
  /**
   * Optional `.galley/instructions` steering + deterministic constraints
   * (roadmap 14-D). Threaded to `agent.run` at every call site so the loop
   * honors the project's instructions. Absent (the default, and always for the
   * single-file shell) → the agent run is byte-for-byte unchanged.
   */
  instructions?: AgentInstructions;
  /**
   * Optional read-only project tools seam (roadmap #3): lets the agent
   * search/list/read the whole live project (search_project / list_files /
   * read_file), default OFF. Threaded to `agent.run` at every call site.
   * Absent (the default, and always for the single-file shell) → the offered
   * tool set and the request payload are byte-for-byte unchanged.
   */
  projectTools?: ProjectToolsSeam;
  /**
   * Optional 14-D authoring hook: open the project-instructions editor. When
   * provided, a small header button surfaces it (and whether instructions are
   * currently active). Absent → no button, byte-for-byte unchanged.
   */
  onEditInstructions?: () => void;
  /** Whether the project has live `.galley/instructions` (a subtle "active" hint). */
  instructionsActive?: boolean;
  /**
   * Optional #15 @-mention seam: a lazy getter for the project's live files
   * (canonical path + text). When provided, typing `@<path>` in the composer
   * offers a suggestion list and attaches the referenced files' contents to the
   * run as extra context. Absent (the single-file shell) → no suggestions and the
   * request is byte-for-byte unchanged.
   */
  mentionFiles?: () => MentionableFile[];
  /**
   * Optional project/room id that keys the persisted multi-session conversation
   * history (#15). Two projects with different ids keep isolated histories.
   * Absent (e.g. the single-file shell, which has no room id to thread) → a
   * single default key. DISPLAY + LOCAL-STATE ONLY — the sessions never touch the
   * document.
   */
  threadId?: string;
  /**
   * Optional #15 model picker: the current model id, a lazy lister (the provider's
   * available models via its API — direct/Ollama only), and a setter. When
   * provided, a compact "Model: …" control lets the author switch the model the
   * run uses. Absent (Demo model / single-file shell) → no control, byte-for-byte
   * unchanged.
   */
  modelPicker?: {
    current: string;
    list: () => Promise<ListModelsResult>;
    onSelect: (modelId: string) => void;
  };
  /**
   * Optional in-app Auto seam (ADR-0025 §4). When present and the project is in
   * Auto mode (with a mutating role), a finished run auto-applies through the
   * manual-Accept-equivalent path (checkpoint → conflict re-check via `onAccept`
   * → local audit → applied summary + Undo); any failure falls back to the Ask
   * `DiffReview` gate. Absent → every run shows the Ask gate, byte-for-byte.
   */
  autoAccept?: InAppAutoSeam;
}) {
  const [request, setRequest] = useState(DEMO_SEED_REQUEST);
  // The composer is seeded with a one-off example request so a first-time user
  // can just hit Send. The moment they focus the box to write their OWN prompt,
  // that pristine seed clears out of the way (one-shot — only the untouched seed,
  // never a user edit or an action-button prefill like "Explain the Typst error").
  const demoSeedClearedRef = useRef(false);
  const onComposerFocus = () => {
    if (!demoSeedClearedRef.current && request === DEMO_SEED_REQUEST) {
      demoSeedClearedRef.current = true;
      setRequest("");
    }
  };
  const sx = useAgentSessions(threadId);
  const agent = useAgent();
  const lastNonce = useRef<number | null>(null);
  // 11.8c — refine the pending proposal: the ORIGINAL base of the current refine
  // CHAIN (the doc the FIRST proposal started from). Null when no chain is active
  // (a plain, un-refined proposal). When set, Accept resolves the LATEST proposal
  // against THIS base (a single whole-source block original→final) so a chained
  // Accept LANDS while the live doc is still the original — yet stays conflict-
  // aware (if the user typed during the chain, resolveAccept re-matches and never
  // clobbers). Without it a chained proposal's blocks reference the prior, still
  // un-landed proposal's content and would always conflict.
  const chainBaseRef = useRef<string | null>(null);
  // True while the CURRENT/last run is advice-only (#18.4): suppresses the
  // DiffReview gate. Reset by any normal run (Send or a quick-fix pendingRun).
  const [adviceRun, setAdviceRun] = useState(false);

  // THE CONCURRENT-LATER SEAM: the session a run is bookkept against. Set to the
  // active session at EVERY run start (Send, pendingRun, refine). Run-end effects
  // append the assistant message to THIS session — not whichever is active when
  // the run completes — so a user switching sessions mid-run can't misroute the
  // result. `live` + the DiffReview are gated on this still equalling the active
  // session, so an off-screen run's stream/diff never bleed into another session.
  const runningSessionId = useRef<string | null>(null);

  // The user request that started the CURRENT run — captured at every run start
  // (Send, pendingRun, refine) and read at run-finish for the in-app audit/Undo
  // summary. A ref (not state) so it never triggers a re-render.
  const runRequestRef = useRef<string>("");

  // The in-app Auto applied-summary + Undo, set once a finished run auto-applies
  // (ADR-0025 §4). When set (and still the active session), it REPLACES the Ask
  // DiffReview gate with an "applied + Undo" affordance. Cleared by a fresh run.
  const [appliedSummary, setAppliedSummary] = useState<AppliedSummary | null>(null);
  // True while a finished run's hardened auto-apply is in flight (the async
  // checkpoint → apply). Suppresses the Ask DiffReview gate so it never flashes
  // before the apply lands; cleared on success (the summary takes over) OR on a
  // fallback (the gate is then revealed).
  const [autoApplyPending, setAutoApplyPending] = useState(false);
  // Guards the run-finish auto-apply effect against double-firing for one result
  // (the effect is keyed on `agent.result`, but React may re-run it; the apply is
  // a one-shot per result). Holds the result object already auto-handled.
  const autoHandledResult = useRef<typeof agent.result>(null);

  // Build the conflict-aware accept run for the CURRENT held result — identical
  // to the manual DiffReview Accept path so auto-apply and Accept resolve the
  // SAME blocks the SAME way. A REFINED proposal (a chain is active) resolves the
  // LATEST final source against the chain's ORIGINAL base as one whole-source
  // block; a plain proposal uses the run's own base + blocks. Returns null when
  // there is no held result/base to apply.
  const buildAcceptRun = (): {
    baseSource: string;
    finalSource: string;
    blocks: { search: string; replace: string }[];
  } | null => {
    if (!agent.result || agent.baseSource === null) return null;
    const chainBase = chainBaseRef.current;
    const finalSource = agent.result.finalSource;
    return chainBase !== null
      ? {
          baseSource: chainBase,
          finalSource,
          blocks: [{ search: chainBase, replace: finalSource }],
        }
      : {
          baseSource: agent.baseSource,
          finalSource,
          blocks: agent.result.blocks,
        };
  };

  // ADR-0025 §4 — the hardened in-app auto-apply sequence. Already gated by
  // `decideInAppAuto` (mode Auto + canMutate). Here we enforce the RUNTIME
  // preconditions that decision could not know, FALLING BACK to the Ask gate on
  // any failure (we simply do NOT set the applied summary, so the held result's
  // DiffReview renders as normal):
  //   1. checkpoint (the Undo target) — null ⇒ fall back to Ask;
  //   2. apply via `seam.commit` (H2) — runs INSIDE ProjectApp and RE-READS LIVE
  //      mode / canMutate / the active file text, then the SAME conflict-aware
  //      resolveAccept the manual Accept uses; false ⇒ audit `failed`, fall back to Ask;
  //   3. on success ⇒ audit `applied` (+checkpointVersionId) and show the inline
  //      applied summary + Undo INSTEAD of the Accept/Reject gate.
  const runInAppAuto = async (
    seam: InAppAutoSeam,
    run: { baseSource: string; finalSource: string; blocks: { search: string; replace: string }[] },
    runId: string | null,
    request: string,
    outcome: string,
  ): Promise<void> => {
    const id = runId ?? `run-${Date.now().toString(36)}`;
    let checkpointVersionId: string | null = null;
    try {
      checkpointVersionId = await seam.checkpoint(request);
    } catch {
      checkpointVersionId = null;
    }
    if (checkpointVersionId === null) {
      setAutoApplyPending(false); // no Undo target ⇒ reveal the Ask gate
      return;
    }

    // H2: apply through the hardened seam (NOT the stale `onAccept` closure). The
    // seam re-reads mode / canMutate / the live file text AFTER the checkpoint, so
    // a role drop, a flip to Ask, or a concurrent edit during the checkpoint window
    // is caught here and falls back to the Ask gate.
    let applied = false;
    try {
      applied = seam.commit(run);
    } catch {
      applied = false;
    }
    if (!applied) {
      // Conflict / apply refusal: record the failure and fall back to the Ask gate.
      appendInAppAudit(seam.projectId, {
        runId: id,
        request,
        fileCount: 1,
        at: Date.now(),
        state: "failed",
        checkpointVersionId,
      });
      seam.onAudited?.();
      setAutoApplyPending(false); // reveal the Ask gate
      return;
    }
    // Applied. Audit it (with the Undo target), clear the agent's held result so
    // the DiffReview unmounts, and show the inline applied summary + Undo.
    appendInAppAudit(seam.projectId, {
      runId: id,
      request,
      fileCount: 1,
      at: Date.now(),
      state: "applied",
      checkpointVersionId,
    });
    seam.onAudited?.();
    chainBaseRef.current = null;
    agent.clear();
    setAutoApplyPending(false);
    setAppliedSummary({ runId: id, request, outcome, checkpointVersionId, undone: false });
    pushToast("finished", "Applied automatically");
  };

  // The ONE normal-Send run path (diff + mandatory Accept). It records the user
  // prompt in the active session, pins the run's target session, then starts a
  // fresh NORMAL run via the existing `agent.run` — never advice-only, never
  // auto-applied. Guards mirror Send: an empty request or an in-flight run is a
  // no-op. @-mention contents are attached to the SENT request only; the recorded
  // message stays the user's raw prompt.
  const onSend = () => {
    if (agent.running || !request.trim()) return;
    setAdviceRun(false);
    setAppliedSummary(null); // a fresh run clears any prior auto-applied summary
    chainBaseRef.current = null; // a fresh run starts a new chain (11.8c)
    runRequestRef.current = request;
    sx.appendMessage(sx.activeId, makeMessage({ role: "user", text: request, at: Date.now() }));
    runningSessionId.current = sx.activeId;
    const sent = composeAgentRequest(request, mentionFiles?.() ?? []);
    void agent.run(sent, source, model, buildCheckInput, context, instructions, projectTools);
  };

  // Quick-fix (#11.4b) / explain (#18.4): an action on a diagnostic pushes a
  // scoped request here and starts the run. Edge-detected on `nonce` so it fires
  // once per click, not on every re-render. A quick-fix run yields a normal diff
  // the human still Accepts; an explain run is advice-only — its model is
  // wrapped so propose_edit never reaches the loop (no edits, no diff).
  useEffect(() => {
    if (!pendingRun) return;
    if (lastNonce.current === pendingRun.nonce) return;
    lastNonce.current = pendingRun.nonce;
    setRequest(pendingRun.request);
    const advice = pendingRun.adviceOnly === true;
    setAdviceRun(advice);
    setAppliedSummary(null); // a fresh run clears any prior auto-applied summary
    chainBaseRef.current = null; // a fresh run starts a new chain (11.8c)
    runRequestRef.current = pendingRun.request;
    sx.appendMessage(
      sx.activeId,
      makeMessage({ role: "user", text: pendingRun.request, at: Date.now() }),
    );
    runningSessionId.current = sx.activeId;
    void agent.run(
      pendingRun.request,
      source,
      advice ? adviceOnlyModel(model) : model,
      buildCheckInput,
      context,
      instructions,
      projectTools,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRun?.nonce]);

  // Transient toasts for run finished / stopped / error. Driven by edge-detected
  // state transitions (a new result, a new stopped flag, or a new error string).
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);
  const lastResult = useRef(agent.result);
  const lastStopped = useRef(agent.stopped);
  const lastError = useRef(agent.error);
  // Track outstanding auto-dismiss timers so they can be cleared on unmount (no
  // setState-after-unmount; no leaked timers).
  const toastTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const pushToast = (kind: Toast["kind"], message: string) => {
    const id = ++toastSeq.current;
    setToasts((ts) => [...ts, { id, kind, message }]);
    const timer = setTimeout(() => {
      toastTimers.current.delete(timer);
      setToasts((ts) => ts.filter((t) => t.id !== id));
    }, TOAST_TTL_MS);
    toastTimers.current.add(timer);
  };

  useEffect(() => {
    if (agent.result && agent.result !== lastResult.current) {
      pushToast("finished", `Run finished: ${agent.result.outcome}`);
      // #15: record the completed run as an assistant message in the run's TARGET
      // session (display-only). The streamed assistant text IS the body; the run's
      // outcome + tool-step count annotate it.
      const rows = coalesce(agent.events);
      const text = rows
        .filter((r) => r.kind === "text")
        .map((r) => (r.kind === "text" ? r.text : ""))
        .join("");
      const stepCount = rows.filter((r) => r.kind === "event").length;
      // ADR-0025 §4: the agent run's id (a grouping/correlation hint, never an
      // authenticator) carried from the run events onto this assistant message and
      // the in-app audit entry, so a later Undo can be correlated to the run.
      const runId = runIdFromEvents(agent.events);
      const target = runningSessionId.current;
      if (target) {
        sx.appendMessage(
          target,
          makeMessage({
            role: "assistant",
            text,
            status: "finished",
            outcome: agent.result.outcome,
            stepCount,
            at: Date.now(),
            ...(runId !== null ? { runId } : {}),
          }),
        );
      }
      // ADR-0025 §4 — IN-APP AUTO. On run finish, when the project is in Auto mode
      // and the role can mutate, apply through the manual-Accept-EQUIVALENT path:
      // checkpoint (Undo target) → conflict re-check via `onAccept` → local audit →
      // applied summary + Undo. ANY failure FALLS BACK to the Ask DiffReview gate.
      // Advice-only runs change nothing, so they never auto-apply. Guarded against
      // double-fire per result.
      if (
        autoAccept &&
        !adviceRun &&
        agent.result !== autoHandledResult.current &&
        decideInAppAuto({ mode: autoAccept.mode(), canMutate: autoAccept.canMutate }).autoApply
      ) {
        autoHandledResult.current = agent.result;
        const run = buildAcceptRun();
        const request = runRequestRef.current;
        const outcome = agent.result.outcome;
        if (run) {
          setAutoApplyPending(true); // suppress the Ask gate while the apply is in flight
          void runInAppAuto(autoAccept, run, runId, request, outcome);
        }
      }
    }
    lastResult.current = agent.result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.result]);

  useEffect(() => {
    if (agent.stopped && !lastStopped.current) {
      pushToast("stopped", "Run stopped.");
      const target = runningSessionId.current;
      if (target) {
        sx.appendMessage(
          target,
          makeMessage({
            role: "assistant",
            text: "Stopped by you",
            status: "stopped",
            outcome: "cancelled",
            at: Date.now(),
          }),
        );
      }
    }
    lastStopped.current = agent.stopped;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.stopped]);

  useEffect(() => {
    if (agent.error && agent.error !== lastError.current) {
      pushToast("error", `Error: ${agent.error}`);
      const target = runningSessionId.current;
      if (target) {
        sx.appendMessage(
          target,
          makeMessage({
            role: "assistant",
            text: agent.error,
            status: "error",
            outcome: "error",
            at: Date.now(),
          }),
        );
      }
    }
    lastError.current = agent.error;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.error]);

  // `live` is shown only when the run being driven targets the session the user
  // is currently viewing. Phase 1 runs one agent at a time, so switching away
  // mid-run simply hides its live trace until you switch back; the finished
  // assistant message is still routed to the originating session either way.
  const live =
    runningSessionId.current === sx.activeId
      ? { running: agent.running, events: agent.events }
      : null;

  // The DiffReview is gated the same way as `live`: a held result is only offered
  // for review when it belongs to the active session (and isn't an advice-only
  // run, which changes nothing). The Accept/Reject/Refine handlers are verbatim.
  // ADR-0025 §4: while an in-app auto-apply is in flight (`autoApplyPending`) the
  // Ask gate is suppressed so it never flashes before the apply lands; on a
  // fallback the flag clears and the gate is revealed.
  const diff =
    !autoApplyPending &&
    agent.result &&
    agent.baseSource !== null &&
    !adviceRun &&
    runningSessionId.current === sx.activeId ? (
      <DiffReview
        base={agent.baseSource}
        next={agent.result.finalSource}
        outcome={agent.result.outcome}
        onAccept={() => {
          // Resolve against the run's own base + blocks for a plain proposal, or
          // the chain's ORIGINAL base for a REFINED one — byte-for-byte the shipped
          // path (see buildAcceptRun). resolveAccept stays conflict-aware (a
          // divergent live doc → a conflict notice, never a clobber).
          const run = buildAcceptRun();
          if (!run) return;
          const applied = onAccept(run);
          if (applied) {
            chainBaseRef.current = null;
            agent.clear();
          }
        }}
        onReject={() => {
          chainBaseRef.current = null;
          agent.clear();
        }}
        onRefine={(instruction) => {
          // 11.8c: iterate on the PENDING proposal. The pending proposal's
          // finalSource becomes the new base, so the chained run refines the
          // proposal — not the original document. A refine is a NORMAL edit run
          // (never advice-only) and reuses the SAME model / buildCheckInput /
          // context / instructions so the scratch compiles + checks identically.
          // `agent.run` resets result/events/baseSource, so this DiffReview
          // unmounts and the fresh proposal replaces it when the run completes.
          const args = buildRefineRun(agent.result!.finalSource, instruction);
          if (!args) return; // empty instruction → no-op
          // Pin the chain's ORIGINAL base on the FIRST refine so Accept resolves
          // the net original→final diff (chain-safe & conflict-aware, ADR-0003).
          if (chainBaseRef.current === null) chainBaseRef.current = agent.baseSource;
          setAdviceRun(false);
          setAppliedSummary(null);
          runRequestRef.current = instruction;
          runningSessionId.current = sx.activeId;
          void agent.run(
            args.request,
            args.baseSource,
            model,
            buildCheckInput,
            context,
            instructions,
            projectTools,
          );
        }}
      />
    ) : null;

  // ADR-0025 §4 — the inline applied summary + Undo. Replaces the Accept/Reject
  // gate once a finished run auto-applied: a one-line "applied automatically"
  // notice and an Undo that restores the pre-apply checkpoint (the same restore
  // the version history uses). Only shown for the run's active session; once
  // undone it reads as such (the doc is back at the checkpoint).
  const appliedNode =
    appliedSummary && runningSessionId.current === sx.activeId ? (
      <div className="diff-review agent-auto-applied" data-testid="agent-auto-applied">
        <div className="diff-head">
          <span>
            {appliedSummary.undone
              ? "Reverted the auto-applied change"
              : `Applied automatically (${appliedSummary.outcome})`}
          </span>
          {autoAccept && !appliedSummary.undone && (
            <span className="diff-actions">
              <button
                type="button"
                data-testid="agent-auto-undo"
                title="Restore the document to before this run was applied"
                onClick={() => {
                  autoAccept.restore(appliedSummary.checkpointVersionId);
                  setAppliedSummary((s) => (s ? { ...s, undone: true } : s));
                }}
              >
                Undo
              </button>
            </span>
          )}
        </div>
      </div>
    ) : null;

  return (
    <section className="agent" data-testid="agent-panel">
      <SessionBar
        sessions={sx.sessions}
        active={sx.active}
        onSelect={sx.select}
        onNew={sx.create}
        onRename={sx.rename}
        onDelete={sx.remove}
        instructionsActive={instructionsActive}
        {...(modelPicker ? { modelPicker } : {})}
        {...(onEditInstructions ? { onEditInstructions } : {})}
      />

      <AgentTranscript messages={sx.active.messages} live={live} diff={diff ?? appliedNode} />

      <AgentComposer
        request={request}
        onRequestChange={setRequest}
        onFocus={onComposerFocus}
        onSend={onSend}
        onStop={agent.cancel}
        running={agent.running}
        usage={agent.usage}
        showCost={showCostMeter}
        {...(mentionFiles ? { mentionFiles } : {})}
        {...(tokenBudget !== undefined ? { tokenBudget } : {})}
      />

      {toasts.length > 0 && (
        <div className="galley-toasts" data-testid="agent-toasts" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`galley-toast galley-toast-${t.kind}`}
              data-testid={`agent-toast-${t.kind}`}
            >
              <span>{t.message}</span>
              <button
                type="button"
                className="galley-toast-dismiss"
                aria-label="Dismiss"
                onClick={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
