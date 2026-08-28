import { describe, it, expect } from "vitest";
import type { AgentEvent } from "@galley/shared";
import {
  checkConstraints,
  countWords,
  formatConstraintViolationsForModel,
  hasConstraints,
  parseInstructions,
  type DocumentConstraints,
} from "./instructions.js";
import { runAgent, type RunAgentOptions } from "./run-agent.js";
import { SYSTEM_PROMPT } from "./tools.js";
import {
  FakeCompiler,
  FakeModel,
  compile,
  finalAnswer,
  proposeEdit,
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

// ---------------------------------------------------------------------------
// parseInstructions
// ---------------------------------------------------------------------------

describe("parseInstructions", () => {
  it("keeps a file with no Constraints section as pure steering, verbatim", () => {
    const text = "Write in a dry, precise voice.\nPrefer SI units.\nCite as [Author Year].";
    const parsed = parseInstructions(text);
    expect(parsed.steering).toBe(text);
    expect(parsed.constraints).toBeUndefined();
    expect(parsed.warnings).toEqual([]);
  });

  it("parses the full happy path: steering + every supported key, repeatables, quotes", () => {
    const parsed = parseInstructions(
      [
        "Target venue: Annalen der Physik.",
        "Voice: terse, third person.",
        "",
        "## Constraints",
        "max-words: 800",
        "min-words: 200",
        'required-section: "Introduction"',
        "required-section: Conclusion",
        'forbidden-word: "utilize"',
        "forbidden-word: leverage",
      ].join("\n"),
    );
    expect(parsed.steering).toBe("Target venue: Annalen der Physik.\nVoice: terse, third person.");
    expect(parsed.constraints).toEqual({
      maxWords: 800,
      minWords: 200,
      requiredSections: ["Introduction", "Conclusion"],
      forbiddenWords: ["utilize", "leverage"],
    });
    expect(parsed.warnings).toEqual([]);
  });

  it("matches the Constraints heading case-insensitively at any markdown level", () => {
    const parsed = parseInstructions("### CONSTRAINTS\nmax-words: 10");
    expect(parsed.constraints?.maxWords).toBe(10);
  });

  it("ends the constraints block at the next markdown heading (rest is steering)", () => {
    const parsed = parseInstructions(
      ["Intro prose.", "## Constraints", "max-words: 50", "## Notes", "More steering here."].join(
        "\n",
      ),
    );
    expect(parsed.constraints?.maxWords).toBe(50);
    expect(parsed.steering).toContain("Intro prose.");
    expect(parsed.steering).toContain("## Notes");
    expect(parsed.steering).toContain("More steering here.");
    expect(parsed.steering).not.toContain("max-words");
  });

  it("warns on unknown keys (forward-compat) without dropping known ones", () => {
    const parsed = parseInstructions(
      ["## Constraints", "tone: cheerful", "max-words: 100"].join("\n"),
    );
    expect(parsed.constraints?.maxWords).toBe(100);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]!.line).toBe(2);
    expect(parsed.warnings[0]!.message).toContain("tone");
  });

  it("warns on malformed values and skips them, never throwing", () => {
    const parsed = parseInstructions(
      [
        "## Constraints",
        "max-words: many",
        "min-words: -3",
        'required-section: ""',
        "just some stray prose line",
        "forbidden-word: ok",
      ].join("\n"),
    );
    expect(parsed.constraints?.maxWords).toBeUndefined();
    expect(parsed.constraints?.minWords).toBeUndefined();
    expect(parsed.constraints?.requiredSections).toEqual([]);
    expect(parsed.constraints?.forbiddenWords).toEqual(["ok"]);
    expect(parsed.warnings).toHaveLength(4);
    expect(parsed.warnings.map((w) => w.line)).toEqual([2, 3, 4, 5]);
  });

  it("handles garbage input without throwing (structured outcome)", () => {
    for (const garbage of ["", "   \n\n", "## Constraints", "## Constraints\n\n\n", ":::"]) {
      const parsed = parseInstructions(garbage);
      expect(parsed.steering).toBeTypeOf("string");
      expect(Array.isArray(parsed.warnings)).toBe(true);
    }
  });
});

describe("hasConstraints", () => {
  it("is false for undefined or an all-empty constraints object", () => {
    expect(hasConstraints(undefined)).toBe(false);
    expect(hasConstraints({ requiredSections: [], forbiddenWords: [] })).toBe(false);
  });
  it("is true when any deterministic constraint is set", () => {
    expect(hasConstraints({ maxWords: 1, requiredSections: [], forbiddenWords: [] })).toBe(true);
    expect(
      hasConstraints({ requiredSections: ["Intro"], forbiddenWords: [] }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// countWords — pinned approximation over Typst markup
// ---------------------------------------------------------------------------

describe("countWords (Typst-aware approximation, pinned)", () => {
  it("counts plain prose words", () => {
    expect(countWords("Hello brave new world.")).toBe(4);
  });

  it("counts heading text but not the = markers", () => {
    expect(countWords("= Introduction\nBody text here.")).toBe(4);
  });

  it("ignores line comments, block comments, and raw blocks", () => {
    const src = [
      "Real words // not these ones",
      "/* nor these */ more words",
      "```",
      "raw code excluded",
      "```",
      "and `inline raw` tail",
    ].join("\n");
    // Real, words, more, words, and, tail
    expect(countWords(src)).toBe(6);
  });

  it("does not treat URLs as comments", () => {
    expect(countWords("see https://example.com today")).toBe(3);
  });

  it("drops whole #set/#import/#show/#let/#include directive lines", () => {
    const src = ['#set page(width: 10cm)', '#import "lib.typ": thing', "Actual prose."].join("\n");
    expect(countWords(src)).toBe(2);
  });

  it("drops #func(...) call syntax but keeps [content] prose", () => {
    expect(countWords("#strong[Important] note for #emph[everyone] here")).toBe(5);
  });

  it("ignores labels and @citations", () => {
    expect(countWords("= Methods <sec:methods>\nAs shown by @einstein1905 twice.")).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// checkConstraints — each constraint kind
// ---------------------------------------------------------------------------

const NO_CONSTRAINTS: DocumentConstraints = { requiredSections: [], forbiddenWords: [] };

describe("checkConstraints", () => {
  it("returns no violations for an empty constraints object", () => {
    expect(checkConstraints("anything at all", NO_CONSTRAINTS)).toEqual([]);
  });

  it("flags max-words with honest counts", () => {
    const v = checkConstraints("one two three four five", { ...NO_CONSTRAINTS, maxWords: 3 });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: "max-words", limit: 3, actual: 5 });
    expect(v[0]!.message).toContain("5");
    expect(v[0]!.message).toContain("3");
  });

  it("flags min-words", () => {
    const v = checkConstraints("just two", { ...NO_CONSTRAINTS, minWords: 10 });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: "min-words", limit: 10, actual: 2 });
  });

  it("passes word caps when within bounds", () => {
    const v = checkConstraints("one two three", { ...NO_CONSTRAINTS, minWords: 2, maxWords: 4 });
    expect(v).toEqual([]);
  });

  it("flags a missing required section; matches headings case-insensitively", () => {
    const src = "= introduction <intro>\nText.\n== Details\n";
    const ok = checkConstraints(src, { ...NO_CONSTRAINTS, requiredSections: ["Introduction"] });
    expect(ok).toEqual([]);
    const bad = checkConstraints(src, { ...NO_CONSTRAINTS, requiredSections: ["Conclusion"] });
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ kind: "missing-section", section: "Conclusion" });
  });

  it("flags forbidden words case-insensitively, whole-word only, with counts", () => {
    const src = "We Utilize tools. To utilize is human. But utilizes does not match.";
    const v = checkConstraints(src, { ...NO_CONSTRAINTS, forbiddenWords: ["utilize"] });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: "forbidden-word", word: "utilize", count: 2 });
  });

  it("does not flag forbidden words inside code fences or comments", () => {
    const src = "Clean prose.\n```\nutilize\n```\n// utilize in a comment\n";
    expect(checkConstraints(src, { ...NO_CONSTRAINTS, forbiddenWords: ["utilize"] })).toEqual([]);
  });

  it("reports multiple violations in declared order", () => {
    const v = checkConstraints("we utilize and leverage things", {
      maxWords: 2,
      requiredSections: ["Intro"],
      forbiddenWords: ["utilize", "leverage"],
    });
    expect(v.map((x) => x.kind)).toEqual([
      "max-words",
      "missing-section",
      "forbidden-word",
      "forbidden-word",
    ]);
  });
});

describe("formatConstraintViolationsForModel", () => {
  it("renders a structured failure signal naming each violation", () => {
    const violations = checkConstraints("we utilize stuff", {
      ...NO_CONSTRAINTS,
      forbiddenWords: ["utilize"],
    });
    const text = formatConstraintViolationsForModel(violations);
    expect(text).toContain("constraint");
    expect(text).toContain("utilize");
  });
});

// ---------------------------------------------------------------------------
// runAgent integration — instructions option (default OFF)
// ---------------------------------------------------------------------------

function runOpts(overrides: Partial<RunAgentOptions> & Pick<RunAgentOptions, "model">) {
  return {
    userRequest: "Edit the document.",
    baseSource: "= Title\nWe utilize tools.\n",
    baseRevision: 1,
    compiler: new FakeCompiler(),
    runId: "run-instr",
    ...overrides,
  } satisfies RunAgentOptions;
}

describe("runAgent — instructions steering", () => {
  it("injects steering into the system preamble, clearly delimited", async () => {
    const model = new FakeModel([finalAnswer("ok")]);
    await drive(
      runAgent(
        runOpts({ model, instructions: { steering: "Write tersely. Cite as [Author Year]." } }),
      ),
    );
    const system = model.seen[0]!.system;
    expect(system).toContain(SYSTEM_PROMPT);
    expect(system).toContain("Project instructions");
    expect(system).toContain("Write tersely. Cite as [Author Year].");
  });

  it("leaves the system prompt byte-for-byte unchanged without the option", async () => {
    const model = new FakeModel([finalAnswer("ok")]);
    await drive(runAgent(runOpts({ model })));
    expect(model.seen[0]!.system).toBe(SYSTEM_PROMPT);
  });

  it("an empty/inert instructions object changes nothing (events identical)", async () => {
    const script = () => [
      proposeEdit([{ search: "tools", replace: "instruments" }], "Editing."),
      finalAnswer("done"),
    ];
    const bare = new FakeModel(script());
    const inert = new FakeModel(script());
    const a = await drive(runAgent(runOpts({ model: bare })));
    const b = await drive(
      runAgent(
        runOpts({
          model: inert,
          instructions: { constraints: { requiredSections: [], forbiddenWords: [] } },
        }),
      ),
    );
    expect(JSON.stringify(b.events)).toBe(JSON.stringify(a.events));
    expect(b.result.outcome).toBe(a.result.outcome);
    expect(inert.seen[0]!.system).toBe(SYSTEM_PROMPT);
  });
});

describe("runAgent — deterministic constraints in iterate-until-clean", () => {
  const constraints: DocumentConstraints = {
    requiredSections: [],
    forbiddenWords: ["utilize"],
  };

  it("treats a clean compile with violations as not converged, then converges on the fix", async () => {
    const model = new FakeModel([
      // Edit 1 compiles clean but keeps the forbidden word -> loop must continue.
      proposeEdit([{ search: "tools", replace: "many tools" }], "Expanding."),
      // Edit 2 removes the forbidden word -> clean + zero violations = success.
      proposeEdit([{ search: "utilize", replace: "use" }], "Fixing wording."),
      finalAnswer("never reached"),
    ]);
    const { events, result } = await drive(
      runAgent(runOpts({ model, instructions: { constraints } })),
    );

    expect(result.outcome).toBe("compiled_clean");
    expect(result.finalSource).toContain("use many tools");

    // The violation was fed back to the model as a structured failure signal.
    // (`seen` holds the live shared messages array, so look at the FIRST tool
    // result — the response to edit 1, which compiled clean but violated.)
    const toolMsg = model.seen.at(-1)!.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("constraint");
    expect(toolMsg?.content).toContain("forbidden");
    expect(toolMsg?.content).toContain("utilize");

    // Constraint outcomes surface on the event stream (as constraint diagnostics).
    expect(
      events.some(
        (e) =>
          e.type === "diagnostics" &&
          e.diagnostics.some((d) => d.severity === "error" && d.message.includes("constraint")),
      ),
    ).toBe(true);
    expect(events.filter((e) => e.type === "iteration")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "run_finished", outcome: "compiled_clean" });
  });

  it("stops honestly at max_iters_reached when violations never converge", async () => {
    const model = new FakeModel([
      proposeEdit([{ search: "tools", replace: "tools A" }]),
      proposeEdit([{ search: "tools A", replace: "tools B" }]),
      proposeEdit([{ search: "tools B", replace: "tools C" }]),
      finalAnswer("unreached"),
    ]);
    const { events, result } = await drive(
      runAgent(runOpts({ model, maxIters: 2, instructions: { constraints } })),
    );
    expect(result.outcome).toBe("max_iters_reached");
    expect(result.check?.ok).toBe(true); // compile WAS clean; constraints were not
    expect(events.at(-1)).toMatchObject({ type: "run_finished", outcome: "max_iters_reached" });
  });

  it("classifies a voluntary stop with outstanding violations as max_iters_reached", async () => {
    const model = new FakeModel([
      proposeEdit([{ search: "tools", replace: "fine tools" }]),
      finalAnswer("I think this is good."),
    ]);
    const { result } = await drive(runAgent(runOpts({ model, instructions: { constraints } })));
    expect(result.outcome).toBe("max_iters_reached");
  });

  it("reports violations on the explicit compile tool too", async () => {
    const model = new FakeModel([compile("Checking."), finalAnswer("answer")]);
    const { result } = await drive(runAgent(runOpts({ model, instructions: { constraints } })));
    const toolMsg = model.seen.at(-1)!.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("forbidden");
    expect(result.outcome).toBe("no_edits"); // no edits proposed: existing classification
  });

  it("compile errors win: constraints are not reported while the compile is broken", async () => {
    const model = new FakeModel([
      proposeEdit([{ search: "tools", replace: "tools BROKEN" }]),
      proposeEdit([{ search: " BROKEN", replace: "" }]),
      proposeEdit([{ search: "utilize", replace: "use" }]),
      finalAnswer("unreached"),
    ]);
    const compiler = new FakeCompiler((src) =>
      src.includes("BROKEN")
        ? [{ severity: "error" as const, message: "unexpected token" }]
        : [],
    );
    const { result } = await drive(
      runAgent(runOpts({ model, compiler, instructions: { constraints } })),
    );
    // The FIRST tool result (edit 1's feedback) is the compile error alone —
    // no constraint text while the compile is broken.
    const toolMsg = model.seen.at(-1)!.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("unexpected token");
    expect(toolMsg?.content).not.toContain("forbidden");
    expect(result.outcome).toBe("compiled_clean");
  });
});
