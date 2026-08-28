import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent } from "@galley/shared";
import {
  coalesce,
  describe,
  describeArgs,
  stepRole,
  loadShowSteps,
  saveShowSteps,
} from "./agent-trace.js";
import type { SessionMessage } from "./agent-sessions.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AgentTranscriptProps {
  messages: SessionMessage[];
  live: { running: boolean; events: AgentEvent[] } | null;
  diff: React.ReactNode | null;
}

// ---------------------------------------------------------------------------
// Status glyph helpers
// ---------------------------------------------------------------------------

function statusGlyph(status: SessionMessage["status"]): string {
  switch (status) {
    case "finished":
      return "✓";
    case "stopped":
      return "■";
    case "error":
      return "⚠";
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AgentTranscript({ messages, live, diff }: AgentTranscriptProps): JSX.Element {
  // Collapsed by default — the monolith's loadShowSteps() defaults to SHOWN
  // (returns true when unset), but this component defaults COLLAPSED. We only
  // restore a prior explicit choice when the stored value is "0" (the explicit
  // "hidden" sentinel). Any other stored value (including "1" or unset) leaves
  // us collapsed, matching the task's "default collapsed" requirement.
  const [showSteps, setShowSteps] = useState<boolean>(() => {
    // loadShowSteps() returns true when unset (default SHOWN in the monolith).
    // We want the OPPOSITE default here: start collapsed unless the user has
    // explicitly hidden steps (stored "0"), in which case we keep it hidden.
    // But since we default collapsed, a stored "1" (explicit SHOWN) should
    // restore shown. Read the raw localStorage to distinguish the cases.
    try {
      const raw =
        typeof globalThis !== "undefined" &&
        (globalThis as { localStorage?: { getItem(k: string): string | null } }).localStorage
          ? (
              globalThis as { localStorage: { getItem(k: string): string | null } }
            ).localStorage.getItem("galley.agentTraceSteps")
          : null;
      if (raw === "1") return true;
      // "0", null (unset), or anything else → collapsed
      return false;
    } catch {
      return false;
    }
  });

  const toggleSteps = () => {
    const next = !showSteps;
    setShowSteps(next);
    saveShowSteps(next);
  };

  // Derive live trace rows and step count
  // Coalesce once per change to the live event array, not on every parent
  // re-render (composer keystrokes, toast timers) — matches the monolith's memo.
  const liveEvents = live?.events;
  const rows = useMemo(() => (liveEvents ? coalesce(liveEvents) : []), [liveEvents]);
  const stepCount = rows.filter((r) => r.kind === "event").length;

  // Keep the latest turn / streaming text / diff-review in view — the standard
  // chat behavior. Guarded by `pinned`: if the user scrolls up to read history,
  // we stop auto-scrolling so we never yank them back down; returning near the
  // bottom re-pins. Runs after every render (cheap) so streaming stays pinned.
  const scrollRef = useRef<HTMLElement>(null);
  const pinnedRef = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <section
      ref={scrollRef}
      onScroll={onScroll}
      className="agent-transcript"
      data-testid="agent-transcript"
    >
      {/* ------------------------------------------------------------------ */}
      {/* Conversation history (completed turns)                              */}
      {/* ------------------------------------------------------------------ */}
      {messages.map((msg) => {
        if (msg.role === "user") {
          return (
            <div key={msg.id} className="agent-turn agent-turn-user">
              {msg.text}
            </div>
          );
        }
        // assistant turn
        const glyph = statusGlyph(msg.status);
        return (
          <div key={msg.id} className="agent-turn agent-turn-assistant">
            {glyph && <span className="agent-turn-status">{glyph}</span>}
            {msg.text}
            {!!msg.stepCount && (
              <span className="agent-turn-steps">{msg.stepCount} steps</span>
            )}
          </div>
        );
      })}

      {/* ------------------------------------------------------------------ */}
      {/* Live trace (active session only)                                    */}
      {/* ------------------------------------------------------------------ */}
      {live !== null && rows.length > 0 && (
        <>
          {/* Steps disclosure toggle — only shown when ≥1 step row exists */}
          {stepCount > 0 && (
            <button
              type="button"
              className="agent-steps-toggle"
              data-testid="agent-steps-toggle"
              aria-expanded={showSteps ? "true" : "false"}
              onClick={toggleSteps}
            >
              {showSteps ? "▾" : "▸"} {showSteps ? "Hide" : "Show"} steps ({stepCount})
            </button>
          )}

          <ul
            className="agent-trace"
            data-testid="agent-trace"
            data-steps={showSteps ? "shown" : "hidden"}
          >
            {/* Live pulse — visible while the run is in-flight */}
            {live.running && (
              <li className="agent-trace-live" data-testid="agent-live" aria-hidden="true">
                <span className="agent-live-dot" />
                Live
              </li>
            )}

            {rows.map((row, i) => {
              if (row.kind === "text") {
                return (
                  <li key={i} className="trace trace-assistant_text">
                    {/* The last text row is the LIVE streaming block while running. */}
                    <span
                      className="galley-stream"
                      data-testid="agent-stream"
                      data-streaming={
                        live.running && i === rows.length - 1 ? "true" : "false"
                      }
                    >
                      {row.text}
                    </span>
                  </li>
                );
              }

              // A STEP row — hidden when steps are collapsed.
              if (!showSteps) return null;

              const role = stepRole(row.event);
              // The in-flight step: while running, the LAST row overall is the
              // step the agent is currently executing (no later text/step yet).
              const inFlight = live.running && i === rows.length - 1;
              const summary =
                row.event.type === "tool_result" ? row.event.summary : describe(row.event);
              const toolArgs =
                row.event.type === "tool_call" ? describeArgs(row.event.args) : "";

              return (
                <li
                  key={i}
                  className={`trace trace-step trace-${row.event.type} trace-role-${role}${
                    inFlight ? " trace-inflight" : ""
                  }`}
                  data-role={role}
                  data-inflight={inFlight ? "true" : "false"}
                >
                  <span className="trace-step-line" title={summary}>
                    {row.event.type === "tool_call" ? (
                      <>
                        🔧 {row.event.tool}
                        {toolArgs && (
                          <span className="trace-step-args" data-testid="agent-trace-args">
                            {" "}
                            {toolArgs}
                          </span>
                        )}
                      </>
                    ) : (
                      describe(row.event)
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Diff review (passed by parent)                                      */}
      {/* ------------------------------------------------------------------ */}
      {diff}
    </section>
  );
}
