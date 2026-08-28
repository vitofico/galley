import { describe, it, expect } from "vitest";
import type { AgentEvent, AgentToolName } from "@galley/shared";
import { runAgent } from "./run-agent.js";
import type { AgentCompiler } from "./run-agent.js";
import type { LanguageModelClient, ModelStep } from "./model.js";
import { AGENT_TOOLS, SYSTEM_PROMPT } from "./tools.js";
import { RETRIEVAL_SYSTEM_PROMPT, RETRIEVAL_TOOLS, type ChunkRanker } from "./context-view.js";
import {
  FAKE_CONFIG,
  FakeCompiler,
  FakeModel,
  StreamingFakeModel,
  ThrowingModel,
  compile,
  errorAt,
  finalAnswer,
  proposeEdit,
  readDocument,
} from "./testing/fakes.js";

/** Drain the generator, collecting events and returning the final result. */
async function drive(gen: AsyncGenerator<AgentEvent, any, void>) {
  const events: AgentEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, result: next.value };
}

describe("runAgent — core-loop acceptance (deterministic, offline)", () => {
  it("self-corrects a broken edit to a clean compile and accumulates a diff", async () => {
    const base = "= Title\nSome body text.\n";
    // 1) insert a line that breaks compilation; 2) after seeing the error, fix
    // it; (the loop stops on the clean compile before step 3 is needed).
    const model = new FakeModel([
      proposeEdit(
        [{ search: "Some body text.", replace: "Some body text.\nBROKEN" }],
        "I'll add an important note.",
      ),
      proposeEdit(
        [{ search: "BROKEN", replace: "#strong[Important]" }],
        "Fixing the compile error.",
      ),
      finalAnswer("Done — it compiles cleanly now."),
    ]);
    const compiler = new FakeCompiler((src) =>
      src.includes("BROKEN") ? [errorAt("unexpected token", 3, 1)] : [],
    );

    const { events, result } = await drive(
      runAgent({
        userRequest: "Add an important note.",
        baseSource: base,
        baseRevision: 1,
        model,
        compiler,
        runId: "run-test",
      }),
    );

    // Outcome + final scratch.
    expect(result.outcome).toBe("compiled_clean");
    expect(result.finalSource).toContain("#strong[Important]");
    expect(result.finalSource).not.toContain("BROKEN");
    expect(result.blocks).toHaveLength(2); // both edits accumulated for Accept

    // Event stream tells the self-correction story.
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run_started");
    expect(types.filter((t) => t === "edit_applied")).toHaveLength(2);
    const sawError = events.some(
      (e) => e.type === "diagnostics" && e.diagnostics.some((d) => d.severity === "error"),
    );
    expect(sawError).toBe(true); // it genuinely hit an error before converging
    expect(events.at(-1)).toMatchObject({ type: "run_finished", outcome: "compiled_clean" });

    // Live state is never touched: the loop only ever returned a scratch result.
    expect(base).toBe("= Title\nSome body text.\n");
  });

  it("feeds compiler diagnostics back to the model on the next turn", async () => {
    const model = new FakeModel([
      proposeEdit([{ search: "x", replace: "BROKEN" }]),
      proposeEdit([{ search: "BROKEN", replace: "y" }]),
    ]);
    const compiler = new FakeCompiler((src) =>
      src.includes("BROKEN") ? [errorAt("boom", 1, 1)] : [],
    );
    await drive(
      runAgent({ userRequest: "fix", baseSource: "x", baseRevision: 1, model, compiler }),
    );
    // The 2nd turn's conversation must contain the error text as a tool result.
    const secondTurn = model.seen[1]!;
    const toolMsg = secondTurn.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("error");
    expect(toolMsg?.content).toContain("boom");
  });
});

describe("runAgent — outcomes", () => {
  it("returns no_edits when the model answers without editing", async () => {
    const model = new FakeModel([finalAnswer("Your document has 2 sections.")]);
    const { events, result } = await drive(
      runAgent({
        userRequest: "How many sections?",
        baseSource: "= A\n= B\n",
        baseRevision: 1,
        model,
        compiler: new FakeCompiler(),
      }),
    );
    expect(result.outcome).toBe("no_edits");
    expect(result.blocks).toHaveLength(0);
    expect(events.some((e) => e.type === "assistant_text")).toBe(true);
  });

  it("stops at max_iters_reached when it cannot reach a clean compile", async () => {
    const model = new FakeModel([
      proposeEdit([{ search: "start", replace: "start BAD" }]),
      proposeEdit([{ search: "BAD", replace: "BAD2" }]),
      proposeEdit([{ search: "BAD2", replace: "BAD3" }]),
    ]);
    const compiler = new FakeCompiler((src) =>
      src.includes("BAD") ? [errorAt("still broken")] : [],
    );
    const { events, result } = await drive(
      runAgent({
        userRequest: "fix it",
        baseSource: "start",
        baseRevision: 1,
        model,
        compiler,
        maxIters: 2,
      }),
    );
    expect(result.outcome).toBe("max_iters_reached");
    const iterations = events.filter((e) => e.type === "iteration");
    expect(iterations).toHaveLength(2);
    expect(iterations.at(-1)).toMatchObject({ index: 2, max: 2 });
  });

  it("classifies a voluntary stop with unresolved errors as max_iters_reached", async () => {
    // The model edits once (still broken) then gives up before the cap. The
    // outcome enum's catch-all for "stopped, still with errors" is intentional
    // (see run-agent.ts terminal-classification comment).
    const model = new FakeModel([
      proposeEdit([{ search: "x", replace: "BROKEN" }]),
      finalAnswer("I can't fix this."),
    ]);
    const compiler = new FakeCompiler((src) =>
      src.includes("BROKEN") ? [errorAt("nope")] : [],
    );
    const { events, result } = await drive(
      runAgent({ userRequest: "fix", baseSource: "x", baseRevision: 1, model, compiler }),
    );
    expect(result.outcome).toBe("max_iters_reached");
    expect(events.filter((e) => e.type === "iteration")).toHaveLength(1); // only 1 attempt, < cap
  });

  it("converges when a multi-call turn includes a clean propose_edit", async () => {
    // One model turn issues two tool calls; the first compiles clean. The loop
    // processes the whole batch, then stops as compiled_clean.
    const model = new FakeModel([
      {
        text: "",
        toolCalls: [
          { id: "a", name: "propose_edit", args: { edits: [{ search: "old", replace: "new" }] } },
          { id: "b", name: "read_document", args: {} },
        ],
      },
    ]);
    const { events, result } = await drive(
      runAgent({
        userRequest: "go",
        baseSource: "old text",
        baseRevision: 1,
        model,
        compiler: new FakeCompiler(),
      }),
    );
    expect(result.outcome).toBe("compiled_clean");
    expect(result.finalSource).toBe("new text");
    const calls = events.filter((e) => e.type === "tool_call").map((e) => (e as any).tool);
    expect(calls).toEqual(["propose_edit", "read_document"]);
  });

  it("bails out at max_iters_reached when propose_edit keeps failing to apply", async () => {
    // A model stuck proposing edits whose search text never matches. These
    // failures never advance compileIters (no apply, no compile), so without a
    // consecutive-failure bound only the coarse maxTurns ceiling would stop it.
    // With maxIters: 3 the loop must bail after 3 consecutive failures.
    const model = new FakeModel([
      proposeEdit([{ search: "nope-1", replace: "a" }]),
      proposeEdit([{ search: "nope-2", replace: "b" }]),
      proposeEdit([{ search: "nope-3", replace: "c" }]),
      // These would keep going forever if the bound did not fire first.
      proposeEdit([{ search: "nope-4", replace: "d" }]),
      proposeEdit([{ search: "nope-5", replace: "e" }]),
      finalAnswer("should never be reached"),
    ]);
    const { events, result } = await drive(
      runAgent({
        userRequest: "edit",
        baseSource: "hello world",
        baseRevision: 1,
        model,
        compiler: new FakeCompiler(),
        maxIters: 3,
      }),
    );
    expect(result.outcome).toBe("max_iters_reached");
    expect(result.blocks).toHaveLength(0); // nothing ever applied
    expect(result.finalSource).toBe("hello world"); // scratch untouched
    // Exactly the 3 failing turns ran before the bound fired — the 4th scripted
    // step was never requested.
    expect(events.filter((e) => e.type === "edit_failed")).toHaveLength(3);
    expect(model.seen).toHaveLength(3);
    expect(events.some((e) => e.type === "iteration")).toBe(false); // no successful compile
    expect(events.at(-1)).toMatchObject({ type: "run_finished", outcome: "max_iters_reached" });
  });

  it("resets the consecutive-failure budget once an edit lands (failures interleaved with successes)", async () => {
    // Two failures, then a success (resets the counter), then two more failures.
    // The success between them keeps consecutive failures below the cap, so the
    // run must continue to the final answer rather than bailing early.
    const model = new FakeModel([
      proposeEdit([{ search: "miss-1", replace: "a" }]),
      proposeEdit([{ search: "miss-2", replace: "b" }]),
      proposeEdit([{ search: "hello", replace: "HELLO" }]), // lands → resets
      proposeEdit([{ search: "miss-3", replace: "c" }]),
      proposeEdit([{ search: "miss-4", replace: "d" }]),
      finalAnswer("done despite the misses"),
    ]);
    // BROKEN-free source so the successful edit compiles clean but does NOT
    // converge the loop on its own (we want the run to reach the final answer).
    const compiler = new FakeCompiler((src) =>
      src.includes("HELLO") ? [errorAt("still working", 1, 1)] : [],
    );
    const { events, result } = await drive(
      runAgent({
        userRequest: "edit",
        baseSource: "hello world",
        baseRevision: 1,
        model,
        compiler,
        maxIters: 3,
      }),
    );
    // It reached the model's final answer (no early bail): the one successful
    // edit accumulated and the counter never hit the cap.
    expect(result.blocks).toHaveLength(1);
    expect(result.finalSource).toBe("HELLO world");
    expect(events.filter((e) => e.type === "edit_failed")).toHaveLength(4);
    expect(model.seen).toHaveLength(6); // all six scripted steps consumed
  });

  it("reports an edit_failed event and lets the model retry", async () => {
    const model = new FakeModel([
      proposeEdit([{ search: "does-not-exist", replace: "z" }]),
      proposeEdit([{ search: "hello", replace: "hi" }]),
      finalAnswer("done"),
    ]);
    const { events, result } = await drive(
      runAgent({
        userRequest: "edit",
        baseSource: "hello world",
        baseRevision: 1,
        model,
        compiler: new FakeCompiler(),
      }),
    );
    expect(events.some((e) => e.type === "edit_failed")).toBe(true);
    expect(result.outcome).toBe("compiled_clean");
    expect(result.finalSource).toBe("hi world");
    expect(result.blocks).toHaveLength(1); // only the successful edit accumulated
  });
});

describe("runAgent — read_document tool", () => {
  it("returns the scratch with line numbers to the model", async () => {
    const model = new FakeModel([readDocument(), finalAnswer("It has two lines.")]);
    await drive(
      runAgent({
        userRequest: "read it",
        baseSource: "line one\nline two",
        baseRevision: 1,
        model,
        compiler: new FakeCompiler(),
      }),
    );
    const toolMsg = model.seen[1]!.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("1| line one");
    expect(toolMsg?.content).toContain("2| line two");
  });

  it("exposes the explicit compile tool with diagnostics", async () => {
    const model = new FakeModel([compile(), finalAnswer("looks clean")]);
    const { events } = await drive(
      runAgent({
        userRequest: "compile please",
        baseSource: "= ok",
        baseRevision: 1,
        model,
        compiler: new FakeCompiler(),
      }),
    );
    expect(events.some((e) => e.type === "diagnostics")).toBe(true);
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
  });
});

describe("runAgent — cancellation & errors", () => {
  it("finishes as cancelled when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = new FakeModel([proposeEdit([{ search: "a", replace: "b" }])]);
    const { events, result } = await drive(
      runAgent({
        userRequest: "edit",
        baseSource: "a",
        baseRevision: 1,
        model,
        compiler: new FakeCompiler(),
        signal: controller.signal,
      }),
    );
    expect(result.outcome).toBe("cancelled");
    expect(result.blocks).toHaveLength(0); // never ran a tool
    expect(events.at(-1)).toMatchObject({ type: "run_finished", outcome: "cancelled" });
  });

  it("treats an abort during an in-flight model call as cancelled, not error", async () => {
    // Aborting mid-flight makes the model call throw; cancellation intent wins
    // over the incidental error (run-agent.ts "Abort wins" comment).
    const controller = new AbortController();
    const model: LanguageModelClient = {
      config: FAKE_CONFIG,
      async probe() {
        return { reachable: true, supportsStreaming: true, supportsToolCalls: true, supportsImageInput: true };
      },
      async step() {
        controller.abort();
        throw new Error("fetch aborted");
      },
    };
    const { events, result } = await drive(
      runAgent({
        userRequest: "edit",
        baseSource: "a",
        baseRevision: 1,
        model,
        compiler: new FakeCompiler(),
        signal: controller.signal,
      }),
    );
    expect(result.outcome).toBe("cancelled");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("re-checks the abort BETWEEN tool calls in a batch (L1-C3)", async () => {
    // One model step with TWO tool calls. The first (compile) aborts mid-batch;
    // the second (propose_edit) must NOT run — the loop re-checks the signal
    // between calls, so no wasted compile / post-abort edit and a clean cancel.
    const controller = new AbortController();
    const step: ModelStep = {
      text: "",
      toolCalls: [
        { id: "c1", name: "compile" as AgentToolName, args: {} },
        { id: "c2", name: "propose_edit" as AgentToolName, args: { edits: [{ search: "a", replace: "ZZZ" }] } },
      ],
    };
    const model = new FakeModel([step]);
    const compiler = {
      check: async () => {
        controller.abort(); // the Stop lands while the first call is in flight
        return { ok: true, diagnostics: [], pageCount: 1, durationMs: 0 };
      },
    };
    const { events, result } = await drive(
      runAgent({ userRequest: "edit", baseSource: "a", baseRevision: 1, model, compiler, signal: controller.signal }),
    );
    expect(result.outcome).toBe("cancelled");
    expect(result.blocks).toHaveLength(0); // the propose_edit second call never applied
    expect(events.some((e) => e.type === "edit_applied")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "run_finished", outcome: "cancelled" });
  });

  it("an abort during the LAST call's converging compile yields cancelled, not compiled_clean (L1-C3)", async () => {
    // The edit applies and its compile would converge (ok), but the Stop landed
    // during that compile — the post-loop abort check must report cancelled rather
    // than letting the converged batch finish as compiled_clean.
    const controller = new AbortController();
    const model = new FakeModel([proposeEdit([{ search: "a", replace: "b" }])]);
    const compiler = {
      check: async () => {
        controller.abort();
        return { ok: true, diagnostics: [], pageCount: 1, durationMs: 0 };
      },
    };
    const { events, result } = await drive(
      runAgent({ userRequest: "edit", baseSource: "a", baseRevision: 1, model, compiler, signal: controller.signal }),
    );
    expect(result.outcome).toBe("cancelled");
    expect(events.some((e) => e.type === "run_finished" && e.outcome === "compiled_clean")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "run_finished", outcome: "cancelled" });
  });

  it("rejects an unknown tool name with an error tool-result and does NOT parse it as edits", async () => {
    // A hallucinated tool name must NOT be silently routed into propose_edit /
    // parseEdits; it should surface to the model as a tool-result error so it can
    // correct, without crashing the loop or producing any edit.
    const unknownCall: ModelStep = {
      text: "",
      toolCalls: [{ id: "tc-x", name: "frobnicate" as AgentToolName, args: { foo: 1 } }],
    };
    const model = new FakeModel([unknownCall, finalAnswer("Understood, no such tool.")]);
    const { events, result } = await drive(
      runAgent({
        userRequest: "do something",
        baseSource: "= Hi\n",
        baseRevision: 1,
        model,
        compiler: new FakeCompiler(),
      }),
    );
    // No edits applied, no edit_applied event, base untouched.
    expect(result.blocks).toHaveLength(0);
    expect(events.some((e) => e.type === "edit_applied")).toBe(false);
    expect(result.finalSource).toBe("= Hi\n");
    // The model saw an "unknown tool" error tool-result on its next turn.
    const turn2 = model.seen[1]!;
    const toolMsg = turn2.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("Unknown tool");
    expect(toolMsg?.content).toContain("frobnicate");
    // The run finished cleanly (no crash); no edits → no_edits outcome.
    expect(result.outcome).toBe("no_edits");
  });

  it("finishes as error and emits an error event when the model throws", async () => {
    const { events, result } = await drive(
      runAgent({
        userRequest: "edit",
        baseSource: "a",
        baseRevision: 1,
        model: new ThrowingModel("network down"),
        compiler: new FakeCompiler(),
      }),
    );
    expect(result.outcome).toBe("error");
    expect(events.some((e) => e.type === "error" && e.message.includes("network down"))).toBe(true);
  });

  it("finishes as error when a tool/seam rejects mid-run (no unhandled rejection)", async () => {
    // A compile tool run whose seam REJECTS must be caught by the loop's tool
    // dispatch and surfaced as one clean error terminal — not escape runAgent as
    // an unhandled rejection, which would break the terminal-event contract.
    const model = new FakeModel([compile(), finalAnswer("unreached")]);
    const compiler: AgentCompiler = {
      check: async () => {
        throw new Error("compiler exploded");
      },
    };
    const { events, result } = await drive(
      runAgent({ userRequest: "compile", baseSource: "a", baseRevision: 1, model, compiler }),
    );
    expect(result.outcome).toBe("error");
    // The final two events are the error then the terminal run_finished.
    expect(events.at(-2)).toMatchObject({ type: "error", message: "compiler exploded" });
    expect(events.at(-1)).toMatchObject({ type: "run_finished", outcome: "error" });
  });

  it("treats an abort during a throwing tool run as cancelled, not error", async () => {
    // The seam rejects, but the run was already aborted — cancellation intent
    // wins over the incidental error, same idiom as the model-call catch.
    const controller = new AbortController();
    const model = new FakeModel([compile(), finalAnswer("unreached")]);
    const compiler: AgentCompiler = {
      check: async () => {
        controller.abort();
        throw new Error("compiler exploded");
      },
    };
    const { events, result } = await drive(
      runAgent({
        userRequest: "compile",
        baseSource: "a",
        baseRevision: 1,
        model,
        compiler,
        signal: controller.signal,
      }),
    );
    expect(result.outcome).toBe("cancelled");
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "run_finished", outcome: "cancelled" });
  });
});

describe("runAgent — token-level streaming (roadmap #11.8)", () => {
  it("emits incremental assistant_text chunks when the client streams", async () => {
    // One read turn (streamed text), then a clean edit, then a final answer.
    const model = new StreamingFakeModel([
      readDocument("Let me look at the document."),
      proposeEdit([{ search: "old", replace: "new" }], "Renaming it now."),
      finalAnswer("All done here."),
    ]);
    const { events, result } = await drive(
      runAgent({
        userRequest: "rename",
        baseSource: "old text",
        baseRevision: 1,
        model,
        compiler: new FakeCompiler(),
      }),
    );

    // The clean edit converges immediately (compiled_clean), before the final
    // answer turn — same as the core-loop acceptance test.
    expect(result.outcome).toBe("compiled_clean");
    const chunks = events.filter((e) => e.type === "assistant_text") as {
      type: "assistant_text";
      text: string;
    }[];
    // The first turn's text alone ("Let me look at the document.") is 6 words →
    // multiple chunks, so we get strictly MORE assistant_text events than the 2
    // turns that carried text.
    expect(chunks.length).toBeGreaterThan(2);
    // Reassembling the chunks reconstructs the full per-turn texts — i.e. the
    // deltas are incremental pieces, not the whole text repeated.
    const joined = chunks.map((c) => c.text).join("");
    expect(joined).toContain("Let me look at the document.");
    expect(joined).toContain("Renaming it now.");
  });

  it("keeps the existing assistant_text invariant for a streaming run", async () => {
    const model = new StreamingFakeModel([finalAnswer("Two sections.")]);
    const { events } = await drive(
      runAgent({
        userRequest: "how many?",
        baseSource: "= A\n= B\n",
        baseRevision: 1,
        model,
        compiler: new FakeCompiler(),
      }),
    );
    expect(events.some((e) => e.type === "assistant_text")).toBe(true);
  });

  it("falls back to a single chunk when a streaming turn yields no deltas but returns text", async () => {
    // A stepStream that never yields deltas (e.g. a provider that only settles at
    // the end) must still surface the final text once — no double, no drop.
    const model: LanguageModelClient = {
      config: FAKE_CONFIG,
      async probe() {
        return { reachable: true, supportsStreaming: true, supportsToolCalls: true, supportsImageInput: true };
      },
      async step() {
        return finalAnswer("settled-only text");
      },
      async *stepStream() {
        return finalAnswer("settled-only text");
      },
    };
    const { events } = await drive(
      runAgent({ userRequest: "q", baseSource: "x", baseRevision: 1, model, compiler: new FakeCompiler() }),
    );
    const texts = events.filter((e) => e.type === "assistant_text") as { text: string }[];
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toBe("settled-only text");
  });

  it("produces the same outcome+diff as the non-streaming client for the same script", async () => {
    const script = (): ModelStep[] => [
      proposeEdit([{ search: "world", replace: "Typst" }], "Renaming."),
      finalAnswer("Done."),
    ];
    const base = "Hello world.\n";
    const nonStreaming = await drive(
      runAgent({ userRequest: "rename", baseSource: base, baseRevision: 1, model: new FakeModel(script()), compiler: new FakeCompiler() }),
    );
    const streaming = await drive(
      runAgent({ userRequest: "rename", baseSource: base, baseRevision: 1, model: new StreamingFakeModel(script()), compiler: new FakeCompiler() }),
    );
    expect(streaming.result.outcome).toBe(nonStreaming.result.outcome);
    expect(streaming.result.finalSource).toBe(nonStreaming.result.finalSource);
    expect(streaming.result.blocks).toEqual(nonStreaming.result.blocks);
    // Non-text event sequence is identical (streaming only adds finer text granularity).
    const nonText = (es: AgentEvent[]) => es.filter((e) => e.type !== "assistant_text").map((e) => e.type);
    expect(nonText(streaming.events)).toEqual(nonText(nonStreaming.events));
  });

  it("treats a mid-stream abort as cancelled, not error", async () => {
    const controller = new AbortController();
    const model: LanguageModelClient = {
      config: FAKE_CONFIG,
      async probe() {
        return { reachable: true, supportsStreaming: true, supportsToolCalls: true, supportsImageInput: true };
      },
      async step() {
        return finalAnswer("unused");
      },
      async *stepStream() {
        yield { type: "text-delta", text: "thinking" };
        controller.abort();
        throw new Error("stream aborted");
      },
    };
    const { events, result } = await drive(
      runAgent({ userRequest: "go", baseSource: "x", baseRevision: 1, model, compiler: new FakeCompiler(), signal: controller.signal }),
    );
    expect(result.outcome).toBe("cancelled");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("a stepStream that aborts then RETURNS a propose_edit step runs no tool work and ends cancelled", async () => {
    // The dangerous case: streaming observes the abort, breaks, and returns a
    // final ModelStep with a tool call NORMALLY (no throw — what demo-model does).
    // Without the post-step abort guard, the loop would push the assistant
    // message, apply the edit, compile, and wrongly converge to compiled_clean.
    const controller = new AbortController();
    const compiler = new FakeCompiler();
    const model: LanguageModelClient = {
      config: FAKE_CONFIG,
      async probe() {
        return { reachable: true, supportsStreaming: true, supportsToolCalls: true, supportsImageInput: true };
      },
      async step() {
        return finalAnswer("unused");
      },
      // eslint-disable-next-line require-yield
      async *stepStream(): AsyncGenerator<{ type: "text-delta"; text: string }, ModelStep, void> {
        // User pressed Stop while "streaming"; we break and return a tool step.
        controller.abort();
        return proposeEdit([{ search: "old", replace: "new" }], "I'll edit it.");
      },
    };

    const { events, result } = await drive(
      runAgent({
        userRequest: "edit",
        baseSource: "old text",
        baseRevision: 1,
        model,
        compiler,
        signal: controller.signal,
      }),
    );

    // Correct terminal outcome — NOT compiled_clean.
    expect(result.outcome).toBe("cancelled");
    expect(result.blocks).toHaveLength(0);
    expect(result.finalSource).toBe("old text"); // scratch untouched

    // No post-abort tool side effects leaked into the trace.
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
    expect(events.some((e) => e.type === "edit_applied")).toBe(false);
    expect(events.some((e) => e.type === "diagnostics")).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(compiler.callCount).toBe(0); // compile never ran after Stop
    expect(events.at(-1)).toMatchObject({ type: "run_finished", outcome: "cancelled" });
  });

  it("an abort observed right as the (non-streaming) step resolves prevents tool execution", async () => {
    // Belt-and-braces for the shared guard: a non-streaming model that aborts the
    // signal inside step() before returning a tool call. The guard (not the
    // throw path) catches this, since step() returns normally here.
    const controller = new AbortController();
    const compiler = new FakeCompiler();
    const model: LanguageModelClient = {
      config: FAKE_CONFIG,
      async probe() {
        return { reachable: true, supportsStreaming: true, supportsToolCalls: true, supportsImageInput: true };
      },
      async step() {
        controller.abort();
        return proposeEdit([{ search: "old", replace: "new" }]);
      },
    };
    const { events, result } = await drive(
      runAgent({
        userRequest: "edit",
        baseSource: "old text",
        baseRevision: 1,
        model,
        compiler,
        signal: controller.signal,
      }),
    );
    expect(result.outcome).toBe("cancelled");
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
    expect(compiler.callCount).toBe(0);
  });
});

describe("runAgent — context economics (roadmap #9 slice 3a)", () => {
  // A multi-section doc whose sections have distinct vocabulary so BM25 can
  // discriminate; "umbrellas" lives in the Conclusion section.
  const BIG_DOC = [
    "= Introduction",
    "This document introduces apples and oranges as a friendly opening line.",
    "",
    "= Methods",
    "We measured banana ripeness over several days using a calibrated sensor.",
    "",
    "= Results",
    "The penguins migrated south as the winter season set in across the ice.",
    "",
    "= Conclusion",
    "Final remarks concerning umbrellas, raincoats, and the persistent drizzle.",
    "",
  ].join("\n");

  it("leaves the default/small-doc model inputs byte-for-byte unchanged", async () => {
    // Same scripted steps drive both runs, so tool-call ids + tool results match;
    // the only variable is the `context` option (inactive on this small doc).
    const sharedSteps: ModelStep[] = [
      readDocument("Looking at the document."),
      proposeEdit([{ search: "world", replace: "Typst" }], "Renaming."),
      finalAnswer("Done."),
    ];
    const base = "Hello world.\n";

    const baseline = new FakeModel(sharedSteps);
    await drive(
      runAgent({
        userRequest: "rename world to Typst",
        baseSource: base,
        baseRevision: 1,
        model: baseline,
        compiler: new FakeCompiler(),
      }),
    );

    const withOption = new FakeModel(sharedSteps);
    await drive(
      runAgent({
        userRequest: "rename world to Typst",
        baseSource: base,
        baseRevision: 1,
        model: withOption,
        compiler: new FakeCompiler(),
        // Retrieval requested, but this doc is far below the threshold → inactive.
        context: { mode: "retrieval" },
      }),
    );

    // The full model inputs (system + tools + messages) are identical…
    expect(withOption.seen).toEqual(baseline.seen);
    // …and use the very same prompt/tool references (the unchanged base path).
    expect(baseline.seen.length).toBeGreaterThan(0);
    for (const turn of [...baseline.seen, ...withOption.seen]) {
      expect(turn.system).toBe(SYSTEM_PROMPT);
      expect(turn.tools).toBe(AGENT_TOOLS);
    }
  });

  it("activates on a large doc: read_document returns a selected excerpt; edits still hit the full scratch", async () => {
    const model = new FakeModel([
      readDocument("Scanning the relevant sections."),
      // "umbrellas" is in the Conclusion — omitted from the Methods-focused excerpt,
      // yet the search/replace still applies because edits run on the full scratch.
      proposeEdit([{ search: "umbrellas", replace: "parasols" }], "Word choice."),
      finalAnswer("Done."),
    ]);

    const { result } = await drive(
      runAgent({
        userRequest: "tune the banana ripeness methods",
        baseSource: BIG_DOC,
        baseRevision: 1,
        model,
        compiler: new FakeCompiler(),
        // Low threshold forces activation on this modest fixture; tight budget forces omission.
        context: { mode: "retrieval", thresholdChars: 50, maxChars: 90 },
      }),
    );

    // Active run advertises the retrieval prompt + tools.
    expect(model.seen[0]!.system).toBe(RETRIEVAL_SYSTEM_PROMPT);
    expect(model.seen[0]!.tools).toBe(RETRIEVAL_TOOLS);

    // The read_document result is a true-line-numbered, omitted-marked excerpt
    // focused on the Methods section — not the whole document.
    const readMsg = model.seen
      .at(-1)!
      .messages.find((m) => m.role === "tool" && m.toolName === "read_document");
    expect(readMsg?.content).toContain("4| = Methods");
    expect(readMsg?.content).toContain("banana ripeness");
    expect(readMsg?.content).toMatch(/… omitted lines \d+–\d+ …/);
    expect(readMsg?.content).not.toContain("penguins migrated");
    expect(readMsg?.content).not.toContain("umbrellas");

    // The edit to omitted text still landed (edits operate on the full scratch).
    expect(result.outcome).toBe("compiled_clean");
    expect(result.finalSource).toContain("parasols");
    expect(result.finalSource).not.toContain("umbrellas");
  });

  it("threads an injected ranker (slice 3c) into the selected read", async () => {
    // A ranker that ignores the query and forces the Results (penguins) section.
    const penguinsFirst: ChunkRanker = (chunks) =>
      chunks
        .map((chunk) => ({ chunk, score: chunk.text.includes("penguins") ? 100 : 0 }))
        .sort((a, b) => b.score - a.score || a.chunk.start - b.chunk.start);

    const model = new FakeModel([readDocument("Reading."), finalAnswer("Done.")]);
    await drive(
      runAgent({
        userRequest: "tune the banana ripeness methods", // BM25 would pick Methods…
        baseSource: BIG_DOC,
        baseRevision: 1,
        model,
        compiler: new FakeCompiler(),
        context: { mode: "retrieval", thresholdChars: 50, maxChars: 90, ranker: penguinsFirst },
      }),
    );

    const readMsg = model.seen
      .at(-1)!
      .messages.find((m) => m.role === "tool" && m.toolName === "read_document");
    // …but the injected ranker put the penguins section in the excerpt instead.
    expect(readMsg?.content).toContain("penguins");
    expect(readMsg?.content).not.toContain("banana ripeness");
  });
});
