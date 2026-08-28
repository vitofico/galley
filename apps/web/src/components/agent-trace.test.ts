import { describe as suite, it, expect } from "vitest";
import type { AgentEvent } from "@galley/shared";
import {
  coalesce,
  describe,
  describeArgs,
  stepRole,
  isStepRow,
  loadShowSteps,
  saveShowSteps,
  TRACE_STEPS_KEY,
  type TraceStorage,
} from "./agent-trace.js";

/**
 * Pure-core tests for the deep-agent-pane trace helpers (#15). The render lives
 * in AgentPanel.tsx (jsx, browser), but the ORDERING / COALESCING / role-classing
 * decisions are pure functions over the existing `AgentEvent` stream — tested
 * here in the `node` env (no jsdom), the repo's test layer.
 */

const txt = (text: string): AgentEvent => ({ type: "assistant_text", text });
const call = (tool: string, args: unknown = {}): AgentEvent => ({
  type: "tool_call",
  tool: tool as never,
  args,
});
const result = (tool: string, summary: string): AgentEvent => ({
  type: "tool_result",
  tool: tool as never,
  summary,
});
const iter = (index: number, max: number): AgentEvent => ({ type: "iteration", index, max });
const diagErr = (): AgentEvent => ({
  type: "diagnostics",
  diagnostics: [{ severity: "error", message: "boom" } as never],
});
const diagClean = (): AgentEvent => ({ type: "diagnostics", diagnostics: [] });

suite("coalesce — interleaves text and steps chronologically", () => {
  it("merges only CONSECUTIVE text chunks into one growing row", () => {
    const rows = coalesce([txt("Let "), txt("me "), txt("read.")]);
    expect(rows).toEqual([{ kind: "text", text: "Let me read." }]);
  });

  it("keeps step rows BETWEEN text turns in arrival order (no pooling)", () => {
    // A real turn: preamble text → tool call → tool result → follow-up text.
    const rows = coalesce([
      txt("Let me "),
      txt("read."),
      call("read_document"),
      result("read_document", "1 page"),
      txt("Now I'll "),
      txt("edit."),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["text", "event", "event", "text"]);
    // The two text turns stay SEPARATE (a step flushed the first run), proving
    // text does not all pool to the top.
    expect(rows[0]).toEqual({ kind: "text", text: "Let me read." });
    expect(rows[3]).toEqual({ kind: "text", text: "Now I'll edit." });
    expect(rows[1]).toMatchObject({ kind: "event" });
    expect(rows[2]).toMatchObject({ kind: "event" });
  });

  it("preserves the exact event order across many interleavings", () => {
    const events = [call("a"), txt("x"), iter(1, 6), txt("y"), result("a", "ok")];
    const rows = coalesce(events);
    expect(rows.map((r) => r.kind)).toEqual(["event", "text", "event", "text", "event"]);
  });

  it("returns no rows for an empty stream", () => {
    expect(coalesce([])).toEqual([]);
  });
});

suite("isStepRow", () => {
  it("classifies events as steps and text as non-steps", () => {
    const rows = coalesce([txt("hi"), call("read_document")]);
    expect(rows.filter(isStepRow).map((r) => r.kind)).toEqual(["event"]);
  });
});

suite("stepRole — coarse visual buckets", () => {
  it("buckets tool call / result / lifecycle / error / diagnostics", () => {
    expect(stepRole({ type: "tool_call", tool: "read_document" as never, args: {} })).toBe(
      "tool_call",
    );
    expect(stepRole({ type: "tool_result", tool: "x" as never, summary: "s" })).toBe("tool_result");
    expect(stepRole({ type: "iteration", index: 1, max: 6 })).toBe("lifecycle");
    expect(stepRole({ type: "error", message: "no" })).toBe("error");
    expect(stepRole({ type: "edit_failed", failures: [{} as never] })).toBe("error");
  });

  it("a clean compile is lifecycle; an erroring compile is the diagnostics role", () => {
    expect(stepRole(diagClean() as never)).toBe("lifecycle");
    expect(stepRole(diagErr() as never)).toBe("diagnostics");
  });
});

suite("describe — one-line step summaries (unchanged contract)", () => {
  it("renders each step type", () => {
    expect(describe({ type: "run_started", runId: "r", baseRevision: 0 })).toBe("▶ run started");
    // Empty args render NO args fragment — the tool_call line is byte-for-byte
    // the same as before (the panel renders zero step args when there are none).
    expect(describe({ type: "tool_call", tool: "read_document" as never, args: {} })).toBe(
      "🔧 read_document",
    );
    expect(describe({ type: "tool_result", tool: "x" as never, summary: "1 page" })).toBe("↳ 1 page");
    expect(describe({ type: "iteration", index: 2, max: 6 })).toBe("↻ iteration 2/6");
    expect(describe(diagErr() as never)).toBe("⚠ 1 error(s)");
    expect(describe(diagClean() as never)).toBe("✓ compiled clean");
    expect(describe({ type: "error", message: "boom" })).toBe("error: boom");
  });

  it("appends a compact args rendering to a tool_call line", () => {
    expect(
      describe({ type: "tool_call", tool: "read_file" as never, args: { path: "/main.typ" } }),
    ).toBe('🔧 read_file {"path":"/main.typ"}');
  });
});

suite("describeArgs — compact, safe args rendering", () => {
  it("renders a normal object compactly and readably", () => {
    expect(describeArgs({ path: "/main.typ" })).toBe('{"path":"/main.typ"}');
    expect(describeArgs({ query: "einstein", limit: 5 })).toBe('{"query":"einstein","limit":5}');
  });

  it("renders scalars and arrays sensibly", () => {
    expect(describeArgs("hello")).toBe('"hello"');
    expect(describeArgs(42)).toBe("42");
    expect(describeArgs(true)).toBe("true");
    expect(describeArgs([1, 2, 3])).toBe("[1,2,3]");
  });

  it("returns an empty string for empty / absent args (no fragment to show)", () => {
    expect(describeArgs({})).toBe("");
    expect(describeArgs(undefined)).toBe("");
    expect(describeArgs(null)).toBe("");
  });

  it("truncates a huge arg to the cap with an ellipsis", () => {
    const huge = { blob: "x".repeat(5000) };
    const out = describeArgs(huge);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith("…")).toBe(true);
  });

  it("caps a long scalar too", () => {
    const out = describeArgs("y".repeat(5000));
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith("…")).toBe(true);
  });

  it("strips control characters (no raw newlines / control bytes leak into the row)", () => {
    // Build the arg with BOTH raw control bytes (NUL/ESC/newline/tab) and the
    // textual escapes JSON.stringify emits, to prove neither leaks into the row.
    const ctrl = "line1" + String.fromCharCode(10) + "line2" + String.fromCharCode(9)
      + "end" + String.fromCharCode(0) + String.fromCharCode(27);
    const out = describeArgs({ note: ctrl });
    expect(out).not.toMatch(/[\x00-\x1f]/);
    expect(out).toContain("line1 line2 end");
  });

  it("fails soft on circular references (never throws)", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => describeArgs(circular)).not.toThrow();
    expect(describeArgs(circular)).toBe("…");
  });

  it("fails soft on non-serializable values (bigint) without throwing", () => {
    expect(() => describeArgs({ n: 10n })).not.toThrow();
    expect(describeArgs({ n: 10n })).toBe("…");
  });

  it("renders a function/symbol arg as a safe fallback, never throwing", () => {
    expect(() => describeArgs(() => 1)).not.toThrow();
    // JSON.stringify(fn) === undefined → no serializable payload → empty.
    expect(describeArgs(() => 1)).toBe("");
  });
});

// A tiny in-memory storage stand-in (mirrors the focus-mode test approach).
function memStorage(seed: Record<string, string> = {}): TraceStorage {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

suite("show-steps persistence — galley.* pattern, default SHOWN", () => {
  it("defaults to true when unset or storage missing", () => {
    expect(loadShowSteps(memStorage())).toBe(true);
    expect(loadShowSteps(null)).toBe(true);
  });

  it("round-trips the choice via the galley.agentTraceSteps key", () => {
    const s = memStorage();
    saveShowSteps(false, s);
    expect(s.getItem(TRACE_STEPS_KEY)).toBe("0");
    expect(loadShowSteps(s)).toBe(false);
    saveShowSteps(true, s);
    expect(loadShowSteps(s)).toBe(true);
  });

  it("only an explicit '0' hides steps; garbage reads as shown", () => {
    expect(loadShowSteps(memStorage({ [TRACE_STEPS_KEY]: "nonsense" }))).toBe(true);
    expect(loadShowSteps(memStorage({ [TRACE_STEPS_KEY]: "0" }))).toBe(false);
  });

  it("swallows storage failures (best-effort persistence)", () => {
    const throwing: TraceStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadShowSteps(throwing)).toBe(true);
    expect(() => saveShowSteps(false, throwing)).not.toThrow();
  });
});
